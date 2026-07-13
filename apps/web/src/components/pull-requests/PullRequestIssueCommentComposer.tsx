import {
  PULL_REQUEST_MUTATION_BODY_MAX_BYTES,
  type PullRequestCapability,
  type PullRequestIdentity,
  type PullRequestMutationExpected,
} from "@mcode/contracts";
import { MessageSquare } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import {
  selectPullRequestCommentDraft,
  selectPullRequestMutationLane,
  selectPullRequestOutcomeUnknownLane,
} from "@/stores/pull-request-mutation-selectors";
import {
  getPullRequestMutationIdentityKey,
  usePullRequestMutationStore,
} from "@/stores/pullRequestMutationStore";
import type { PullRequestMutationTransport } from "@/transport/pull-request-mutations";
import type { PullRequestTransport } from "@/transport/pull-requests";
import {
  PullRequestMutationError,
  pullRequestCapabilityReason,
} from "./PullRequestMutationError";

const textEncoder = new TextEncoder();

/** Props for the explicit issue-comment composer at the end of Timeline. */
export interface PullRequestIssueCommentComposerProps {
  identity: PullRequestIdentity;
  expected: PullRequestMutationExpected | null;
  capability: PullRequestCapability | null | undefined;
  mutationTransport?: PullRequestMutationTransport;
  readTransport?: PullRequestTransport;
  onRefresh?: () => Promise<boolean> | boolean;
}

/** Session-preserved Timeline composer whose button is the comment confirmation. */
export function PullRequestIssueCommentComposer({
  identity,
  expected,
  capability,
  mutationTransport,
  readTransport,
  onRefresh,
}: PullRequestIssueCommentComposerProps) {
  const identityKey = getPullRequestMutationIdentityKey(identity);
  const selectDraft = useMemo(
    () => selectPullRequestCommentDraft(identity),
    [identityKey],
  );
  const selectLane = useMemo(
    () => selectPullRequestMutationLane(identity, "comment"),
    [identityKey],
  );
  const selectUnknown = useMemo(
    () => selectPullRequestOutcomeUnknownLane(identity),
    [identityKey],
  );
  const body = usePullRequestMutationStore(selectDraft);
  const lane = usePullRequestMutationStore(selectLane);
  const outcomeUnknownLane = usePullRequestMutationStore(selectUnknown);
  const displayedError = outcomeUnknownLane?.error ?? lane.error;
  const [localError, setLocalError] = useState<string | null>(null);
  const byteCount = textEncoder.encode(body).byteLength;
  const capabilityReason = pullRequestCapabilityReason(capability);
  const unavailableReason =
    capabilityReason ??
    (expected ? null : "Base or head commit identity is unavailable.");
  const submitting = lane.status === "submitting";
  const canPost =
    !unavailableReason &&
    !submitting &&
    !outcomeUnknownLane &&
    lane.status !== "error" &&
    body.trim().length > 0 &&
    byteCount <= PULL_REQUEST_MUTATION_BODY_MAX_BYTES;
  const repository = `${identity.owner}/${identity.repository} #${identity.number}`;

  const post = async (): Promise<void> => {
    if (!canPost || !expected) return;
    setLocalError(null);
    await usePullRequestMutationStore.getState().postComment(
      { identity, expected, body },
      { mutationTransport, readTransport },
    );
  };

  const retry = async (): Promise<void> => {
    await usePullRequestMutationStore.getState().retry(
      identity,
      "comment",
      { mutationTransport, readTransport },
    );
  };

  const refresh = async (): Promise<void> => {
    const store = usePullRequestMutationStore.getState();
    if (outcomeUnknownLane) {
      await store.acknowledgeOutcomeUnknownAfterRefresh(
        identity,
        async () => Boolean(await onRefresh?.()),
      );
      return;
    }
    if (await onRefresh?.()) store.clearLane(identity, "comment");
  };

  return (
    <section
      aria-labelledby="pull-request-comment-composer-title"
      aria-busy={submitting || undefined}
      className="shrink-0 bg-page/75 px-4 py-3"
    >
      <div className="flex min-w-0 items-center gap-2">
        <MessageSquare size={13} aria-hidden className="shrink-0 text-primary/80" />
        <h3
          id="pull-request-comment-composer-title"
          className="font-mono text-xs font-semibold uppercase tracking-wider text-foreground/85"
        >
          Issue comment
        </h3>
        <span className="ml-auto truncate font-mono text-xs text-muted-foreground">
          {repository}
        </span>
      </div>
      <label htmlFor="pull-request-issue-comment" className="sr-only">
        Comment for {repository}
      </label>
      <Textarea
        id="pull-request-issue-comment"
        value={body}
        rows={3}
        disabled={Boolean(unavailableReason) || submitting || Boolean(displayedError)}
        aria-describedby="pull-request-comment-limit pull-request-comment-status"
        placeholder="Write an issue comment"
        className="mt-2 min-h-20 resize-y rounded-none bg-background/45 text-sm"
        onChange={(event) => {
          const accepted = usePullRequestMutationStore
            .getState()
            .setCommentDraft(identity, event.target.value);
          setLocalError(accepted ? null : "Comment exceeds the session draft limit.");
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
          event.preventDefault();
          void post();
        }}
      />
      <div className="mt-2 flex min-w-0 items-center gap-3">
        <p
          id="pull-request-comment-limit"
          className="font-mono text-xs tabular-nums text-muted-foreground/70"
        >
          {byteCount}/{PULL_REQUEST_MUTATION_BODY_MAX_BYTES} bytes
        </p>
        <p
          id="pull-request-comment-status"
          role={localError ? "alert" : "status"}
          className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
        >
          {localError ?? unavailableReason ?? (lane.status === "accepted" ? "Comment posted." : "Mod+Enter to post")}
        </p>
        <Button type="button" size="sm" disabled={!canPost} onClick={() => void post()}>
          {submitting ? (
            <>
              <Spinner size="xs" aria-hidden />
              Posting
            </>
          ) : (
            "Post comment"
          )}
        </Button>
      </div>
      {displayedError ? (
        <div className="mt-3">
          <PullRequestMutationError
            error={displayedError}
            busy={submitting}
            onRetry={() => void retry()}
            onRefresh={() => void refresh()}
          />
        </div>
      ) : null}
    </section>
  );
}
