import { useEffect, useMemo, useRef } from "react";
import { useThreadStore } from "@/stores/threadStore";
import { useThreadRecord } from "@/stores/thread-selectors";
import { TurnFooter } from "./TurnFooter";
import type { NarrativeCounts, TurnFooterSummary } from "./types";

/** Props for {@link PersistedTurnFooter}. */
export interface PersistedTurnFooterProps {
  /** Thread whose resident narrative cache owns this assistant message. */
  threadId?: string | null;
  /** Assistant message id this footer belongs to. */
  messageId: string;
  /** Canonical summary used when this message has no legacy narrative cache. */
  summary?: TurnFooterSummary;
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
export function PersistedTurnFooter({ threadId, messageId, summary }: PersistedTurnFooterProps) {
  const records = useThreadRecord(threadId, (r) => r.narrativeByMessage[messageId]);
  const load = useThreadStore((s) => s.loadNarrativeForMessage);
  const triggered = useRef(false);

  useEffect(() => {
    if (summary || records || triggered.current) return;
    triggered.current = true;
    void load(messageId, threadId ?? undefined);
  }, [messageId, records, load, summary, threadId]);

  const persistedSummary = useMemo(() => {
    if (!records) return null;
    const topLevel = records.tools.filter((t) => t.parent_tool_call_id == null);
    const counts: NarrativeCounts = {
      steps: topLevel.length,
      thoughts: records.thoughts.length,
      subagents: topLevel.filter((t) => t.tool_name === "Agent").length,
    };
    // Derive duration from the earliest start to the latest completion across
    // tools and thoughts. Null when no boundary is parseable.
    const starts: number[] = [];
    const ends: number[] = [];
    for (const t of records.tools) {
      const s = Date.parse(t.started_at);
      if (Number.isFinite(s)) starts.push(s);
      if (t.completed_at) {
        const e = Date.parse(t.completed_at);
        if (Number.isFinite(e)) ends.push(e);
      }
    }
    for (const th of records.thoughts) {
      const s = Date.parse(th.started_at);
      if (Number.isFinite(s)) starts.push(s);
      if (th.ended_at) {
        const e = Date.parse(th.ended_at);
        if (Number.isFinite(e)) ends.push(e);
      }
    }
    const durationMs =
      starts.length > 0 && ends.length > 0
        ? Math.max(0, Math.max(...ends) - Math.min(...starts))
        : null;
    return { counts, durationMs };
  }, [records]);

  const resolvedSummary = summary ?? persistedSummary;
  if (!resolvedSummary) return null;
  // Legacy narrative rows do not establish a complete turn boundary. A
  // canonical summary does, so its elapsed time still closes a tool-free turn.
  if (
    !summary
    && resolvedSummary.counts.steps === 0
    && resolvedSummary.counts.subagents === 0
  ) return null;

  return <TurnFooter counts={resolvedSummary.counts} durationMs={resolvedSummary.durationMs} />;
}
