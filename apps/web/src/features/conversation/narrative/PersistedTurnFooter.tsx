import { useEffect, useMemo, useRef } from "react";
import { useThreadStore } from "@/stores/threadStore";
import { useThreadRecord } from "@/stores/thread-selectors";
import type { ThoughtSegmentRecord, ToolCallRecord } from "@/transport/types";
import { TurnFooter } from "./TurnFooter";
import { collapseSubagentRecords } from "./subagent-lifecycle";
import type { NarrativeCounts, TurnFooterSummary } from "./types";

interface PersistedTimeBoundary {
  startedAt: string;
  endedAt: string | null;
}

interface PersistedFooterRecords {
  tools: readonly ToolCallRecord[];
  thoughts: readonly ThoughtSegmentRecord[];
}

function persistedCounts(records: PersistedFooterRecords): NarrativeCounts {
  const topLevel = collapseSubagentRecords(records.tools)
    .filter((tool) => tool.parent_tool_call_id == null);
  return {
    steps: topLevel.length,
    thoughts: records.thoughts.length,
    subagents: topLevel.filter((tool) => tool.tool_name === "Agent").length,
  };
}

function toolTimeBoundary(tool: ToolCallRecord): PersistedTimeBoundary {
  return { startedAt: tool.started_at, endedAt: tool.completed_at };
}

function thoughtTimeBoundary(thought: ThoughtSegmentRecord): PersistedTimeBoundary {
  return { startedAt: thought.started_at, endedAt: thought.ended_at };
}

function parseTimestamp(value: string | null): number | null {
  const timestamp = value === null ? Number.NaN : Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function validTimestamps(values: readonly (string | null)[]): number[] {
  return values.map(parseTimestamp).filter((value): value is number => value !== null);
}

function persistedDurationMs(records: PersistedFooterRecords): number | null {
  const boundaries = [
    ...records.tools.map(toolTimeBoundary),
    ...records.thoughts.map(thoughtTimeBoundary),
  ];
  const starts = validTimestamps(boundaries.map((boundary) => boundary.startedAt));
  const ends = validTimestamps(boundaries.map((boundary) => boundary.endedAt));
  if (starts.length === 0 || ends.length === 0) return null;
  return Math.max(0, Math.max(...ends) - Math.min(...starts));
}

function persistedFooterSummary(records: PersistedFooterRecords): TurnFooterSummary {
  return {
    counts: persistedCounts(records),
    durationMs: persistedDurationMs(records),
  };
}

function isEmptyLegacyFooter(summary: TurnFooterSummary): boolean {
  return summary.counts.steps === 0
    && summary.counts.subagents === 0
    && summary.outcome == null;
}

/** Props for {@link PersistedTurnFooter}. */
export interface PersistedTurnFooterProps {
  /** Thread whose resident narrative cache owns this assistant message. */
  threadId?: string | null;
  /** Assistant message id this footer belongs to. */
  messageId: string;
  /** Canonical summary used when this message has no legacy narrative cache. */
  summary?: TurnFooterSummary;
  /** Prefills the existing composer with `Continue` for an interrupted turn. */
  onContinue?: () => void | Promise<void>;
  /** Calls the existing retry command with the summary's exact execution ID. */
  onRetry?: (executionId: string) => void | Promise<void>;
}

/**
 * Compact step / sub-agent / duration summary rendered AFTER the assistant
 * message body to close out a completed turn.
 *
 * The earlier design placed the footer between the persisted narrative
 * timeline and the message bubble — that separated the agent's actions from
 * the answer they led to. Putting the footer at the end keeps the reading
 * order: actions → response → wrap-up.
 *
 * Uses a supplied canonical summary or lazily loads the same narrative records
 * as `PersistedNarrative` through the threadStore cache.
 */
export function PersistedTurnFooter({
  threadId,
  messageId,
  summary,
  onContinue,
  onRetry,
}: PersistedTurnFooterProps) {
  const records = useThreadRecord(threadId, (r) => r.narrativeByMessage[messageId]);
  const load = useThreadStore((s) => s.loadNarrativeForMessage);
  const triggered = useRef(false);

  useEffect(() => {
    if (summary || records || triggered.current) return;
    triggered.current = true;
    void load(messageId, threadId ?? undefined);
  }, [messageId, records, load, summary, threadId]);

  const persistedSummary = useMemo<TurnFooterSummary | null>(
    () => (records ? persistedFooterSummary(records) : null),
    [records],
  );

  const resolvedSummary = summary ?? persistedSummary;
  if (!resolvedSummary) return null;
  // Legacy narrative rows do not establish a complete turn boundary. A
  // canonical summary does, so its elapsed time still closes a tool-free turn.
  if (!summary && isEmptyLegacyFooter(resolvedSummary)) return null;

  return (
    <TurnFooter
      counts={resolvedSummary.counts}
      durationMs={resolvedSummary.durationMs}
      outcome={resolvedSummary.outcome}
      outcomeExecutionId={resolvedSummary.outcomeExecutionId}
      onContinue={onContinue}
      onRetry={onRetry}
    />
  );
}
