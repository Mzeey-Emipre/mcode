import { useEffect, useMemo, useRef } from "react";
import { useThreadStore } from "@/stores/threadStore";
import { useThreadRecord } from "@/stores/thread-selectors";
import type { NarrativeItem } from "./types";
import type { ToolCall } from "@/transport/types";
import { NarrativeRows } from "./NarrativeRows";
import {
  buildPersistedNarrativeItems,
  recordToToolCall,
} from "./build-persisted-narrative";
import { NarrativePerformanceBoundary } from "./NarrativePerformanceBoundary";

/** Props for `PersistedNarrative`. */
export interface PersistedNarrativeProps {
  /** Thread whose resident narrative cache owns this assistant message. */
  threadId?: string | null;
  /** Assistant message id (server-side or local) whose narrative to render. */
  messageId: string;
  /**
   * Body of the assistant message. Used by the client-side suffix-match
   * safety net to suppress thought segments that duplicate the message body.
   */
  messageContent?: string;
}

/**
 * Render the persisted narrative timeline for a completed assistant message.
 *
 * Lazy-loads records via `loadNarrativeForMessage` on first mount (eager
 * prefetch in the store covers the recent-message window; this effect catches
 * the older-message lazy path). Returns `null` until records arrive so the
 * layout doesn't jump.
 *
 * Persisted mode differences from live `NarrativeFlow`:
 *   - No `NarrativeIndicator` (the turn is over)
 *   - Always renders `TurnFooter` when there's at least one row
 *   - Sub-agents render via the same `SubagentRow` but lack the "active"
 *     visual treatment (no pulse, no primary tint)
 */
export function PersistedNarrative({ threadId, messageId, messageContent }: PersistedNarrativeProps) {
  const records = useThreadRecord(threadId, (r) => r.narrativeByMessage[messageId]);
  const load = useThreadStore((s) => s.loadNarrativeForMessage);
  const triggered = useRef(false);

  useEffect(() => {
    if (records || triggered.current) return;
    triggered.current = true;
    void load(messageId, threadId ?? undefined);
  }, [messageId, records, load, threadId]);

  const { items, allToolCalls } = useMemo(() => {
    if (!records) {
      return {
        items: [] as NarrativeItem[],
        allToolCalls: [] as ToolCall[],
      };
    }
    const built = buildPersistedNarrativeItems({ ...records, messageContent });
    const liveTools: ToolCall[] = records.tools.map(recordToToolCall);
    return { items: built, allToolCalls: liveTools };
  }, [records, messageContent]);

  if (!records) return null;
  if (items.length === 0) return null;

  return (
    <NarrativePerformanceBoundary>
    <div className="relative min-w-0 max-w-full">
      <NarrativeRows items={items} allToolCalls={allToolCalls} />
    </div>
    </NarrativePerformanceBoundary>
  );
}
