import { useState } from "react";
import { ChevronRight, Sparkles } from "lucide-react";

interface StreamingCardProps {
  /** Accumulated streaming text from textDelta events. */
  text: string;
}

/**
 * Collapsible card that displays live streaming response text.
 * Collapsed (default): shows a single-line live preview with a chevron toggle.
 * Expanded: shows the full accumulated text in a scrollable area.
 */
export function StreamingCard({ text }: StreamingCardProps) {
  const [expanded, setExpanded] = useState(false);

  // Extract the last non-empty line for the collapsed preview.
  // Trim handles whitespace-only text so the "Responding..." fallback fires.
  const lastNewline = text.lastIndexOf("\n");
  const previewText = (lastNewline >= 0
    ? text.slice(lastNewline + 1).trim() || text.trimEnd().slice(-120)
    : text.trim()
  );

  return (
    <div className="border-l-2 border-primary/40 transition-colors">
      <button
        type="button"
        onClick={() => setExpanded((p) => !p)}
        className="flex w-full items-center gap-2 pl-3 pr-1 py-1.5 text-left text-xs cursor-pointer hover:bg-muted/20 transition-colors"
      >
        <Sparkles
          size={13}
          className="shrink-0 animate-pulse text-primary/70"
        />
        <span className="min-w-0 flex-1 truncate text-muted-foreground/70">
          {previewText || "Responding..."}
        </span>
        <ChevronRight
          size={11}
          className={`ml-auto shrink-0 text-muted-foreground/40 transition-transform ${
            expanded ? "rotate-90" : ""
          }`}
        />
      </button>

      {expanded && (
        <div className="max-h-[200px] overflow-y-auto pl-6 pr-2 pb-2 scrollbar-on-hover">
          <p className="whitespace-pre-wrap text-xs text-muted-foreground/60 leading-relaxed">
            {text}
          </p>
        </div>
      )}
    </div>
  );
}
