import { useState, useMemo } from "react";
import { ChevronRight, Sparkles } from "lucide-react";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";

/** Max characters shown in the collapsed preview when the last line is empty. */
const PREVIEW_FALLBACK_LENGTH = 120;

/** Props for the StreamingCard component. */
interface StreamingCardProps {
  /** Accumulated streaming text from textDelta events. */
  text: string;
}

/**
 * Collapsible card that displays live streaming response text.
 * Collapsed (default): shows a single-line live preview with a chevron toggle.
 * Expanded: shows the full accumulated text in a scrollable area.
 * Uses Radix Collapsible for proper aria-expanded and focus handling.
 * All text is rendered as safe React text nodes - no raw HTML injection.
 */
export function StreamingCard({ text }: StreamingCardProps) {
  const [expanded, setExpanded] = useState(false);

  const previewText = useMemo(() => {
    const lastNewline = text.lastIndexOf("\n");
    const lastLine = lastNewline >= 0 ? text.slice(lastNewline + 1).trim() : text.trim();
    return lastLine || text.trimEnd().slice(-PREVIEW_FALLBACK_LENGTH);
  }, [text]);

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded} asChild>
      <div className="border-l-2 border-primary/40 transition-colors">
        <CollapsibleTrigger asChild>
          <button
            type="button"
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
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="max-h-[200px] overflow-y-auto pl-6 pr-2 pb-2 scrollbar-on-hover">
            <p className="whitespace-pre-wrap text-xs text-muted-foreground/60 leading-relaxed">
              {text}
            </p>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
