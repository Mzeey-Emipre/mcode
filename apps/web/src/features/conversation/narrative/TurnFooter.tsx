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
  const outcomeLabel = outcome === "cancelled"
    ? "You stopped"
    : outcome === "interrupted"
      ? "Turn interrupted"
      : outcome === "errored"
        ? "Turn failed"
        : undefined;
  const canRetry = (outcome === "interrupted" || outcome === "errored")
    && outcomeExecutionId != null
    && onRetry != null;
  const canContinue = outcome === "interrupted"
    && outcomeExecutionId != null
    && onContinue != null;
  const parts: string[] = [];
  if (counts.steps > 0) {
    parts.push(`${counts.steps} ${counts.steps === 1 ? "step" : "steps"}`);
  }
  if (counts.subagents > 0) {
    parts.push(`${counts.subagents} ${counts.subagents === 1 ? "sub-agent" : "sub-agents"}`);
  }

  if (parts.length === 0 && durationMs == null && !outcomeLabel && !canRetry && !canContinue) return null;

  return (
    <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 pl-4 font-mono uppercase text-xs tracking-[0.08em] text-muted-foreground/45">
      {outcomeLabel && (
        <span data-testid="turn-outcome" role="status" className="normal-case text-foreground/65">
          {outcomeLabel}
        </span>
      )}
      {canContinue && (
        <Button
          type="button"
          size="xs"
          variant="link"
          className="h-auto px-0 py-0 font-mono text-xs normal-case tracking-[0.08em] text-primary/75 no-underline hover:text-primary hover:no-underline"
          onClick={() => void onContinue?.()}
        >
          Continue
        </Button>
      )}
      {canRetry && (
        <Button
          type="button"
          size="xs"
          variant="link"
          className="h-auto px-0 py-0 font-mono text-xs normal-case tracking-[0.08em] text-primary/75 no-underline hover:text-primary hover:no-underline"
          onClick={() => void onRetry?.(outcomeExecutionId!)}
        >
          Retry
        </Button>
      )}
      {parts.length > 0 && <span>{parts.join(" · ")}</span>}
      <span className="flex-1 h-px bg-border/40" aria-hidden="true" />
      <span className="tabular-nums">{formatDuration(durationMs)}</span>
    </div>
  );
}
