import { CircleCheck, CircleX, Loader2, type LucideIcon } from "lucide-react";
import type { ChecksStatus, CheckRun } from "@mcode/contracts";

/**
 * Shared stroke-width for CI icons across every surface (chip, button, popover).
 * Kept in one place so glyph weight doesn't drift between components.
 */
export const CI_ICON_STROKE = 2.25;

/** Visual properties for a CI aggregate state. */
export interface CiVisual {
  icon: LucideIcon;
  /** Foreground color class. */
  color: string;
  /** Border color class, used in accent chrome. */
  borderColor: string;
  /** Subtle background wash for chrome (pill, rail). */
  surface: string;
  /**
   * Combined tinted-chrome class (foreground + surface + border), for pills/chips/buttons
   * where all three should move together. Consumers should prefer this over
   * re-deriving the ternary locally.
   */
  chromeClass: string;
  /**
   * Hover wash class, paired with `chromeClass`. Kept separate so consumers can
   * opt out of hover (chips, static pills) without dropping the base chrome.
   */
  hoverSurface: string;
  /** Human-readable headline for tooltips. */
  label: string;
}

/** Maps an aggregate CI status to icon, color, and label. */
export function getCiVisual(aggregate: ChecksStatus["aggregate"]): CiVisual {
  switch (aggregate) {
    case "passing":
      return {
        icon: CircleCheck,
        color: "text-emerald-600 dark:text-emerald-400",
        borderColor: "border-emerald-500/30",
        surface: "bg-emerald-500/10",
        chromeClass:
          "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/25",
        hoverSurface: "hover:bg-emerald-500/15",
        label: "Checks passing",
      };
    case "failing":
      return {
        icon: CircleX,
        color: "text-rose-500",
        borderColor: "border-rose-500/35",
        surface: "bg-rose-500/10",
        chromeClass: "text-rose-500 bg-rose-500/10 border-rose-500/25",
        hoverSurface: "hover:bg-rose-500/15",
        label: "Checks failing",
      };
    case "pending":
      return {
        icon: Loader2,
        color: "text-amber-600 dark:text-amber-400",
        borderColor: "border-amber-500/35",
        surface: "bg-amber-500/10",
        chromeClass:
          "text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/25",
        hoverSurface: "hover:bg-amber-500/15",
        label: "Checks running",
      };
    case "no_checks":
      return {
        icon: CircleCheck,
        color: "text-muted-foreground",
        borderColor: "border-border",
        surface: "bg-muted/30",
        chromeClass: "text-muted-foreground bg-muted/20 border-border",
        hoverSurface: "hover:bg-muted/30",
        label: "No checks",
      };
  }
}

/** Counts of check runs bucketed by state, used for progress rails and headlines. */
export interface CheckBreakdown {
  total: number;
  passing: number;
  failing: number;
  running: number;
  /** Neutral / cancelled / skipped. */
  other: number;
}

/** Bucket every run into one of {passing, failing, running, other}. */
export function getBreakdown(checks: ChecksStatus): CheckBreakdown {
  const b: CheckBreakdown = { total: checks.runs.length, passing: 0, failing: 0, running: 0, other: 0 };
  for (const r of checks.runs) {
    if (r.status !== "completed") {
      b.running += 1;
      continue;
    }
    switch (r.conclusion) {
      case "success":
        b.passing += 1;
        break;
      case "failure":
      case "timed_out":
        b.failing += 1;
        break;
      default:
        b.other += 1;
    }
  }
  return b;
}

/**
 * Short inline headline for the PR button, e.g. "2/5 done" (running) or "1 failing".
 * Returns null when there's nothing worth surfacing inline.
 *
 * Running format includes "done" so the fraction reads unambiguously as
 * completed/total rather than "2 passing of 5."
 */
export function getInlineHeadline(checks: ChecksStatus): string | null {
  const b = getBreakdown(checks);
  if (b.total === 0) return null;
  if (b.failing > 0) return b.failing === 1 ? "1 failing" : `${b.failing} failing`;
  if (b.running > 0) return `${b.total - b.running}/${b.total} done`;
  if (b.passing === b.total) return `${b.total} passing`;
  return null;
}

/** Find the first still-running check, for "currently running: lint" microcopy. */
export function getLeadRunningName(checks: ChecksStatus): string | null {
  const running = checks.runs.find((r: CheckRun) => r.status !== "completed");
  return running?.name ?? null;
}

/** Find the first failing check, for "lint failing" microcopy when aggregate is failing. */
export function getLeadFailingName(checks: ChecksStatus): string | null {
  const failing = checks.runs.find(
    (r: CheckRun) => r.conclusion === "failure" || r.conclusion === "timed_out",
  );
  return failing?.name ?? null;
}
