import { useEffect, useMemo, useRef } from "react";
import { useThreadStore } from "@/stores/threadStore";
import { useActiveThreadRecord } from "@/stores/thread-selectors";
import { TurnFooter } from "./TurnFooter";
import type { NarrativeCounts } from "./types";

/** Props for {@link PersistedTurnFooter}. */
export interface PersistedTurnFooterProps {
  /** Assistant message id this footer belongs to. */
  messageId: string;
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
 * Lazy-loads the same narrative records as `PersistedNarrative` via the
 * threadStore cache. Returns `null` until records arrive so the layout does
 * not jump.
 */
export function PersistedTurnFooter({ messageId }: PersistedTurnFooterProps) {
  const records = useActiveThreadRecord((r) => r.narrativeByMessage[messageId]);
  const load = useThreadStore((s) => s.loadNarrativeForMessage);
  const triggered = useRef(false);

  useEffect(() => {
    if (records || triggered.current) return;
    triggered.current = true;
    void load(messageId);
  }, [messageId, records, load]);

  const summary = useMemo(() => {
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

  if (!records || !summary) return null;
  // Suppress entirely when the turn had zero structured activity.
  if (summary.counts.steps === 0 && summary.counts.subagents === 0) return null;

  return <TurnFooter counts={summary.counts} durationMs={summary.durationMs} />;
}
