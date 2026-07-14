import {
  PULL_REQUEST_MUTATION_BODY_MAX_BYTES,
  type PullRequestCapability,
  type PullRequestIdentity,
  type PullRequestMutationExpected,
} from "@mcode/contracts";
import { MessageSquare, SendHorizontal, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
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

/** Props for an explicit pull request issue-comment composer. */
export interface PullRequestIssueCommentComposerProps {
  identity: PullRequestIdentity;
  expected: PullRequestMutationExpected | null;
  capability: PullRequestCapability | null | undefined;
  mutationTransport?: PullRequestMutationTransport;
  readTransport?: PullRequestTransport;
  onRefresh?: () => Promise<boolean> | boolean;
  /** Compact presentation used when replying from the Summary conversation. */
  variant?: "timeline" | "reply";
  /** Actor named by the compact reply composer. */
  replyTo?: string;
  /** Closes the compact reply composer without discarding its session draft. */
  onCancel?: () => void;
  /** Closes the compact reply composer after GitHub accepts the comment. */
  onPosted?: () => void;
}

/** Session-preserved composer whose submit button confirms the remote comment. */
export function PullRequestIssueCommentComposer({
  identity,
  expected,
  capability,
  mutationTransport,
  readTransport,
  onRefresh,
  variant = "timeline",
  replyTo,
  onCancel,
  onPosted,
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
  const hasPostBody =
    body.trim().length > 0 &&
    !(
      variant === "reply" &&
      replyTo &&
      body.trim() === `@${replyTo}`
    );
  const canPost =
    !unavailableReason &&
    !submitting &&
    !outcomeUnknownLane &&
    lane.status !== "error" &&
    hasPostBody &&
    byteCount <= PULL_REQUEST_MUTATION_BODY_MAX_BYTES;
  const repository = `${identity.owner}/${identity.repository} #${identity.number}`;

  const post = async (): Promise<void> => {
    if (!canPost || !expected) return;
    setLocalError(null);
    const result = await usePullRequestMutationStore.getState().postComment(
      { identity, expected, body },
      { mutationTransport, readTransport },
    );
    if (result.ok) onPosted?.();
  };

  const retry = async (): Promise<void> => {
    const result = await usePullRequestMutationStore.getState().retry(
      identity,
      "comment",
      { mutationTransport, readTransport },
    );
    if (result?.ok && result.effect === "comment") onPosted?.();
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

  if (variant === "reply") {
    const replyLabel = replyTo ? `Reply to ${replyTo}` : "Reply to comment";
    const status = localError ?? unavailableReason;

    return (
      <section
        aria-label={replyLabel}
        aria-busy={submitting || undefined}
        className="-mx-4 -mb-4 mt-4 border-t border-border/40 bg-background/25 px-3 py-2.5"
      >
        <label htmlFor="pull-request-inline-reply" className="sr-only">
          {replyLabel}
        </label>
        <div className="flex min-w-0 items-end gap-1 rounded-md ring-1 ring-transparent transition-colors focus-within:bg-background/40 focus-within:ring-ring/60">
          <Textarea
            id="pull-request-inline-reply"
            autoFocus
            value={body}
            rows={1}
            disabled={
              Boolean(unavailableReason) ||
              submitting ||
              Boolean(displayedError)
            }
            aria-describedby={status ? "pull-request-reply-status" : undefined}
            placeholder={replyLabel}
            className="h-9 min-h-9 max-h-28 min-w-0 field-sizing-fixed resize-y border-0 bg-transparent px-2 py-2 text-sm shadow-none focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"
            onChange={(event) => {
              const accepted = usePullRequestMutationStore
                .getState()
                .setCommentDraft(identity, event.target.value);
              setLocalError(
                accepted ? null : "Reply exceeds the session draft limit.",
              );
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onCancel?.();
                return;
              }
              if (
                event.key !== "Enter" ||
                !(event.metaKey || event.ctrlKey)
              ) {
                return;
              }
              event.preventDefault();
              void post();
            }}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="my-1 size-7 rounded-full text-muted-foreground"
            aria-label="Cancel reply"
            onClick={onCancel}
          >
            <X aria-hidden className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="icon-xs"
            className="my-1 mr-1 size-7 rounded-full"
            aria-label="Post reply"
            disabled={!canPost}
            onClick={() => void post()}
          >
            {submitting ? (
              <Spinner size="xs" aria-hidden />
            ) : (
              <SendHorizontal aria-hidden className="size-3" />
            )}
          </Button>
        </div>
        {status ? (
          <p
            id="pull-request-reply-status"
            role={localError ? "alert" : "status"}
            className="mt-2 text-xs text-muted-foreground"
          >
            {status}
          </p>
        ) : null}
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

  return (
    <section
      aria-labelledby="pull-request-comment-composer-title"
      aria-busy={submitting || undefined}
      className="shrink-0 border-t border-border/70 bg-background px-4 py-3"
    >
      <div className="mx-auto w-full max-w-5xl">
        <div className="flex min-w-0 items-center gap-2">
          <MessageSquare
            size={14}
            aria-hidden
            className="shrink-0 text-muted-foreground"
          />
          <h3
            id="pull-request-comment-composer-title"
            className="shrink-0 text-sm font-medium text-foreground"
          >
            Add a comment
          </h3>
          <span className="truncate text-xs text-muted-foreground">
            on {repository}
          </span>
        </div>
        <label htmlFor="pull-request-issue-comment" className="sr-only">
          Comment for {repository}
        </label>
        <Textarea
          id="pull-request-issue-comment"
          value={body}
          rows={2}
          disabled={Boolean(unavailableReason) || submitting || Boolean(displayedError)}
          aria-describedby="pull-request-comment-limit pull-request-comment-status"
          placeholder="Write a comment"
          className="mt-2 h-16 min-h-16 max-h-36 field-sizing-fixed resize-y bg-background text-sm shadow-none"
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
            id="pull-request-comment-status"
            role={localError ? "alert" : "status"}
            className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
          >
            {localError ??
              unavailableReason ??
              (lane.status === "accepted"
                ? "Comment posted."
                : "Ctrl/⌘ Enter to post")}
          </p>
          <p
            id="pull-request-comment-limit"
            className={cn(
              "shrink-0 font-mono text-xs tabular-nums text-muted-foreground/70",
              byteCount === 0 && "sr-only",
            )}
          >
            {byteCount.toLocaleString()} /{" "}
            {PULL_REQUEST_MUTATION_BODY_MAX_BYTES.toLocaleString()} bytes
          </p>
          <Button
            type="button"
            size="sm"
            disabled={!canPost}
            onClick={() => void post()}
          >
            {submitting ? (
              <>
                <Spinner size="xs" aria-hidden />
                Posting
              </>
            ) : (
              <>
                <SendHorizontal size={13} aria-hidden />
                Post comment
              </>
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
      </div>
    </section>
  );
}
