import { useEffect, useMemo, useRef } from "react";
import { useThreadStore } from "@/stores/threadStore";
import { useActiveThreadRecord } from "@/stores/thread-selectors";
import type { NarrativeItem } from "./types";
import type { ToolCall } from "@/transport/types";
import { ThoughtBlock } from "./ThoughtBlock";
import { ToolSummaryLine } from "./ToolSummaryLine";
import { HookRow } from "./HookRow";
import { SubagentRow } from "./SubagentRow";
import {
  buildPersistedNarrativeItems,
  recordToToolCall,
} from "./build-persisted-narrative";

/** Props for `PersistedNarrative`. */
export interface PersistedNarrativeProps {
  /** Assistant message id (server-side or local) whose narrative to render. */
  messageId: string;
  /**
   * Body of the assistant message. Used by the client-side suffix-match
   * safety net to suppress thought segments that duplicate the message body.
   */
  messageContent?: string;
}

/**
 * Top-margin class for a persisted row. Mirrors the live `marginClassForItem`.
 *
 * Tools, hooks, and sub-agents stack tightly as one "actions molecule".
 * Text rows get a comfortable gap so the response breathes apart from the
 * preceding action group.
 */
function marginClassForItem(item: NarrativeItem, index: number): string {
  if (index === 0) return "mt-0";
  switch (item.type) {
    case "thought":
      return "mt-3";
    case "tool-group":
    case "hook":
    case "subagent":
      return "mt-1";
    default:
      return "mt-0";
  }
}

/** Stable key for a persisted row. */
function keyForItem(item: NarrativeItem, index: number): string {
  switch (item.type) {
    case "thought":
      return `thought-${item.segment.startedAt}-${index}`;
    case "tool-group":
      return `tool-group-${item.group.calls[0]?.id ?? index}`;
    case "hook":
      return `hook-${item.hook.hookName}-${item.hook.startedAt}-${index}`;
    case "subagent":
      return `subagent-${item.toolCall.id}`;
    default:
      return `item-${index}`;
  }
}

/** Render one persisted narrative row. */
function renderItem(item: NarrativeItem, allToolCalls: readonly ToolCall[]): React.ReactNode {
  switch (item.type) {
    case "thought":
      return <ThoughtBlock segment={item.segment} isActive={false} />;
    case "tool-group":
      return (
        <ToolSummaryLine
          group={item.group}
          hasError={item.hasError}
          hasCancelled={item.hasCancelled}
        />
      );
    case "hook":
      return <HookRow hook={item.hook} />;
    case "subagent":
      return (
        <SubagentRow
          toolCall={item.toolCall}
          children={item.children}
          hooks={item.hooks}
          allToolCalls={allToolCalls}
        />
      );
    default:
      return null;
  }
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
export function PersistedNarrative({ messageId, messageContent }: PersistedNarrativeProps) {
  const records = useActiveThreadRecord((r) => r.narrativeByMessage[messageId]);
  const load = useThreadStore((s) => s.loadNarrativeForMessage);
  const triggered = useRef(false);

  useEffect(() => {
    if (records || triggered.current) return;
    triggered.current = true;
    void load(messageId);
  }, [messageId, records, load]);

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
    <div className="relative min-w-0 max-w-full">
      <div className="flex min-w-0 max-w-full flex-col">
        {items.map((item, i) => (
          <div
            key={keyForItem(item, i)}
            className={`${marginClassForItem(item, i)} min-w-0 max-w-full`}
          >
            {renderItem(item, allToolCalls)}
          </div>
        ))}
      </div>
    </div>
  );
}
