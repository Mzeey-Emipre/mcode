import { useState, useRef, useEffect } from "react";
import { Github, ChevronDown, GitPullRequest } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ChecksPopover } from "./ChecksPopover";
import {
  getBreakdown,
  getInlineHeadline,
  getLeadFailingName,
  getCiVisual,
  CI_ICON_STROKE,
} from "@/lib/ci-status";
import { registerCommand } from "@/lib/command-registry";
import type { ChecksStatus } from "@mcode/contracts";

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
  /** CI check status for this thread, if available. */
  checks?: ChecksStatus | null;
  /** Thread ID for manual refresh via ChecksPopover. */
  threadId?: string;
  /** PR title shown in ChecksPopover header. */
  prTitle?: string;
  /** PR author shown in ChecksPopover header. */
  prAuthor?: string;
}

/** Compact segmented progress pills showing pass / fail / running / pending slots. */
function ProgressPills({ checks }: { checks: ChecksStatus }) {
  const b = getBreakdown(checks);
  if (b.total === 0) return null;

  // Cap rendered pills at 5 so the chat header stays compact even when a PR has 20+ jobs.
  // A +N badge indicates the overflow.
  const MAX_PILLS = 5;
  const capped = b.total > MAX_PILLS;
  const renderTotal = capped ? MAX_PILLS : b.total;

  // Build the visible pill list: failing first, then running, then passing, then other.
  type Slot = "fail" | "run" | "pass" | "other";
  const slots: Slot[] = [];
  for (let i = 0; i < b.failing; i++) slots.push("fail");
  for (let i = 0; i < b.running; i++) slots.push("run");
  for (let i = 0; i < b.passing; i++) slots.push("pass");
  for (let i = 0; i < b.other; i++) slots.push("other");
  const visible = slots.slice(0, renderTotal);

  return (
    <span className="inline-flex items-center gap-[3px]">
      {visible.map((slot, i) => (
        <span
          key={i}
          className={cn(
            "h-[5px] w-[5px] rounded-full transition-colors",
            slot === "fail" && "bg-[var(--diff-remove-strong)]",
            slot === "run" && "bg-primary motion-safe:animate-pulse",
            slot === "pass" && "bg-[var(--diff-add-strong)]",
            slot === "other" && "bg-muted-foreground/40",
          )}
        />
      ))}
      {capped && (
        <span className="text-[10px] text-muted-foreground tabular-nums ml-0.5">
          +{b.total - MAX_PILLS}
        </span>
      )}
    </span>
  );
}

/**
 * Split button for PR actions in the chat header.
 *
 * Three layouts depending on PR state:
 * - No PR → "Create PR" button (disabled until commits land)
 * - Open PR with checks → primary button wraps ChecksPopover, shows inline progress pills
 *   + headline (e.g. "2/5" running, "1 failing", "5 passing"), themed by CI aggregate
 * - Merged / closed PR → coloured primary + chevron with secondary actions
 */
export function PrSplitButton({ pr, hasCommitsAhead, onCreatePr, onOpenPr, checks, threadId, prTitle, prAuthor }: PrSplitButtonProps) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [checksOpen, setChecksOpen] = useState(false);
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

  // Register a global command to open the checks popover for the active thread.
  // Only the PrSplitButton currently mounted for the active thread has real checks
  // data, so a single registration here naturally targets the right PR.
  const canOpenChecks =
    pr != null &&
    pr.state.toLowerCase() === "open" &&
    checks != null &&
    checks.aggregate !== "no_checks" &&
    threadId != null;
  useEffect(() => {
    if (!canOpenChecks) return;
    const dispose = registerCommand({
      id: "checks.open",
      title: "Open CI checks for active thread",
      category: "Git",
      handler: () => setChecksOpen(true),
    });
    return dispose;
  }, [canOpenChecks]);

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
  const isOpen = state === "open";
  const hasChecksData = checks != null && checks.aggregate !== "no_checks" && isOpen;
  const aggregate = hasChecksData ? checks!.aggregate : null;
  const inlineHeadline = hasChecksData ? getInlineHeadline(checks!) : null;
  const leadFailing = aggregate === "failing" ? getLeadFailingName(checks!) : null;

  // Single chrome derivation: CI visual when we have data, otherwise state-based accent.
  // `chromeClass` + `hoverSurface` both come from `getCiVisual` so base and hover
  // washes stay tuned to each other — no more drift if one opacity is adjusted.
  const ciVisual = hasChecksData ? getCiVisual(aggregate!) : null;

  const mergedClosedAccent = state === "merged"
    ? "text-primary/70 hover:text-primary bg-muted/10 hover:bg-muted/20"
    : state === "closed"
      ? "text-destructive/70 hover:text-destructive bg-muted/10 hover:bg-muted/20"
      : null;

  const openNoCiAccent = isOpen && !hasChecksData
    ? "text-[var(--diff-add-strong)]/85 hover:text-[var(--diff-add-strong)] bg-muted/10 hover:bg-muted/20"
    : null;

  const chromeClass = ciVisual
    ? `${ciVisual.chromeClass} ${ciVisual.hoverSurface}`
    : mergedClosedAccent ?? openNoCiAccent ?? "bg-muted/10 hover:bg-muted/20";

  // Keep state-terminal suffix in the label text ("merged"/"closed") so the button reads
  // correctly even when colour alone is ambiguous. Open PRs drop the suffix — the CI rail
  // carries the live state signal there.
  const label = state === "merged"
    ? `PR #${pr.number} merged`
    : state === "closed"
      ? `PR #${pr.number} closed`
      : `PR #${pr.number}`;

  const showChevron = state === "merged" || state === "closed";
  const usePopover = hasChecksData && threadId != null;

  // Tiny status-icon shown as part of the CI rail when CI is active — sourced from the
  // shared CI visual so chip/button/popover use identical glyphs.
  const LeadIcon = ciVisual?.icon ?? null;

  const titleAttr = aggregate === "failing" && leadFailing
    ? `${leadFailing} failing`
    : aggregate === "pending"
      ? "Checks running"
      : aggregate === "passing"
        ? "All checks passing"
        : state === "merged"
          ? "Pull request merged"
          : state === "closed"
            ? "Pull request closed"
            : "Pull request open";

  const primaryButton = (
    <button
      type="button"
      className={cn(
        "relative inline-flex items-center gap-1.5 px-2 h-6 rounded-l text-xs transition-colors border border-transparent",
        "font-medium tabular-nums",
        chromeClass,
        aggregate === "pending" && "border-primary/25",
        !showChevron && "rounded-r",
      )}
      title={titleAttr}
      onClick={usePopover ? undefined : () => onOpenPr(pr.url)}
    >
      <Github size={12} className="opacity-70 shrink-0" />
      <span className="text-foreground/85">{label}</span>

      {/* CI rail: divider · icon · pills · headline. Only when open + has data. */}
      {hasChecksData && (
        <span className="inline-flex items-center gap-1.5 pl-1.5 ml-0.5 border-l border-current/15">
          {LeadIcon && (
            <LeadIcon
              size={11}
              className={cn(
                "shrink-0",
                aggregate === "pending" && "motion-safe:animate-spin",
              )}
              strokeWidth={CI_ICON_STROKE}
            />
          )}
          <ProgressPills checks={checks!} />
          {inlineHeadline && (
            <span className="text-[11px] opacity-85 whitespace-nowrap">
              {inlineHeadline}
            </span>
          )}
        </span>
      )}

      {/* Indeterminate bottom-edge progress strip when running.
       * Wrapped in motion-safe so reduced-motion users don't see a stationary
       * partial bar (which would look like a broken progress indicator).
       * The Loader icon already conveys pending state without motion. */}
      {aggregate === "pending" && (
        <span
          aria-hidden
          className="absolute inset-x-1 bottom-0 h-[1.5px] overflow-hidden rounded-full motion-reduce:hidden"
        >
          <span className="block h-full w-1/3 bg-primary/80 animate-ci-slide" />
        </span>
      )}
    </button>
  );

  return (
    <div ref={containerRef} className="relative inline-flex">
      <div className="inline-flex rounded">
        {usePopover ? (
          <ChecksPopover
            threadId={threadId!}
            prUrl={pr.url}
            prTitle={prTitle}
            prAuthor={prAuthor}
            checks={checks!}
            open={checksOpen}
            onOpenChange={setChecksOpen}
          >
            {primaryButton}
          </ChecksPopover>
        ) : (
          primaryButton
        )}

        {showChevron && (
          <button
            aria-label="Open PR menu"
            className={cn(
              "inline-flex items-center px-1.5 h-6 text-xs border-l border-border/20 rounded-r transition-colors",
              mergedClosedAccent ?? "bg-muted/10 hover:bg-muted/20",
            )}
            onClick={() => setDropdownOpen((o) => !o)}
          >
            <ChevronDown
              size={11}
              className={cn("transition-transform duration-150", dropdownOpen && "rotate-180")}
            />
          </button>
        )}
      </div>

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
