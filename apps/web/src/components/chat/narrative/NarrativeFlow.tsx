import { useMemo } from "react";
import type { ToolCall, HookExecution } from "@/transport/types";
import type { ThoughtSegment, NarrativeItem } from "./types";
import { buildNarrativeItems } from "./build-narrative";
import { NarrativeRow } from "./NarrativeRow";
import {
  NarrativePerformanceBoundary,
  narrativePerformanceRowId,
} from "./NarrativePerformanceBoundary";

/** Props for the NarrativeFlow container component. */
export interface NarrativeFlowProps {
  /** All tool calls for the current agent turn. */
  toolCalls: readonly ToolCall[];
  /** All hook executions for the current agent turn. */
  hooks: readonly HookExecution[];
  /** Ordered thought segments accumulated during the agent turn. */
  thoughtSegments: readonly ThoughtSegment[];
  /** Partial streaming text not yet committed to a thought segment. */
  streamingText: string;
  /** Whether the agent is currently running. */
  isAgentRunning: boolean;
  /** Epoch ms when the agent turn started, used to derive elapsed time. */
  startTime?: number;
  /**
   * When the turn ended, the rendered assistant bubble text — duplicate thought
   * segments matching this body are suppressed until volatile state resets.
   */
  committedAssistantBody?: string;
}

/**
 * Returns the top-margin class for a given narrative item.
 *
 * Text rows get a comfortable gap so the response breathes apart from the
 * preceding action row. Tools, hooks, and sub-agents stack tightly into a
 * single "actions molecule" — they read as one group of agent activity
 * rather than independent timeline rows.
 */
function marginClassForItem(item: NarrativeItem, index: number): string {
  if (index === 0) return "mt-0";
  switch (item.type) {
    case "thought":
      return "mt-3";
    case "tool-group":
    case "hook":
      return "mt-1";
    case "subagent":
      return "mt-1";
    case "active-tool":
      return "mt-1";
    case "delta":
      return "mt-2";
    default:
      return "mt-0";
  }
}

/**
 * Returns a stable key string for a given narrative item and index.
 * Uses type-specific identifiers where available to avoid unnecessary re-mounts.
 */
function keyForItem(item: NarrativeItem, index: number): string {
  switch (item.type) {
    case "thought":
      return `thought-${item.segment.startedAt}-${index}`;
    case "tool-group":
      return `tool-group-${item.group.calls[0]?.id ?? index}`;
    case "hook":
      return `hook-${item.hook.hookName}-${item.hook.startedAt}-${index}`;
    case "subagent":
      return `subagent-${item.toolCall.id}-${item.lifecycle}-${index}`;
    case "active-tool":
      return `active-tool-${item.toolCall.id}`;
    case "delta":
      return "delta";
    default:
      return `item-${index}`;
  }
}

/**
 * Main timeline container for the narrative flow.
 *
 * Renders a vertical line, dot markers for each item, and delegates
 * to the appropriate child component per narrative item type. When the
 * agent is running, a NarrativeIndicator bar is appended at the bottom.
 */
export function NarrativeFlow({
  toolCalls,
  hooks,
  thoughtSegments,
  streamingText,
  isAgentRunning,
  committedAssistantBody,
}: NarrativeFlowProps) {
  const { items } = useMemo(
    () =>
      buildNarrativeItems({
        toolCalls,
        hooks,
        thoughtSegments,
        streamingText,
        isAgentRunning,
        committedAssistantBody,
      }),
    [
      toolCalls,
      hooks,
      thoughtSegments,
      streamingText,
      isAgentRunning,
      committedAssistantBody,
    ],
  );

  // Split items: timeline rows (tools, sub-agents, hooks, in-line text) all
  // render in chronological order. The delta (final streaming response) lives
  // outside the timeline so it can transition seamlessly into the persisted
  // MessageBubble on turnComplete.
  const timelineItems = items.filter((it) => it.type !== "delta");

  return (
    <NarrativePerformanceBoundary>
    <div className="relative min-w-0 max-w-full">
      {/* Timeline — no vertical rail, no row dots. Each row component carries
          its own visual marker (chevron, icon, badge), and consecutive action
          rows (tools, hooks, sub-agents) stack tightly as one "actions
          molecule" while text rows breathe with a larger top margin. */}
      {timelineItems.length > 0 && (
        <div className="flex min-w-0 max-w-full flex-col">
          {timelineItems.map((item, i) => (
            <div
              key={keyForItem(item, i)}
              data-performance-row-id={narrativePerformanceRowId(keyForItem(item, i))}
              className={[
                marginClassForItem(item, i),
                "narrative-row-enter min-w-0 max-w-full",
              ].join(" ")}
            >
              <NarrativeRow
                rowId={keyForItem(item, i)}
                item={item}
                allToolCalls={toolCalls}
              />
            </div>
          ))}
        </div>
      )}

      {/* The live "X steps · N subagents · phase…" indicator is rendered as
          its own virtual-item slot (`narrative-indicator`) BELOW the streaming
          response in MessageList. Keeping it out of this container means the
          writing animation reads as the primary surface and the progress meta
          sits underneath it instead of above it. */}

      {/* The in-flight response text lives in its own virtual-item slot
          (the provisional assistant message) rendered as a sibling AFTER this narrative-flow
          in MessageList. That keeps the streaming text and the persisted
          MessageBubble at the SAME virtual-list position so the swap on
          `session.message` is a content replacement rather than a position
          jump. The `delta` items produced by `buildNarrativeItems` are kept on
          the items array for compatibility with `counts` and tests but are
          intentionally not rendered here. */}

      {/* The turn footer is owned exclusively by the `persisted-turn-footer`
          virtual-item slot, which is positioned AFTER the `MessageBubble` so
          the summary closes the turn rather than separating its actions from
          its answer. Rendering a TurnFooter inside this container would place
          it ABOVE the message body — which is exactly the bug we are
          fixing — because this container itself sits before the bubble in
          the virtual-list order. */}
    </div>
    </NarrativePerformanceBoundary>
  );
}
