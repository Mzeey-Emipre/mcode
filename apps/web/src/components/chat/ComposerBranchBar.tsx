import { X } from "lucide-react";

interface ComposerBranchBarProps {
  /** ID of the message being branched from; bar is hidden when absent. */
  branchFromMessageId?: string;
  /** Preview content of the message being branched from, shown as a truncated excerpt. */
  branchFromMessageContent?: string;
  /** Called when the user exits branch mode via the X button. */
  onBranchModeExit?: () => void;
}

/**
 * Minimal quote bar shown at the top of the Composer when in branch mode.
 * Uses a ↳ glyph instead of the heavier gradient/border chrome.
 */
export function ComposerBranchBar({ branchFromMessageId, branchFromMessageContent, onBranchModeExit }: ComposerBranchBarProps) {
  if (!branchFromMessageId) return null;

  return (
    <div className="flex items-start gap-2 px-3 py-2 animate-fade-up-in">
      <span className="shrink-0 text-sm text-primary/70 leading-none mt-0.5" aria-hidden="true">↳</span>
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-medium text-muted-foreground/60 leading-none mb-0.5">Branching from</p>
        {branchFromMessageContent && (
          <p className="text-xs text-muted-foreground/50 truncate italic">
            {branchFromMessageContent.slice(0, 120)}{branchFromMessageContent.length > 120 ? "…" : ""}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={onBranchModeExit}
        className="shrink-0 rounded p-0.5 text-muted-foreground/30 hover:text-muted-foreground hover:bg-muted/40 transition-colors"
        aria-label="Exit branch mode"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
