import { useEffect, useRef, useState, type MouseEvent } from "react";
import { ArrowUp, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { PRIMARY_CONTENT_RAIL_CLASS } from "@/lib/layout-rails";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { isStickyPreviewExpandable } from "./user-message-preview";

/** Delay before a single click toggles expand, so double-click can jump instead. */
const EXPAND_CLICK_DELAY_MS = 250;

/**
 * Approximate collapsed bar height (outer chrome plus two-line preview) used to
 * reserve scroll padding before ResizeObserver reports the measured height.
 */
export const STICKY_USER_MESSAGE_ESTIMATED_HEIGHT = 56;

const STICKY_PREVIEW_HINT_ID = "sticky-user-message-preview-hint";

function getPreviewAriaLabel(expandable: boolean, expanded: boolean): string {
  if (!expandable) return "Jump to your last message in transcript";
  return expanded ? "Collapse your last message" : "Expand your last message";
}

/** Props for {@link StickyUserMessage}. */
export interface StickyUserMessageProps {
  /** Plain-text preview of the user's last visible message. */
  preview: string;
  /** When true, the chip is pinned above the scrolling transcript. */
  visible: boolean;
  /** Scrolls the transcript back to the original message bubble. */
  onJumpToMessage: () => void;
  /** Reports rendered height so the list can reserve scroll space beneath the bar. */
  onHeightChange?: (height: number) => void;
}

/**
 * Sticky chip that keeps the user's last prompt visible while they read
 * long assistant output below it in the transcript.
 */
export function StickyUserMessage({
  preview,
  visible,
  onJumpToMessage,
  onHeightChange,
}: StickyUserMessageProps) {
  const [expanded, setExpanded] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const expandClickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const expandable = isStickyPreviewExpandable(preview);

  const clearExpandClickTimer = () => {
    if (expandClickTimerRef.current) {
      clearTimeout(expandClickTimerRef.current);
      expandClickTimerRef.current = null;
    }
  };

  useEffect(() => {
    if (!visible) {
      setExpanded(false);
      clearExpandClickTimer();
      onHeightChange?.(0);
    }
  }, [visible, preview, onHeightChange]);

  useEffect(() => {
    return () => {
      if (expandClickTimerRef.current) {
        clearTimeout(expandClickTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!visible || !onHeightChange) return;
    const el = rootRef.current;
    if (!el) return;

    const reportHeight = () => {
      onHeightChange(el.offsetHeight);
    };

    reportHeight();
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(reportHeight);
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible, expanded, preview, onHeightChange]);

  const handlePreviewClick = () => {
    if (!expandable) {
      onJumpToMessage();
      return;
    }
    clearExpandClickTimer();
    expandClickTimerRef.current = setTimeout(() => {
      expandClickTimerRef.current = null;
      setExpanded((value) => !value);
    }, EXPAND_CLICK_DELAY_MS);
  };

  const handlePreviewDoubleClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    clearExpandClickTimer();
    onJumpToMessage();
  };

  const previewAriaLabel = getPreviewAriaLabel(expandable, expanded);

  if (!visible) {
    return null;
  }

  return (
    <div
      ref={rootRef}
      className="pointer-events-none absolute inset-x-0 top-0 z-10 border-b border-border/25 bg-background/90 px-4 pb-2 pt-1 backdrop-blur-sm sm:px-8"
      data-testid="sticky-user-message"
    >
      <div className={cn(PRIMARY_CONTENT_RAIL_CLASS, "min-w-0")}>
        <div className="pointer-events-auto flex items-start gap-0.5 overflow-hidden rounded-lg border border-border/60 bg-accent text-sm text-accent-foreground shadow-sm">
          <Button
            type="button"
            variant="ghost"
            onClick={handlePreviewClick}
            onDoubleClick={handlePreviewDoubleClick}
            aria-expanded={expandable ? expanded : undefined}
            aria-describedby={expandable ? STICKY_PREVIEW_HINT_ID : undefined}
            aria-label={previewAriaLabel}
            className="h-auto min-w-0 flex-1 cursor-pointer justify-start px-3 py-1.5 text-left font-normal text-accent-foreground transition-colors hover:bg-foreground/5 hover:text-accent-foreground"
          >
            <p
              className={cn(
                "break-words",
                expanded ? "max-h-40 overflow-y-auto whitespace-pre-wrap" : "line-clamp-2",
              )}
            >
              {preview}
            </p>
            {expandable && (
              <>
                <span
                  id={STICKY_PREVIEW_HINT_ID}
                  className="sr-only"
                >
                  Double-click to jump to your message in the transcript
                </span>
                <span
                  aria-hidden
                  className="mt-1 inline-flex items-center gap-0.5 font-mono text-xs uppercase tracking-[0.14em] text-muted-foreground"
                >
                  <ChevronDown
                    size={11}
                    aria-hidden
                    className={cn("transition-transform duration-150", expanded && "rotate-180")}
                  />
                  {expanded ? "Collapse" : "Expand"}
                  {!expanded && (
                    <span className="normal-case tracking-normal text-muted-foreground/70">
                      · Double-click to jump
                    </span>
                  )}
                </span>
              </>
            )}
          </Button>

          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={onJumpToMessage}
                  className="mt-0.5 mr-0.5 size-11 shrink-0 text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
                  aria-label="Jump to your last message"
                >
                  <ArrowUp size={15} aria-hidden />
                </Button>
              }
            />
            <TooltipContent side="bottom" sideOffset={6} className="text-xs">
              Jump to message
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
