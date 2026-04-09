import { useState, useRef, useEffect } from "react";
import { Github, ChevronDown, GitPullRequest } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Props for {@link PrSplitButton}. */
interface PrSplitButtonProps {
  /** Null when no PR exists for this branch. */
  pr: { number: number; url: string; state: "OPEN" | "MERGED" | "CLOSED" | string } | null;
  /** Null while the initial commits-ahead poll is in flight. */
  hasCommitsAhead: boolean | null;
  /** Called when the user wants to open CreatePrDialog. */
  onCreatePr: () => void;
  /** Called with the PR URL when the user wants to open it in the browser. */
  onOpenPr: (url: string) => void;
}

/**
 * Split button for PR actions in the chat header.
 * When no PR exists, renders a "Create PR" button (disabled until commits are detected).
 * When a PR exists, renders a primary action button coloured by state plus an optional
 * chevron that opens a dropdown for secondary actions (merged/closed only).
 */
export function PrSplitButton({ pr, hasCommitsAhead, onCreatePr, onOpenPr }: PrSplitButtonProps) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close dropdown on click outside
  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [dropdownOpen]);

  // No PR — show Create PR button
  if (!pr) {
    return (
      <Button
        variant="ghost"
        size="xs"
        className="gap-1 text-xs text-foreground/70 hover:text-foreground hover:bg-muted/40 h-6"
        onClick={onCreatePr}
        disabled={!hasCommitsAhead}
        title={hasCommitsAhead === false ? "No commits ahead of base branch" : undefined}
      >
        <GitPullRequest size={12} />
        <span>Create PR</span>
      </Button>
    );
  }

  const state = pr.state.toLowerCase();

  const stateColour =
    state === "merged"
      ? "text-[#a371f7] hover:text-[#bc8fff]"
      : state === "closed"
        ? "text-[#f85149] hover:text-[#ff6b63]"
        : "text-[#3fb950] hover:text-[#5ee375]";

  const label =
    state === "merged"
      ? `PR #${pr.number} merged`
      : state === "closed"
        ? `PR #${pr.number} closed`
        : `View PR #${pr.number}`;

  const showChevron = state === "merged" || state === "closed";

  return (
    <div ref={containerRef} className="relative inline-flex">
      <div className="inline-flex rounded">
        {/* Primary action */}
        <button
          className={`inline-flex items-center gap-1.5 px-2 h-6 text-xs bg-muted/10 hover:bg-muted/20 transition-colors ${stateColour}`}
          onClick={() => onOpenPr(pr.url)}
        >
          <Github size={12} className="opacity-80 flex-shrink-0" />
          <span>{label}</span>
        </button>

        {/* Chevron — only for merged/closed */}
        {showChevron && (
          <button
            aria-label="Open PR menu"
            className={`inline-flex items-center px-1.5 h-6 text-xs bg-muted/10 hover:bg-muted/20 border-l border-border/20 transition-colors ${stateColour}`}
            onClick={() => setDropdownOpen((o) => !o)}
          >
            <ChevronDown
              size={11}
              className={`transition-transform duration-150 ${dropdownOpen ? "rotate-180" : ""}`}
            />
          </button>
        )}
      </div>

      {/* Dropdown */}
      {dropdownOpen && (
        <div className="absolute top-full left-0 mt-1 z-50 min-w-[170px] rounded-md border border-border/50 bg-popover shadow-md py-1 animate-in fade-in-0 zoom-in-95">
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-foreground/70 hover:text-foreground hover:bg-muted/40 flex items-center gap-2 transition-colors"
            onClick={() => {
              onOpenPr(pr.url);
              setDropdownOpen(false);
            }}
          >
            <Github size={11} className="opacity-75 flex-shrink-0" />
            View on GitHub ↗
          </button>
          <div className="my-1 border-t border-border/30" />
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-foreground/70 hover:text-foreground hover:bg-muted/40 flex items-center gap-2 transition-colors"
            onClick={() => {
              onCreatePr();
              setDropdownOpen(false);
            }}
          >
            <GitPullRequest size={11} className="opacity-75 flex-shrink-0" />
            Create new PR
          </button>
        </div>
      )}
    </div>
  );
}
