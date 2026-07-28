import { formatDuration as formatElapsedSeconds } from "@/lib/time";
import type { NarrativeCounts } from "./types";

/** Props for {@link TurnFooter}. */
interface TurnFooterProps {
  counts: NarrativeCounts;
  /** Total elapsed time for the turn in milliseconds. */
  durationMs: number | null;
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
export function TurnFooter({ counts, durationMs }: TurnFooterProps) {
  const parts: string[] = [];
  if (counts.steps > 0) {
    parts.push(`${counts.steps} ${counts.steps === 1 ? "step" : "steps"}`);
  }
  if (counts.subagents > 0) {
    parts.push(`${counts.subagents} ${counts.subagents === 1 ? "sub-agent" : "sub-agents"}`);
  }

  if (parts.length === 0 && durationMs == null) return null;

  return (
    <div className="mt-2 flex items-baseline gap-3 pl-4 font-mono uppercase text-xs tracking-[0.08em] text-muted-foreground/45">
      {parts.length > 0 && <span>{parts.join(" · ")}</span>}
      <span className="flex-1 h-px bg-border/40" aria-hidden="true" />
      <span className="tabular-nums">{formatDuration(durationMs)}</span>
    </div>
  );
}
