import {
  PULL_REQUEST_MUTATION_BODY_MAX_BYTES,
  type PullRequestCapability,
  type PullRequestIdentity,
  type PullRequestMutationExpected,
} from "@mcode/contracts";
import { ArrowUp, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  selectPullRequestCommentDraft,
  selectPullRequestMutationLane,
  selectPullRequestOutcomeUnknownLane,
} from "@/features/pull-requests/state/pull-request-mutation-selectors";
import {
  getPullRequestMutationIdentityKey,
  usePullRequestMutationStore,
} from "@/features/pull-requests/state/pullRequestMutationStore";
import type { PullRequestMutationTransport } from "@/transport/pull-request-mutations";
import type { PullRequestTransport } from "@/transport/pull-requests";
import {
  PullRequestMutationError,
  pullRequestCapabilityReason,
} from "./PullRequestMutationError";

const textEncoder = new TextEncoder();
const composerShellClass =
  "relative rounded-xl bg-muted/50 ring-1 ring-inset ring-border/60 transition-shadow focus-within:ring-2 focus-within:ring-primary/70";
const composerTextareaClass =
  "min-h-12 max-h-32 resize-none border-0 bg-transparent px-3 pb-3 pt-3 text-sm shadow-none focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent";

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
  const showByteCount =
    byteCount >= PULL_REQUEST_MUTATION_BODY_MAX_BYTES * 0.9;
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
  const commentStatus =
    localError ??
    unavailableReason ??
    (lane.status === "accepted" ? "Comment posted." : null);
  const commentDescriptionIds = [
    showByteCount ? "pull-request-comment-limit" : null,
    commentStatus ? "pull-request-comment-status" : null,
  ]
    .filter(Boolean)
    .join(" ");

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
        className="mt-4"
      >
        <label htmlFor="pull-request-inline-reply" className="sr-only">
          {replyLabel}
        </label>
        <div className={composerShellClass}>
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
            className={cn(composerTextareaClass, "pr-20")}
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
            size="icon-sm"
            className="absolute bottom-2 right-11 size-8 rounded-full text-muted-foreground"
            aria-label="Cancel reply"
            onClick={onCancel}
          >
            <X aria-hidden className="size-3.5" />
          </Button>
          <Button
            type="button"
            size="icon-sm"
            className="absolute bottom-2 right-2 size-8 rounded-full"
            aria-label="Post reply"
            disabled={!canPost}
            onClick={() => void post()}
          >
            {submitting ? (
              <Spinner size="xs" aria-hidden />
            ) : (
              <ArrowUp size={14} aria-hidden />
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
      aria-label="Add a comment"
      aria-busy={submitting || undefined}
      className="relative z-10 shrink-0 px-3 pb-3 pt-2 before:pointer-events-none before:absolute before:inset-x-0 before:-top-4 before:h-4 before:bg-gradient-to-t before:from-page before:to-transparent"
    >
      <div className="mx-auto w-full max-w-5xl">
        <div className={composerShellClass}>
          <label htmlFor="pull-request-issue-comment" className="sr-only">
            Comment for {repository}
          </label>
          <Textarea
            id="pull-request-issue-comment"
            value={body}
            rows={1}
            disabled={
              Boolean(unavailableReason) ||
              submitting ||
              Boolean(displayedError)
            }
            aria-describedby={commentDescriptionIds || undefined}
            placeholder={`Comment on ${repository}`}
            className={cn(composerTextareaClass, "pr-12")}
            onChange={(event) => {
              const accepted = usePullRequestMutationStore
                .getState()
                .setCommentDraft(identity, event.target.value);
              setLocalError(
                accepted
                  ? null
                  : "Comment exceeds the session draft limit.",
              );
            }}
            onKeyDown={(event) => {
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
            size="icon-sm"
            className="absolute bottom-2 right-2 size-8 rounded-full"
            aria-label={submitting ? "Posting comment" : "Post comment"}
            disabled={!canPost}
            onClick={() => void post()}
          >
            {submitting ? (
              <Spinner size="xs" aria-hidden />
            ) : (
              <ArrowUp size={14} aria-hidden />
            )}
          </Button>
        </div>
        {commentStatus || showByteCount ? (
          <div className="mt-2 flex min-w-0 items-center gap-2 px-1">
            {commentStatus ? (
              <p
                id="pull-request-comment-status"
                role={localError ? "alert" : "status"}
                className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
              >
                {commentStatus}
              </p>
            ) : (
              <span className="flex-1" />
            )}
            {showByteCount ? (
              <p
                id="pull-request-comment-limit"
                className={cn(
                  "shrink-0 font-mono text-xs tabular-nums",
                  byteCount > PULL_REQUEST_MUTATION_BODY_MAX_BYTES
                    ? "text-destructive"
                    : "text-muted-foreground/70",
                )}
              >
                {byteCount.toLocaleString()} /{" "}
                {PULL_REQUEST_MUTATION_BODY_MAX_BYTES.toLocaleString()} bytes
              </p>
            ) : null}
          </div>
        ) : null}
        {!showByteCount ? (
          <p id="pull-request-comment-limit" className="sr-only">
            {byteCount.toLocaleString()} /{" "}
            {PULL_REQUEST_MUTATION_BODY_MAX_BYTES.toLocaleString()} bytes
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
      </div>
    </section>
  );
}
