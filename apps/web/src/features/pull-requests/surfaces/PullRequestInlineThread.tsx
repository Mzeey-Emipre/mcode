import type { PullRequestReviewThread } from "@mcode/contracts";
import { MessageCircle } from "lucide-react";
import { memo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type {
  PullRequestDiffDraftLike,
  PullRequestDiffInlineRow,
} from "@/features/pull-requests/lib/pull-request-diff-row-model";
import { usePullRequestReviewDraftStore } from "@/features/pull-requests/state/pullRequestReviewDraftStore";
import { RemoteMarkdown } from "./RemoteMarkdown";

/** Props for one measured inline review-thread row. */
export interface PullRequestInlineThreadProps {
  row: PullRequestDiffInlineRow;
  onCreateReply?: (thread: PullRequestReviewThread, originLineKey: string | null) => void;
  onUpdateDraft: (localId: string, body: string) => boolean;
  onRemoveDraft: (localId: string) => void;
  onRestoreFocus: (lineKey: string | null) => void;
}

function coordinateLabel(
  subjectType: "file" | "line",
  side: "left" | "right" | null,
  line: number | null,
  originalLine: number | null,
): string {
  if (subjectType === "file") return "Comment on file";
  const targetLine = line ?? originalLine;
  if (targetLine === null) return "Comment on line";
  return `Comment on line ${side === "left" ? "L" : "R"}${targetLine}`;
}

function rowTargetLabel(row: PullRequestDiffInlineRow): string {
  if (!row.coordinate) return `Comment on ${row.path}`;
  return coordinateLabel(
    row.coordinate.subjectType,
    row.coordinate.side ?? row.coordinate.originalSide,
    row.coordinate.line,
    row.coordinate.originalLine,
  );
}

function threadTargetLabel(thread: PullRequestReviewThread): string {
  return coordinateLabel(
    thread.subjectType,
    thread.side,
    thread.line,
    thread.originalLine,
  );
}

function DraftEditor({
  draft,
  targetLabel,
  originLineKey,
  onUpdateDraft,
  onRemoveDraft,
  onRestoreFocus,
}: {
  draft: PullRequestDiffDraftLike;
  targetLabel: string;
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
    <div
      className="rounded-lg bg-muted/55 p-3 ring-1 ring-inset ring-border/60"
      data-draft-id={draft.localId}
    >
      <div className="flex min-w-0 items-center gap-2">
        <MessageCircle
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground"
        />
        <span className="text-sm font-medium text-foreground">
          Local comment
        </span>
        {draft.outdated ? (
          <Badge variant="ghost" size="sm">
            Outdated
          </Badge>
        ) : null}
        <span className="ml-auto min-w-0 truncate font-mono text-xs text-muted-foreground">
          {targetLabel}
        </span>
      </div>
      <Textarea
        aria-label="Review draft"
        autoFocus={body.length === 0}
        value={body}
        placeholder="Request change"
        className="mt-3 min-h-20 resize-none border-border/50 bg-background/60 px-3 py-2.5 text-sm leading-5 shadow-none"
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
      <div className="mt-2.5 flex justify-end gap-1.5">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="text-xs text-muted-foreground"
          onClick={removeAndRestore}
        >
          Discard
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="xs"
          className="text-xs"
          onClick={() => onRestoreFocus(originLineKey)}
        >
          Done
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
      aria-label="Inline review comments"
      className="py-3 pl-12 pr-3"
      data-inline-placement={row.placement}
    >
      <div className="max-w-4xl space-y-3">
        {row.threads.map((thread) => (
          <article
            key={thread.providerNodeId}
            data-provider-node-id={thread.providerNodeId}
            className="overflow-hidden rounded-lg bg-muted/45 ring-1 ring-inset ring-border/60"
          >
            <div className="flex min-w-0 items-center gap-2 px-3 py-2.5">
              <MessageCircle
                aria-hidden
                className="size-4 shrink-0 text-muted-foreground"
              />
              <span className="text-sm font-medium text-foreground">
                Review thread
              </span>
              <Badge variant="ghost" size="sm">
                {thread.isResolved ? "Resolved" : "Open"}
              </Badge>
              {thread.isOutdated && (
                <Badge variant="ghost" size="sm">
                  Outdated
                </Badge>
              )}
              <span className="ml-auto min-w-0 truncate font-mono text-xs text-muted-foreground">
                {threadTargetLabel(thread)}
              </span>
            </div>
            <div className="divide-y divide-border/40 border-t border-border/40">
              {thread.comments.map((comment) => (
                <div className="px-3 py-3" key={comment.providerNodeId}>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground/80">
                      {comment.author?.login ?? "Unknown actor"}
                    </span>
                    <time
                      dateTime={comment.createdAt}
                      className="font-mono tabular-nums"
                    >
                      {new Date(comment.createdAt).toLocaleString()}
                    </time>
                  </div>
                  <RemoteMarkdown content={comment.body} className="mt-1" />
                </div>
              ))}
            </div>
            {thread.totalCount > thread.comments.length && (
              <p className="border-t border-border/40 px-3 py-2 text-xs text-muted-foreground">
                Showing {thread.comments.length} of {thread.totalCount} comments.
              </p>
            )}
            {!thread.isResolved && onCreateReply && (
              <div className="flex justify-end border-t border-border/40 px-2 py-1.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="text-xs text-muted-foreground"
                  onClick={() => onCreateReply(thread, row.anchorLineKey)}
                >
                  Draft reply
                </Button>
              </div>
            )}
          </article>
        ))}
        {row.drafts.map((draft) => (
          <DraftEditor
            key={draft.localId}
            draft={draft}
            targetLabel={rowTargetLabel(row)}
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
