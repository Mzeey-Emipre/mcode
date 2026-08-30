import { formatDuration as formatElapsedSeconds } from "@/lib/time";
import { Button } from "@/components/ui/button";
import type { TurnOutcome } from "@mcode/contracts";
import type { NarrativeCounts } from "./types";

/** Props for {@link TurnFooter}. */
export interface TurnFooterProps {
  counts: NarrativeCounts;
  /** Total elapsed time for the turn in milliseconds. */
  durationMs: number | null;
  /** Explicit terminal outcome. Missing outcomes stay visually unlabeled. */
  outcome?: TurnOutcome | null;
  /** Exact execution identity for the existing retry command. */
  outcomeExecutionId?: string | null;
  /** Prefills the existing composer with `Continue`. */
  onContinue?: () => void | Promise<void>;
  /** Calls the existing retry command for the exact execution identity. */
  onRetry?: (executionId: string) => void | Promise<void>;
}

/**
 * Formats an elapsed duration as a compact human string.
 *
 * Examples: `342ms` (sub-second), `12.7s` (single seconds), `1m 04s` (longer).
 * Returns `—` if duration is null or negative.
 */
function formatDuration(ms: number | null): string {
  if (ms == null || ms < 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  const totalSec = ms / 1000;
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
  return formatElapsedSeconds(Math.floor(totalSec));
}

interface FooterAction {
  label: "Continue" | "Retry";
  onClick: () => void | Promise<void>;
}

function outcomeLabel(outcome: TurnOutcome | null | undefined): string | undefined {
  const labels: Partial<Record<TurnOutcome, string>> = {
    cancelled: "You stopped",
    interrupted: "Turn interrupted",
    errored: "Turn failed",
  };
  return outcome == null ? undefined : labels[outcome];
}

function continueAction(
  outcome: TurnOutcome | null | undefined,
  executionId: string | null | undefined,
  onContinue: TurnFooterProps["onContinue"],
): FooterAction | undefined {
  if (outcome !== "interrupted") return undefined;
  if (executionId == null || onContinue == null) return undefined;
  return { label: "Continue", onClick: onContinue };
}

function retryAction(
  outcome: TurnOutcome | null | undefined,
  executionId: string | null | undefined,
  onRetry: TurnFooterProps["onRetry"],
): FooterAction | undefined {
  if (outcome !== "interrupted" && outcome !== "errored") return undefined;
  if (executionId == null || onRetry == null) return undefined;
  return { label: "Retry", onClick: () => onRetry(executionId) };
}

function isDefined<Value>(value: Value | undefined): value is Value {
  return value !== undefined;
}

function footerActions(
  outcome: TurnOutcome | null | undefined,
  executionId: string | null | undefined,
  onContinue: TurnFooterProps["onContinue"],
  onRetry: TurnFooterProps["onRetry"],
): FooterAction[] {
  return [
    continueAction(outcome, executionId, onContinue),
    retryAction(outcome, executionId, onRetry),
  ].filter(isDefined);
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
  actions: readonly FooterAction[],
): boolean {
  return labels.length > 0 || durationMs != null || label !== undefined || actions.length > 0;
}

function TurnFooterStatus({ label }: { label: string | undefined }) {
  if (label === undefined) return null;

  return (
    <span data-testid="turn-outcome" role="status" className="normal-case text-foreground/65">
      {label}
    </span>
  );
}

function TurnFooterActions({ actions }: { actions: readonly FooterAction[] }) {
  return actions.map((action) => (
    <Button
      key={action.label}
      type="button"
      size="xs"
      variant="link"
      className="h-auto px-0 py-0 font-mono text-xs normal-case tracking-[0.08em] text-primary/75 no-underline hover:text-primary hover:no-underline"
      onClick={() => void action.onClick()}
    >
      {action.label}
    </Button>
  ));
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
  outcomeExecutionId,
  onContinue,
  onRetry,
}: TurnFooterProps) {
  const label = outcomeLabel(outcome);
  const actions = footerActions(outcome, outcomeExecutionId, onContinue, onRetry);
  const labels = countLabels(counts);
  if (!hasFooterContent(labels, durationMs, label, actions)) return null;

  return (
    <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 pl-4 font-mono uppercase text-xs tracking-[0.08em] text-muted-foreground/45">
      <TurnFooterStatus label={label} />
      <TurnFooterActions actions={actions} />
      <TurnFooterCounts labels={labels} />
      <span className="flex-1 h-px bg-border/40" aria-hidden="true" />
      <span className="tabular-nums">{formatDuration(durationMs)}</span>
    </div>
  );
}
