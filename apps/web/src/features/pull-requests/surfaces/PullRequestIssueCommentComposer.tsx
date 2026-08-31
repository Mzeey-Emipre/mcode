import {
  PULL_REQUEST_MUTATION_BODY_MAX_BYTES,
  type PullRequestCapability,
  type PullRequestIdentity,
  type PullRequestMutationError as MutationError,
  type PullRequestMutationExpected,
} from "@mcode/contracts";
import { ArrowUp, X } from "lucide-react";
import { type KeyboardEvent, useMemo, useState } from "react";
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
  const composer = useIssueCommentComposer({
    identity,
    expected,
    capability,
    mutationTransport,
    readTransport,
    onRefresh,
    variant,
    replyTo,
    onPosted,
  });

  return variant === "reply" ? (
    <PullRequestReplyComposer
      composer={composer}
      replyTo={replyTo}
      onCancel={onCancel}
    />
  ) : (
    <PullRequestTimelineCommentComposer composer={composer} />
  );
}

interface IssueCommentComposerOptions {
  identity: PullRequestIdentity;
  expected: PullRequestMutationExpected | null;
  capability: PullRequestCapability | null | undefined;
  mutationTransport?: PullRequestMutationTransport;
  readTransport?: PullRequestTransport;
  onRefresh?: () => Promise<boolean> | boolean;
  variant: "timeline" | "reply";
  replyTo?: string;
  onPosted?: () => void;
}

function useIssueCommentComposer({
  identity,
  expected,
  capability,
  mutationTransport,
  readTransport,
  onRefresh,
  variant,
  replyTo,
  onPosted,
}: IssueCommentComposerOptions) {
  const selectDraft = useMemo(
    () => selectPullRequestCommentDraft(identity),
    [identity],
  );
  const selectLane = useMemo(
    () => selectPullRequestMutationLane(identity, "comment"),
    [identity],
  );
  const selectUnknown = useMemo(
    () => selectPullRequestOutcomeUnknownLane(identity),
    [identity],
  );
  const body = usePullRequestMutationStore(selectDraft);
  const lane = usePullRequestMutationStore(selectLane);
  const outcomeUnknownLane = usePullRequestMutationStore(selectUnknown);
  const displayedError = outcomeUnknownLane?.error ?? lane.error;
  const [localError, setLocalError] = useState<string | null>(null);
  const byteCount = textEncoder.encode(body).byteLength;
  const showByteCount = byteCount >= PULL_REQUEST_MUTATION_BODY_MAX_BYTES * 0.9;
  const unavailableReason = getUnavailableCommentReason(capability, expected);
  const submitting = lane.status === "submitting";
  const hasPostBody = hasCommentPostBody(body, variant, replyTo);
  const canPost =
    !unavailableReason &&
    !submitting &&
    !outcomeUnknownLane &&
    lane.status !== "error" &&
    hasPostBody &&
    byteCount <= PULL_REQUEST_MUTATION_BODY_MAX_BYTES;

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

  const setDraft = (nextBody: string): void => {
    const accepted = usePullRequestMutationStore
      .getState()
      .setCommentDraft(identity, nextBody);
    setLocalError(accepted ? null : commentDraftLimitError(variant));
  };

  return {
    body,
    byteCount,
    canPost,
    displayedError,
    localError,
    showByteCount,
    submitting,
    unavailableReason,
    repository: `${identity.owner}/${identity.repository} #${identity.number}`,
    accepted: lane.status === "accepted",
    inputDisabled: Boolean(unavailableReason) || submitting || Boolean(displayedError),
    post,
    refresh,
    retry,
    setDraft,
  };
}

type IssueCommentComposer = ReturnType<typeof useIssueCommentComposer>;

function PullRequestReplyComposer({
  composer,
  replyTo,
  onCancel,
}: {
  composer: IssueCommentComposer;
  replyTo?: string;
  onCancel?: () => void;
}) {
  const replyLabel = replyTo ? `Reply to ${replyTo}` : "Reply to comment";
  const status = composer.localError ?? composer.unavailableReason;

  return (
    <section aria-label={replyLabel} aria-busy={composer.submitting || undefined} className="mt-4">
      <label htmlFor="pull-request-inline-reply" className="sr-only">
        {replyLabel}
      </label>
      <div className={composerShellClass}>
        <Textarea
          id="pull-request-inline-reply"
          autoFocus
          value={composer.body}
          rows={1}
          disabled={composer.inputDisabled}
          aria-describedby={status ? "pull-request-reply-status" : undefined}
          placeholder={replyLabel}
          className={cn(composerTextareaClass, "pr-20")}
          onChange={(event) => composer.setDraft(event.target.value)}
          onKeyDown={(event) => handleReplyKeyDown(event, composer.post, onCancel)}
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
        <PostCommentButton
          label="Post reply"
          canPost={composer.canPost}
          submitting={composer.submitting}
          onPost={composer.post}
        />
      </div>
      <CommentComposerStatus
        error={composer.displayedError}
        localError={composer.localError}
        status={status}
        submitting={composer.submitting}
        onRetry={composer.retry}
        onRefresh={composer.refresh}
        statusId="pull-request-reply-status"
      />
    </section>
  );
}

function PullRequestTimelineCommentComposer({
  composer,
}: {
  composer: IssueCommentComposer;
}) {
  const repository = composer.repository;
  const commentStatus = composer.localError ?? composer.unavailableReason ?? (composer.accepted ? "Comment posted." : null);
  const commentDescriptionIds = commentDescriptionIdsFor(composer.showByteCount, commentStatus);

  return (
    <section
      aria-label="Add a comment"
      aria-busy={composer.submitting || undefined}
      className="relative z-10 shrink-0 px-3 pb-3 pt-2 before:pointer-events-none before:absolute before:inset-x-0 before:-top-4 before:h-4 before:bg-gradient-to-t before:from-page before:to-transparent"
    >
      <div className="mx-auto w-full max-w-5xl">
        <div className={composerShellClass}>
          <label htmlFor="pull-request-issue-comment" className="sr-only">
            Comment for {repository}
          </label>
          <Textarea
            id="pull-request-issue-comment"
            value={composer.body}
            rows={1}
            disabled={composer.inputDisabled}
            aria-describedby={commentDescriptionIds || undefined}
            placeholder={`Comment on ${repository}`}
            className={cn(composerTextareaClass, "pr-12")}
            onChange={(event) => composer.setDraft(event.target.value)}
            onKeyDown={(event) => handleSubmitKeyDown(event, composer.post)}
          />
          <PostCommentButton
            label={composer.submitting ? "Posting comment" : "Post comment"}
            canPost={composer.canPost}
            submitting={composer.submitting}
            onPost={composer.post}
          />
        </div>
        <TimelineCommentMetadata composer={composer} commentStatus={commentStatus} />
        <CommentComposerStatus
          error={composer.displayedError}
          submitting={composer.submitting}
          onRetry={composer.retry}
          onRefresh={composer.refresh}
        />
      </div>
    </section>
  );
}

function TimelineCommentMetadata({
  composer,
  commentStatus,
}: {
  composer: IssueCommentComposer;
  commentStatus: string | null;
}) {
  return (
    <>
      {commentStatus || composer.showByteCount ? (
        <div className="mt-2 flex min-w-0 items-center gap-2 px-1">
          {commentStatus ? (
            <p
              id="pull-request-comment-status"
              role={composer.localError ? "alert" : "status"}
              className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
            >
              {commentStatus}
            </p>
          ) : (
            <span className="flex-1" />
          )}
          {composer.showByteCount ? <CommentByteCount byteCount={composer.byteCount} /> : null}
        </div>
      ) : null}
      {!composer.showByteCount ? <CommentByteCount byteCount={composer.byteCount} hidden /> : null}
    </>
  );
}

function CommentByteCount({
  byteCount,
  hidden = false,
}: {
  byteCount: number;
  hidden?: boolean;
}) {
  if (hidden) {
    return (
      <p id="pull-request-comment-limit" className="sr-only">
        {byteCount.toLocaleString()} /{" "}
        {PULL_REQUEST_MUTATION_BODY_MAX_BYTES.toLocaleString()} bytes
      </p>
    );
  }

  return (
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
  );
}

function PostCommentButton({
  label,
  canPost,
  submitting,
  onPost,
}: {
  label: string;
  canPost: boolean;
  submitting: boolean;
  onPost: () => Promise<void>;
}) {
  return (
    <Button
      type="button"
      size="icon-sm"
      className="absolute bottom-2 right-2 size-8 rounded-full"
      aria-label={label}
      disabled={!canPost}
      onClick={() => void onPost()}
    >
      {submitting ? <Spinner size="xs" aria-hidden /> : <ArrowUp size={14} aria-hidden />}
    </Button>
  );
}

function CommentComposerStatus({
  error,
  localError,
  status,
  submitting,
  onRetry,
  onRefresh,
  statusId,
}: {
  error: MutationError | null;
  localError?: string | null;
  status?: string | null;
  submitting: boolean;
  onRetry: () => Promise<void>;
  onRefresh: () => Promise<void>;
  statusId?: string;
}) {
  return (
    <>
      {status ? (
        <p id={statusId} role={localError ? "alert" : "status"} className="mt-2 text-xs text-muted-foreground">
          {status}
        </p>
      ) : null}
      {error ? (
        <div className="mt-3">
          <PullRequestMutationError
            error={error}
            busy={submitting}
            onRetry={() => void onRetry()}
            onRefresh={() => void onRefresh()}
          />
        </div>
      ) : null}
    </>
  );
}

function getUnavailableCommentReason(
  capability: PullRequestCapability | null | undefined,
  expected: PullRequestMutationExpected | null,
): string | null {
  return pullRequestCapabilityReason(capability) ?? (expected ? null : "Base or head commit identity is unavailable.");
}

function hasCommentPostBody(body: string, variant: "timeline" | "reply", replyTo?: string): boolean {
  const trimmedBody = body.trim();
  return trimmedBody.length > 0 && !(variant === "reply" && replyTo && trimmedBody === `@${replyTo}`);
}

function commentDraftLimitError(variant: "timeline" | "reply"): string {
  return variant === "reply" ? "Reply exceeds the session draft limit." : "Comment exceeds the session draft limit.";
}

function commentDescriptionIdsFor(showByteCount: boolean, commentStatus: string | null): string {
  return [
    showByteCount ? "pull-request-comment-limit" : null,
    commentStatus ? "pull-request-comment-status" : null,
  ].filter(Boolean).join(" ");
}

function handleSubmitKeyDown(event: KeyboardEvent<HTMLTextAreaElement>, onPost: () => Promise<void>): void {
  if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
  event.preventDefault();
  void onPost();
}

function handleReplyKeyDown(
  event: KeyboardEvent<HTMLTextAreaElement>,
  onPost: () => Promise<void>,
  onCancel?: () => void,
): void {
  if (event.key === "Escape") {
    event.preventDefault();
    onCancel?.();
    return;
  }
  handleSubmitKeyDown(event, onPost);
}
