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
export function PullRequestSubmitReviewDialog(props: PullRequestSubmitReviewDialogProps) {
  const review = useReviewSubmission(props);
  return <ReviewSubmissionDialog review={review} />;
}

function useReviewSubmission({
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
  const snapshot = useReviewSnapshot(detail, draftIdentityKey);
  const snapshotKey = getPullRequestReviewDraftSnapshotKey(snapshot);
  const lane = usePullRequestMutationLane(detail);
  const outcomeUnknownLane = usePullRequestOutcomeUnknownLane(detail);
  const displayedError = outcomeUnknownLane?.error ?? lane.error;
  const reviewDraftState = useReviewDraftState(draftIdentityKey);
  const reviewDrafts = deriveReviewDrafts(reviewDraftState, snapshotKey);
  const [localError, setLocalError] = useState<string | null>(null);
  const expected = pullRequestMutationExpected(detail);
  const summary = reviewDraftState.summary;
  const event = summary?.event ?? "comment";
  const body = summary?.body ?? "";
  const submitting = lane.status === "submitting";
  const mutationBlocked = submitting || lane.status === "error" || Boolean(outcomeUnknownLane);
  const unavailableReason = getUnavailableReviewReason({
    capability,
    expected,
    summaryOutdated: Boolean(summary?.outdated),
    outdatedCount: reviewDrafts.outdatedCount,
    invalidDraftCount: reviewDrafts.invalidDraftCount,
    replyCount: reviewDrafts.replyCount,
    threadIndexComplete,
    event,
    body,
    submissions: reviewDrafts.submissions,
  });

  useEffect(() => {
    if (!open) return;
    // oxlint-disable-next-line react/set-state-in-effect -- Opening the review dialog clears errors from the prior mutation attempt.
    setLocalError(null);
    usePullRequestMutationStore.getState().clearLane(detail.identity, "review");
  }, [detail.identity, open]);

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
        drafts: reviewDrafts.submissions,
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

  return {
    body,
    close,
    currentDrafts: reviewDrafts.currentDrafts,
    detail,
    displayedError,
    event,
    localError,
    mutationBlocked,
    onRefresh: refresh,
    onRetry: retry,
    open,
    startFresh,
    submit,
    submitting,
    summary,
    unavailableReason,
    updateSummary,
  };
}

function useReviewSnapshot(
  detail: PullRequestDetail,
  draftIdentityKey: string,
): PullRequestDraftSnapshot {
  return useMemo(
    () => ({
      identityKey: draftIdentityKey,
      baseOid: detail.base.oid ?? "",
      headOid: detail.head.oid ?? "",
    }),
    [detail.base.oid, detail.head.oid, draftIdentityKey],
  );
}

function usePullRequestMutationLane(detail: PullRequestDetail) {
  const selector = useMemo(
    () => selectPullRequestMutationLane(detail.identity, "review"),
    [detail.identity],
  );
  return usePullRequestMutationStore(selector);
}

function usePullRequestOutcomeUnknownLane(detail: PullRequestDetail) {
  const selector = useMemo(
    () => selectPullRequestOutcomeUnknownLane(detail.identity),
    [detail.identity],
  );
  return usePullRequestMutationStore(selector);
}

function useReviewDraftState(draftIdentityKey: string) {
  const draftOrder = usePullRequestReviewDraftStore((state) => state.order);
  const draftsById = usePullRequestReviewDraftStore((state) => state.drafts);
  const summaryDraft = usePullRequestReviewDraftStore(
    (state) => state.summaryDrafts[draftIdentityKey] ?? null,
  );
  return useMemo(() => {
    return {
      drafts: draftOrder.flatMap((localId) => {
        const draft = draftsById[localId];
        return draft?.identityKey === draftIdentityKey ? [draft] : [];
      }),
      summary: summaryDraft,
    };
  }, [draftIdentityKey, draftOrder, draftsById, summaryDraft]);
}

function deriveReviewDrafts(
  reviewDraftState: ReturnType<typeof useReviewDraftState>,
  snapshotKey: string,
) {
  const currentDrafts = reviewDraftState.drafts.filter(
    (draft) => draft.snapshotKey === snapshotKey,
  );
  const submissions = currentDrafts.flatMap((draft) => {
    const submission = toSubmission(draft);
    return submission ? [submission] : [];
  });
  return {
    currentDrafts,
    submissions,
    invalidDraftCount: currentDrafts.length - submissions.length,
    outdatedCount: reviewDraftState.drafts.filter((draft) => draft.outdated).length,
    replyCount: currentDrafts.filter((draft) => draft.kind === "reply").length,
  };
}

function getUnavailableReviewReason({
  capability,
  expected,
  summaryOutdated,
  outdatedCount,
  invalidDraftCount,
  replyCount,
  threadIndexComplete,
  event,
  body,
  submissions,
}: {
  capability: PullRequestCapability | null | undefined;
  expected: ReturnType<typeof pullRequestMutationExpected>;
  summaryOutdated: boolean;
  outdatedCount: number;
  invalidDraftCount: number;
  replyCount: number;
  threadIndexComplete: boolean;
  event: PullRequestReviewSubmissionEvent;
  body: string;
  submissions: PullRequestReviewDraftSubmission[];
}): string | null {
  return [
    pullRequestCapabilityReason(capability),
    expected ? null : "Base or head commit identity is unavailable.",
    reviewDraftProblem(summaryOutdated, outdatedCount, invalidDraftCount, replyCount, threadIndexComplete),
    emptyCommentReviewProblem(event, body, submissions),
  ].find((reason) => reason !== null) ?? null;
}

function reviewDraftProblem(
  summaryOutdated: boolean,
  outdatedCount: number,
  invalidDraftCount: number,
  replyCount: number,
  threadIndexComplete: boolean,
): string | null {
  if (summaryOutdated) return "The overall review targets an older change stack.";
  if (outdatedCount > 0) return `${outdatedCount} review drafts target an older change stack.`;
  if (invalidDraftCount > 0) return `${invalidDraftCount} review drafts are empty or no longer map to a line.`;
  if (replyCount > 0 && !threadIndexComplete) {
    return "Review threads are incomplete. Refresh them before submitting a reply.";
  }
  return null;
}

function emptyCommentReviewProblem(
  event: PullRequestReviewSubmissionEvent,
  body: string,
  submissions: PullRequestReviewDraftSubmission[],
): string | null {
  return event === "comment" && !body.trim() && submissions.length === 0
    ? "A comment review needs an overall body or at least one inline draft."
    : null;
}

type ReviewSubmission = ReturnType<typeof useReviewSubmission>;

function ReviewSubmissionDialog({ review }: { review: ReviewSubmission }) {
  return (
    <Dialog open={review.open} onOpenChange={review.close}>
      <DialogContent
        showCloseButton={!review.submitting}
        className="max-h-[90vh] w-[min(94vw,600px)] gap-0 overflow-hidden p-0 sm:max-w-[600px]"
        aria-busy={review.submitting || undefined}
      >
        <ReviewDialogHeader />
        <ScrollArea className="min-h-0 max-h-[65vh]">
          <div className="space-y-4 px-5 py-4">
            <ReviewRemoteEffect detail={review.detail} draftCount={review.currentDrafts.length} />
            <ReviewOutcomeField review={review} />
            <ReviewBodyField review={review} />
            <ReviewSubmissionNotices review={review} />
          </div>
        </ScrollArea>
        <ReviewDialogFooter review={review} />
      </DialogContent>
    </Dialog>
  );
}

function ReviewDialogHeader() {
  return (
    <header className="flex items-start gap-3 bg-page px-5 py-4 pr-12">
      <MessageSquareText size={18} aria-hidden className="mt-0.5 shrink-0 text-primary/85" />
      <div className="min-w-0">
        <DialogTitle className="text-sm">Submit review</DialogTitle>
        <DialogDescription className="mt-1 text-xs leading-5">
          Submit an explicit review and its session drafts to GitHub.
        </DialogDescription>
      </div>
    </header>
  );
}

function ReviewRemoteEffect({ detail, draftCount }: { detail: PullRequestDetail; draftCount: number }) {
  return (
    <div className="bg-page/65 px-4 py-3">
      <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">Remote effect</p>
      <p className="mt-2 text-sm font-medium text-foreground/90">
        {detail.identity.owner}/{detail.identity.repository} #{detail.identity.number}
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
        {draftCount} review {draftCount === 1 ? "draft" : "drafts"}
      </p>
    </div>
  );
}

function ReviewOutcomeField({ review }: { review: ReviewSubmission }) {
  const disabled = review.mutationBlocked || review.summary?.outdated;
  return (
    <div className="space-y-1.5">
      <label htmlFor="pull-request-review-event" className="text-xs text-muted-foreground">
        Review outcome
      </label>
      <Select
        value={review.event}
        onValueChange={(value) => review.updateSummary(value as PullRequestReviewSubmissionEvent, review.body)}
        disabled={disabled}
      >
        <SelectTrigger id="pull-request-review-event" className="w-full">
          <SelectValue>{eventLabel(review.event)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="comment">Comment</SelectItem>
          <SelectItem value="approve">Approve</SelectItem>
          <SelectItem value="request_changes">Request changes</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

function ReviewBodyField({ review }: { review: ReviewSubmission }) {
  const disabled = review.mutationBlocked || review.summary?.outdated;
  return (
    <div className="space-y-1.5">
      <label htmlFor="pull-request-review-body" className="text-xs text-muted-foreground">
        Overall review, optional
      </label>
      <Textarea
        id="pull-request-review-body"
        value={review.body}
        rows={5}
        disabled={disabled}
        className="resize-y rounded-none"
        onChange={(change) => review.updateSummary(review.event, change.target.value)}
        onKeyDown={(event) => submitReviewOnModEnter(event, review.submit)}
      />
    </div>
  );
}

function ReviewSubmissionNotices({ review }: { review: ReviewSubmission }) {
  return (
    <>
      {review.summary?.outdated ? <OutdatedReviewNotice review={review} /> : null}
      {review.unavailableReason && !review.summary?.outdated ? (
        <p role="status" className="flex items-start gap-2 bg-primary/8 px-3 py-2.5 text-xs text-muted-foreground">
          <AlertCircle size={13} aria-hidden className="mt-0.5 shrink-0 text-primary/80" />
          {review.unavailableReason}
        </p>
      ) : null}
      {review.localError ? <p role="alert" className="text-xs text-destructive">{review.localError}</p> : null}
      {review.displayedError ? (
        <PullRequestMutationError
          error={review.displayedError}
          busy={review.submitting}
          onRetry={() => void review.onRetry()}
          onRefresh={() => void review.onRefresh()}
        />
      ) : null}
    </>
  );
}

function OutdatedReviewNotice({ review }: { review: ReviewSubmission }) {
  return (
    <div className="flex items-center gap-2 bg-primary/8 px-3 py-2.5 text-xs text-muted-foreground">
      <AlertCircle size={13} aria-hidden className="shrink-0 text-primary/80" />
      <span className="min-w-0 flex-1">The overall review targets an older snapshot.</span>
      <Button type="button" variant="ghost" size="xs" disabled={review.mutationBlocked} onClick={review.startFresh}>
        Start fresh
      </Button>
    </div>
  );
}

function ReviewDialogFooter({ review }: { review: ReviewSubmission }) {
  const submitDisabled = review.mutationBlocked || Boolean(review.unavailableReason) || Boolean(review.localError);
  return (
    <DialogFooter className="m-0 flex-row justify-end rounded-none bg-page/65 px-5 py-3.5">
      <Button type="button" variant="ghost" disabled={review.submitting} onClick={() => review.close(false)}>
        Cancel
      </Button>
      <Button type="button" disabled={submitDisabled} onClick={() => void review.submit()}>
        {review.submitting ? (
          <>
            <Spinner size="xs" aria-hidden />
            Submitting review
          </>
        ) : (
          submitLabel(review.event)
        )}
      </Button>
    </DialogFooter>
  );
}

function submitReviewOnModEnter(
  event: React.KeyboardEvent<HTMLTextAreaElement>,
  submit: () => Promise<void>,
): void {
  if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
  event.preventDefault();
  void submit();
}
