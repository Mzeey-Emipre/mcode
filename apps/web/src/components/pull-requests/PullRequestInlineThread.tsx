import type { PullRequestReviewThread } from "@mcode/contracts";
import { memo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type {
  PullRequestDiffDraftLike,
  PullRequestDiffInlineRow,
} from "@/lib/pull-request-diff-row-model";
import { usePullRequestReviewDraftStore } from "@/stores/pullRequestReviewDraftStore";
import { RemoteMarkdown } from "./RemoteMarkdown";
import { safePullRequestHttpUrl } from "./safePullRequestHttpUrl";

/** Props for one measured inline review-thread row. */
export interface PullRequestInlineThreadProps {
  row: PullRequestDiffInlineRow;
  onCreateReply?: (thread: PullRequestReviewThread, originLineKey: string | null) => void;
  onUpdateDraft: (localId: string, body: string) => boolean;
  onRemoveDraft: (localId: string) => void;
  onRestoreFocus: (lineKey: string | null) => void;
}

function placementLabel(row: PullRequestDiffInlineRow): string {
  if (row.placement === "file") return "File conversation";
  if (row.placement === "outdated") return "Outdated conversation";
  if (row.placement === "original") return "Original line conversation";
  return "Line conversation";
}

function DraftEditor({
  draft,
  originLineKey,
  onUpdateDraft,
  onRemoveDraft,
  onRestoreFocus,
}: {
  draft: PullRequestDiffDraftLike;
  originLineKey: string | null;
  onUpdateDraft: (localId: string, body: string) => boolean;
  onRemoveDraft: (localId: string) => void;
  onRestoreFocus: (lineKey: string | null) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const body = usePullRequestReviewDraftStore(
    (state) => state.drafts[draft.localId]?.body ?? "",
  );

  const removeAndRestore = (): void => {
    onRemoveDraft(draft.localId);
    requestAnimationFrame(() => onRestoreFocus(originLineKey));
  };

  return (
    <div className="bg-background/45 px-3 py-2.5" data-draft-id={draft.localId}>
      <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-mono uppercase tracking-wider">Local draft</span>
        {draft.outdated && (
          <Badge variant="ghost" size="sm">
            Outdated
          </Badge>
        )}
      </div>
      <Textarea
        aria-label="Review draft"
        autoFocus={body.length === 0}
        value={body}
        className="min-h-20 resize-y rounded-none font-mono text-xs"
        onChange={(event) => {
          setError(
            onUpdateDraft(draft.localId, event.target.value)
              ? null
              : "Draft exceeds the local review limit.",
          );
        }}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          removeAndRestore();
        }}
      />
      {error && (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="mt-2 flex justify-end gap-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-xs text-muted-foreground"
          onClick={removeAndRestore}
        >
          Discard
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="text-xs"
          onClick={() => onRestoreFocus(originLineKey)}
        >
          Keep draft
        </Button>
      </div>
    </div>
  );
}

function PullRequestInlineThreadComponent({
  row,
  onCreateReply,
  onUpdateDraft,
  onRemoveDraft,
  onRestoreFocus,
}: PullRequestInlineThreadProps) {
  return (
    <section
      aria-label={placementLabel(row)}
      className="bg-page/70 px-3 py-2.5"
      data-inline-placement={row.placement}
    >
      <div className="mb-2 flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-muted-foreground">
        <span aria-hidden className="text-primary/80">⌁</span>
        <span>{placementLabel(row)}</span>
        {row.placement === "outdated" && (
          <span className="min-w-0 truncate normal-case tracking-normal">
            {row.path}
          </span>
        )}
        <span className="tabular-nums">
          {row.threads.length + row.drafts.length}
        </span>
      </div>
      <div className="space-y-3">
        {row.threads.map((thread) => (
          <article
            key={thread.providerNodeId}
            data-provider-node-id={thread.providerNodeId}
            className="bg-background/35 px-3 py-2.5"
          >
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-mono text-foreground/80">
                {thread.subjectType === "file"
                  ? thread.path
                  : `${thread.path}:${thread.line ?? thread.originalLine ?? "?"}`}
              </span>
              <Badge variant="ghost" size="sm">
                {thread.isResolved ? "Resolved" : "Open"}
              </Badge>
              {thread.isOutdated && (
                <Badge variant="ghost" size="sm">
                  Outdated
                </Badge>
              )}
            </div>
            <div className="mt-2 space-y-2.5">
              {thread.comments.map((comment) => {
                const url = comment.url ? safePullRequestHttpUrl(comment.url) : null;
                return (
                  <div key={comment.providerNodeId}>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span>{comment.author?.login ?? "Unknown actor"}</span>
                      <time dateTime={comment.createdAt} className="font-mono tabular-nums">
                        {new Date(comment.createdAt).toLocaleString()}
                      </time>
                      {url && (
                        <a
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="ml-auto font-mono underline-offset-4 hover:text-foreground hover:underline"
                        >
                          Open comment
                        </a>
                      )}
                    </div>
                    <RemoteMarkdown content={comment.body} className="mt-1" />
                  </div>
                );
              })}
            </div>
            {thread.totalCount > thread.comments.length && (
              <p className="mt-2 text-xs text-muted-foreground">
                Showing {thread.comments.length} of {thread.totalCount} comments.
              </p>
            )}
            {!thread.isResolved && onCreateReply && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mt-2 text-xs text-muted-foreground"
                onClick={() => onCreateReply(thread, row.anchorLineKey)}
              >
                Draft reply
              </Button>
            )}
          </article>
        ))}
        {row.drafts.map((draft) => (
          <DraftEditor
            key={draft.localId}
            draft={draft}
            originLineKey={row.anchorLineKey}
            onUpdateDraft={onUpdateDraft}
            onRemoveDraft={onRemoveDraft}
            onRestoreFocus={onRestoreFocus}
          />
        ))}
      </div>
    </section>
  );
}

/** Measured inline remote conversation and session-local review-draft editor. */
export const PullRequestInlineThread = memo(PullRequestInlineThreadComponent);

PullRequestInlineThread.displayName = "PullRequestInlineThread";
