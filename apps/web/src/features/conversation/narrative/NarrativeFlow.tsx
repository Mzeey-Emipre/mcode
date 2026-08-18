import { useMemo } from "react";
import type { ToolCall, HookExecution } from "@/transport/types";
import type { SubagentRosterTarget, ThoughtSegment } from "./types";
import { buildNarrativeItems } from "./build-narrative";
import { NarrativeRows } from "./NarrativeRows";
import { NarrativePerformanceBoundary } from "./NarrativePerformanceBoundary";

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
  /** Opens a selected canonical child through the composition root. */
  onSubagentSelect?: (id: string, target: SubagentRosterTarget) => void;
  /** Opens the owning thread's Subagents roster for aggregate activity. */
  onOpenSubagents?: (target: SubagentRosterTarget) => void;
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
  onSubagentSelect,
  onOpenSubagents,
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
        <NarrativeRows
          items={timelineItems}
          allToolCalls={toolCalls}
          animateEntry
          onSubagentSelect={onSubagentSelect}
          onOpenSubagents={onOpenSubagents}
        />
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
