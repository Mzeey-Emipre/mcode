import { MessageCircle, X } from "lucide-react";
import type { SelectedTextComment } from "@mcode/contracts";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** Props for the aggregate selected-text comment attachment in the composer. */
export interface SelectedTextCommentsComposerAttachmentProps {
  /** Saved comments attached to the active composer draft. */
  readonly comments: readonly SelectedTextComment[];
  /** Removes every selected-text comment from the active draft. */
  readonly onRemove: () => void;
}

function commentLabel(count: number): string {
  return `${count} comment${count === 1 ? "" : "s"}`;
}

/** Renders the compact selected-text comment attachment from the accepted prototype. */
export function SelectedTextCommentsComposerAttachment({
  comments,
  onRemove,
}: SelectedTextCommentsComposerAttachmentProps) {
  if (comments.length === 0) return null;

  const label = commentLabel(comments.length);

  return (
    <div className="px-3 pt-2" data-testid="selected-text-comment-attachment">
      <div className="inline-flex h-8 max-w-full items-center overflow-hidden rounded-lg border border-border bg-background focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`${label}. Details available.`}
                className="min-w-0 rounded-none border-y-0 border-l-0 border-r border-border bg-transparent px-3 text-foreground hover:bg-muted focus-visible:z-10"
              >
                <MessageCircle size={16} aria-hidden />
                <span className="min-w-0 truncate">{label}</span>
              </Button>
            }
          />
          <TooltipContent
            variant="surface"
            side="top"
            align="end"
            sideOffset={8}
            className="w-[min(28rem,calc(100vw-1.6rem))] max-w-none items-stretch rounded-xl p-0"
          >
            <ol className="max-h-80 min-w-0 list-none overflow-y-auto p-1">
              {comments.map((comment, index) => (
                <li key={comment.id} className="grid min-w-0 grid-cols-[2rem_minmax(0,1fr)] gap-2 border-b border-border/45 px-2 py-2 last:border-b-0">
                  <span className="font-mono text-xs leading-5 tabular-nums text-muted-foreground" aria-hidden>
                    {index + 1}
                  </span>
                  <p className="min-w-0 whitespace-pre-wrap break-words text-sm leading-5">
                    {comment.note}
                  </p>
                </li>
              ))}
            </ol>
          </TooltipContent>
        </Tooltip>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Remove ${label}`}
          onClick={onRemove}
          className="rounded-none border-0 bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:z-10"
        >
          <X size={16} aria-hidden />
        </Button>
      </div>
    </div>
  );
}
