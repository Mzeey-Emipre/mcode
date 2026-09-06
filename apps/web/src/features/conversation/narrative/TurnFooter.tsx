import { formatDurationMs } from "@/lib/time";
import type { ApprovalReviewMode, TurnOutcome } from "@mcode/contracts";
import type { NarrativeCounts } from "./types";

/** Props for {@link TurnFooter}. */
export interface TurnFooterProps {
  counts: NarrativeCounts;
  /** Total elapsed time for the turn in milliseconds. */
  durationMs: number | null;
  /** Explicit terminal outcome. Missing outcomes stay visually unlabeled. */
  outcome?: TurnOutcome | null;
  /** Frozen review decision that applied to this turn. */
  approvalReview?: { mode: ApprovalReviewMode; reason: string };
}

function outcomeLabel(outcome: TurnOutcome | null | undefined): string | undefined {
  const labels: Partial<Record<TurnOutcome, string>> = {
    cancelled: "You stopped",
    interrupted: "Turn interrupted",
    errored: "Turn failed",
  };
  return outcome == null ? undefined : labels[outcome];
}

function countLabels(counts: NarrativeCounts): string[] {
  const labels: string[] = [];
  if (counts.steps > 0) {
    labels.push(`${counts.steps} ${counts.steps === 1 ? "step" : "steps"}`);
  }
  if (counts.subagents > 0) {
    labels.push(`${counts.subagents} ${counts.subagents === 1 ? "sub-agent" : "sub-agents"}`);
  }
  return labels;
}

function hasFooterContent(
  labels: readonly string[],
  durationMs: number | null,
  label: string | undefined,
  approvalReview: TurnFooterProps["approvalReview"],
): boolean {
  return labels.length > 0 || durationMs != null || label !== undefined || approvalReview !== undefined;
}

function TurnFooterStatus({ label }: { label: string | undefined }) {
  if (label === undefined) return null;

  return (
    <span data-testid="turn-outcome" role="status" className="normal-case text-foreground/65">
      {label}
    </span>
  );
}

function ApprovalReviewStatus({ approvalReview }: { approvalReview: TurnFooterProps["approvalReview"] }) {
  if (!approvalReview) return null;
  return <span data-testid="approval-review">{approvalReviewLabel(approvalReview)}</span>;
}

function approvalReviewLabel({ mode, reason }: NonNullable<TurnFooterProps["approvalReview"]>): string {
  if (reason === "experimental-api-enabled") return "Automatic approval review selected.";
  if (reason === "manual-requested") return "Manual approval selected.";
  if (mode === "manual") return "Automatic review unavailable. Manual approval applies.";
  return mode === "automatic" ? "Automatic approval review selected." : "Manual approval selected.";
}

function TurnFooterCounts({ labels }: { labels: readonly string[] }) {
  if (labels.length === 0) return null;
  return <span>{labels.join(" · ")}</span>;
}

/**
 * Compact meta line shown between the narrative timeline and the final
 * assistant message after the turn completes.
 *
 * Reads: `7 steps · 1 sub-agent ——— 14.3s`. Items with zero counts are
 * omitted. The hairline rule fills the gap between the labels and the
 * duration.
 *
 * `counts.thoughts` is computed but no longer surfaced — the legacy
 * "thoughts" tally counted preamble text blocks that are now rendered as
 * agent response prose, so labelling them as thoughts would mislead. The
 * field is preserved on `NarrativeCounts` for the day extended `thinking`
 * blocks land, at which point a real "N thinking" count can be reinstated
 * here against that source.
 */
export function TurnFooter({
  counts,
  durationMs,
  outcome,
  approvalReview,
}: TurnFooterProps) {
  const label = outcomeLabel(outcome);
  const labels = countLabels(counts);
  const visibleApprovalReview = approvalReview?.reason === "full-access-bypasses-approval-review"
    ? undefined
    : approvalReview;
  if (!hasFooterContent(labels, durationMs, label, visibleApprovalReview)) return null;

  return (
    <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 pl-4 font-mono uppercase text-xs tracking-[0.08em] text-muted-foreground/45">
      <TurnFooterStatus label={label} />
      <ApprovalReviewStatus approvalReview={visibleApprovalReview} />
      <TurnFooterCounts labels={labels} />
      <span className="flex-1 h-px bg-border/40" aria-hidden="true" />
      <span className="tabular-nums">{formatDurationMs(durationMs)}</span>
    </div>
  );
}
