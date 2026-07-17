import { Reply, X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ComposerReplyBarProps {
  /** Role of the message being replied to. */
  sourceRole: "user" | "assistant";
  /** Display preview text (truncated). */
  previewText: string;
  /** Called when the user dismisses the reply. */
  onDismiss: () => void;
}

/**
 * Quote chip shown at the top of the Composer when replying to a message.
 * Displays a left-accent border, role label, and truncated excerpt.
 */
export function ComposerReplyBar({ sourceRole, previewText, onDismiss }: ComposerReplyBarProps) {
  return (
    <div className="flex items-start gap-2 px-3 py-2 animate-fade-up-in">
      <Reply className="mt-0.5 size-3.5 shrink-0 text-primary/70 scale-x-[-1]" />
      <div className="min-w-0 flex-1 border-l-2 border-primary/40 pl-2">
        <p className="text-xs font-medium text-muted-foreground/60 leading-none mb-0.5">
          Replying to {sourceRole}
        </p>
        <p className="text-xs text-muted-foreground/50 truncate italic">
          {previewText.slice(0, 150)}{previewText.length > 150 ? "..." : ""}
        </p>
      </div>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={onDismiss}
        className="shrink-0 text-muted-foreground/30 hover:bg-muted/40 hover:text-muted-foreground"
        aria-label="Cancel reply"
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );
}
