import {
  type PullRequestCapability,
  type PullRequestDetail,
  type PullRequestReviewDraftSubmission,
  type PullRequestReviewSubmissionEvent,
} from "@mcode/contracts";
import { AlertCircle, GitBranch, MessageSquareText } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import {
  selectPullRequestMutationLane,
  selectPullRequestOutcomeUnknownLane,
} from "@/features/pull-requests/state/pull-request-mutation-selectors";
import { getPullRequestDetailKey } from "@/features/pull-requests/state/pullRequestDetailStore";
import { usePullRequestMutationStore } from "@/features/pull-requests/state/pullRequestMutationStore";
import {
  getPullRequestReviewDraftSnapshotKey,
  usePullRequestReviewDraftStore,
  type PullRequestDraftSnapshot,
  type PullRequestReviewDraft,
} from "@/features/pull-requests/state/pullRequestReviewDraftStore";
import type { PullRequestMutationTransport } from "@/transport/pull-request-mutations";
import type { PullRequestTransport } from "@/transport/pull-requests";
import {
  PullRequestMutationError,
  pullRequestCapabilityReason,
  pullRequestMutationExpected,
} from "./PullRequestMutationError";

/** Props for the snapshot-qualified review submission confirmation. */
export interface PullRequestSubmitReviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  detail: PullRequestDetail;
  draftIdentityKey: string;
  threadIndexComplete: boolean;
  capability: PullRequestCapability | null | undefined;
  mutationTransport?: PullRequestMutationTransport;
  readTransport?: PullRequestTransport;
  onRefresh: () => Promise<boolean> | boolean;
}

function eventLabel(event: PullRequestReviewSubmissionEvent): string {
  if (event === "approve") return "Approve";
  if (event === "request_changes") return "Request changes";
  return "Comment";
}

function submitLabel(event: PullRequestReviewSubmissionEvent): string {
  if (event === "approve") return "Submit approval";
  if (event === "request_changes") return "Submit change request";
  return "Submit review comment";
}

function toSubmission(draft: PullRequestReviewDraft): PullRequestReviewDraftSubmission | null {
  if (!draft.body.trim()) return null;
  if (draft.kind === "reply") {
    return draft.threadProviderNodeId
      ? {
          kind: "reply",
          localId: draft.localId,
          body: draft.body,
          threadProviderNodeId: draft.threadProviderNodeId,
        }
      : null;
  }
  const coordinate = draft.coordinate;
  if (!coordinate) return null;
  if (coordinate.subjectType === "file") {
    return {
      kind: "inline",
      localId: draft.localId,
      body: draft.body,
      path: draft.path,
      coordinate: { subjectType: "file" },
    };
  }
  if (!coordinate.line || !coordinate.side) return null;
  const hasRange = coordinate.startLine !== null && coordinate.startSide !== null;
  return {
    kind: "inline",
    localId: draft.localId,
    body: draft.body,
    path: draft.path,
    coordinate: {
      subjectType: "line",
      line: coordinate.line,
      side: coordinate.side,
      ...(hasRange
        ? { startLine: coordinate.startLine!, startSide: coordinate.startSide! }
        : {}),
    },
  };
}

/** Confirm and submit one review plus accepted session-local inline drafts. */
export function PullRequestSubmitReviewDialog({
  open,
  onOpenChange,
  detail,
  draftIdentityKey,
  threadIndexComplete,
  capability,
  mutationTransport,
  readTransport,
  onRefresh,
}: PullRequestSubmitReviewDialogProps) {
  const mutationIdentityKey = getPullRequestDetailKey(detail.identity);
  const snapshot = useMemo<PullRequestDraftSnapshot>(
    () => ({
      identityKey: draftIdentityKey,
      baseOid: detail.base.oid ?? "",
      headOid: detail.head.oid ?? "",
    }),
    [detail.base.oid, detail.head.oid, draftIdentityKey],
  );
  const snapshotKey = getPullRequestReviewDraftSnapshotKey(snapshot);
  const laneSelector = useMemo(
    () => selectPullRequestMutationLane(detail.identity, "review"),
    [mutationIdentityKey],
  );
  const lane = usePullRequestMutationStore(laneSelector);
  const unknownSelector = useMemo(
    () => selectPullRequestOutcomeUnknownLane(detail.identity),
    [mutationIdentityKey],
  );
  const outcomeUnknownLane = usePullRequestMutationStore(unknownSelector);
  const displayedError = outcomeUnknownLane?.error ?? lane.error;
  const draftRevision = usePullRequestReviewDraftStore(
    (state) => state.placementRevision,
  );
  const draftContentRevision = usePullRequestReviewDraftStore(
    (state) => state.contentRevision,
  );
  const reviewDraftState = useMemo(() => {
    const state = usePullRequestReviewDraftStore.getState();
    return {
      drafts: state.order.flatMap((localId) => {
        const draft = state.drafts[localId];
        return draft?.identityKey === draftIdentityKey ? [draft] : [];
      }),
      summary: state.summaryDrafts[draftIdentityKey] ?? null,
    };
  }, [draftContentRevision, draftIdentityKey, draftRevision]);
  const [localError, setLocalError] = useState<string | null>(null);
  const expected = pullRequestMutationExpected(detail);
  const summary = reviewDraftState.summary;
  const event = summary?.event ?? "comment";
  const body = summary?.body ?? "";
  const currentDrafts = reviewDraftState.drafts.filter(
    (draft) => draft.snapshotKey === snapshotKey,
  );
  const submissions = currentDrafts.flatMap((draft) => {
    const submission = toSubmission(draft);
    return submission ? [submission] : [];
  });
  const invalidDraftCount = currentDrafts.length - submissions.length;
  const outdatedCount = reviewDraftState.drafts.filter((draft) => draft.outdated).length;
  const replyCount = currentDrafts.filter((draft) => draft.kind === "reply").length;
  const capabilityReason = pullRequestCapabilityReason(capability);
  const submitting = lane.status === "submitting";
  const mutationBlocked = submitting || lane.status === "error" || Boolean(outcomeUnknownLane);
  const unavailableReason =
    capabilityReason ??
    (expected ? null : "Base or head commit identity is unavailable.") ??
    (summary?.outdated ? "The overall review targets an older change stack." : null) ??
    (outdatedCount > 0 ? `${outdatedCount} review drafts target an older change stack.` : null) ??
    (invalidDraftCount > 0 ? `${invalidDraftCount} review drafts are empty or no longer map to a line.` : null) ??
    (replyCount > 0 && !threadIndexComplete
      ? "Review threads are incomplete. Refresh them before submitting a reply."
      : null) ??
    (event === "comment" && !body.trim() && submissions.length === 0
      ? "A comment review needs an overall body or at least one inline draft."
      : null);
  const repository = `${detail.identity.owner}/${detail.identity.repository}`;

  useEffect(() => {
    if (!open) return;
    setLocalError(null);
    usePullRequestMutationStore.getState().clearLane(detail.identity, "review");
  }, [mutationIdentityKey, open]);

  const updateSummary = (
    nextEvent: PullRequestReviewSubmissionEvent,
    nextBody: string,
  ): void => {
    if (summary?.outdated) return;
    const result = usePullRequestReviewDraftStore.getState().setSummaryDraft(snapshot, {
      event: nextEvent,
      body: nextBody,
    });
    setLocalError(result.ok ? null : "Review body exceeds the session draft limit.");
  };

  const startFresh = (): void => {
    if (summary) {
      usePullRequestReviewDraftStore.getState().clearSummaryDraft(summary.snapshotKey);
    }
    const result = usePullRequestReviewDraftStore.getState().setSummaryDraft(snapshot, {
      event: "comment",
      body: "",
    });
    setLocalError(result.ok ? null : "Review body exceeds the session draft limit.");
  };

  const close = (nextOpen: boolean): void => {
    if (submitting) return;
    onOpenChange(nextOpen);
  };

  const submit = async (): Promise<void> => {
    if (mutationBlocked || unavailableReason || localError || !expected) return;
    const result = await usePullRequestMutationStore.getState().submitReview(
      {
        identity: detail.identity,
        expected,
        event,
        ...(body ? { body } : {}),
        drafts: submissions,
      },
      snapshotKey,
      { mutationTransport, readTransport },
    );
    if (result.ok) onOpenChange(false);
  };

  const retry = async (): Promise<void> => {
    const result = await usePullRequestMutationStore.getState().retry(
      detail.identity,
      "review",
      { mutationTransport, readTransport },
    );
    if (result?.ok) onOpenChange(false);
  };

  const refresh = async (): Promise<void> => {
    const store = usePullRequestMutationStore.getState();
    if (outcomeUnknownLane) {
      const acknowledged = await store.acknowledgeOutcomeUnknownAfterRefresh(
        detail.identity,
        onRefresh,
      );
      if (acknowledged) onOpenChange(false);
      return;
    }
    if (await onRefresh()) store.clearLane(detail.identity, "review");
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        showCloseButton={!submitting}
        className="max-h-[90vh] w-[min(94vw,600px)] gap-0 overflow-hidden p-0 sm:max-w-[600px]"
        aria-busy={submitting || undefined}
      >
        <header className="flex items-start gap-3 bg-page px-5 py-4 pr-12">
          <MessageSquareText size={18} aria-hidden className="mt-0.5 shrink-0 text-primary/85" />
          <div className="min-w-0">
            <DialogTitle className="text-sm">Submit review</DialogTitle>
            <DialogDescription className="mt-1 text-xs leading-5">
              Submit an explicit review and its session drafts to GitHub.
            </DialogDescription>
          </div>
        </header>

        <ScrollArea className="min-h-0 max-h-[65vh]">
          <div className="space-y-4 px-5 py-4">
            <div className="bg-page/65 px-4 py-3">
              <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
                Remote effect
              </p>
              <p className="mt-2 text-sm font-medium text-foreground/90">
                {repository} #{detail.identity.number}
              </p>
              <p className="mt-2 flex min-w-0 items-center gap-2 font-mono text-xs text-muted-foreground">
                <GitBranch size={13} aria-hidden />
                <span className="truncate">{detail.base.name}</span>
                <span aria-hidden className="opacity-45">←</span>
                <span className="truncate text-foreground/85">{detail.head.name}</span>
                {detail.head.oid ? (
                  <span className="ml-auto shrink-0 tabular-nums">{detail.head.oid.slice(0, 8)}</span>
                ) : null}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                {currentDrafts.length} review {currentDrafts.length === 1 ? "draft" : "drafts"}
              </p>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="pull-request-review-event" className="text-xs text-muted-foreground">
                Review outcome
              </label>
              <Select
                value={event}
                onValueChange={(value) => updateSummary(value as PullRequestReviewSubmissionEvent, body)}
                disabled={mutationBlocked || summary?.outdated}
              >
                <SelectTrigger id="pull-request-review-event" className="w-full">
                  <SelectValue>{eventLabel(event)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="comment">Comment</SelectItem>
                  <SelectItem value="approve">Approve</SelectItem>
                  <SelectItem value="request_changes">Request changes</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="pull-request-review-body" className="text-xs text-muted-foreground">
                Overall review, optional
              </label>
              <Textarea
                id="pull-request-review-body"
                value={body}
                rows={5}
                disabled={mutationBlocked || summary?.outdated}
                className="resize-y rounded-none"
                onChange={(change) => updateSummary(event, change.target.value)}
                onKeyDown={(keyEvent) => {
                  if (keyEvent.key !== "Enter" || !(keyEvent.metaKey || keyEvent.ctrlKey)) return;
                  keyEvent.preventDefault();
                  void submit();
                }}
              />
            </div>

            {summary?.outdated ? (
              <div className="flex items-center gap-2 bg-primary/8 px-3 py-2.5 text-xs text-muted-foreground">
                <AlertCircle size={13} aria-hidden className="shrink-0 text-primary/80" />
                <span className="min-w-0 flex-1">The overall review targets an older snapshot.</span>
                <Button type="button" variant="ghost" size="xs" disabled={mutationBlocked} onClick={startFresh}>
                  Start fresh
                </Button>
              </div>
            ) : null}
            {unavailableReason && !summary?.outdated ? (
              <p role="status" className="flex items-start gap-2 bg-primary/8 px-3 py-2.5 text-xs text-muted-foreground">
                <AlertCircle size={13} aria-hidden className="mt-0.5 shrink-0 text-primary/80" />
                {unavailableReason}
              </p>
            ) : null}
            {localError ? <p role="alert" className="text-xs text-destructive">{localError}</p> : null}
            {displayedError ? (
              <PullRequestMutationError
                error={displayedError}
                busy={submitting}
                onRetry={() => void retry()}
                onRefresh={() => void refresh()}
              />
            ) : null}
          </div>
        </ScrollArea>

        <DialogFooter className="m-0 flex-row justify-end rounded-none bg-page/65 px-5 py-3.5">
          <Button type="button" variant="ghost" disabled={submitting} onClick={() => close(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={mutationBlocked || Boolean(unavailableReason) || Boolean(localError)}
            onClick={() => void submit()}
          >
            {submitting ? (
              <>
                <Spinner size="xs" aria-hidden />
                Submitting review
              </>
            ) : (
              submitLabel(event)
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
