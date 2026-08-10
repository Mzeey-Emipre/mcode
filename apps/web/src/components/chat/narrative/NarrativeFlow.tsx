import { memo, Profiler, useLayoutEffect, useMemo } from "react";
import { batch, type Observable } from "@legendapp/state";
import { useObservable, useValue } from "@legendapp/state/react";
import type { ToolCall, HookExecution } from "@/transport/types";
import type { ThoughtSegment, NarrativeItem } from "./types";
import { buildNarrativeItems } from "./build-narrative";
import { ThoughtBlock } from "./ThoughtBlock";
import { ToolSummaryLine } from "./ToolSummaryLine";
import { HookRow } from "./HookRow";
import { SubagentRow } from "./SubagentRow";
import { ActiveToolRow } from "./ActiveToolRow";
import { DeltaBlock } from "./DeltaBlock";
import {
  readNarrativePrototypeVariant,
  recordNarrativePrototypeCommit,
  recordNarrativePrototypeRowRender,
} from "./narrative-prototype-metrics";

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

interface NarrativeRowProps {
  item: NarrativeItem;
  index: number;
  mostActiveSubagentId: string | null;
  allToolCalls: readonly ToolCall[];
}

function sameReferences<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameNarrativeItem(left: NarrativeItem, right: NarrativeItem): boolean {
  if (left.type !== right.type) return false;
  switch (left.type) {
    case "thought":
      return right.type === "thought"
        && left.segment === right.segment
        && left.isActive === right.isActive;
    case "tool-group":
      return right.type === "tool-group"
        && left.hasError === right.hasError
        && left.hasCancelled === right.hasCancelled
        && sameReferences(left.group.calls, right.group.calls);
    case "hook":
      return right.type === "hook" && left.hook === right.hook;
    case "subagent":
      return right.type === "subagent"
        && left.lifecycle === right.lifecycle
        && left.toolCall === right.toolCall
        && sameReferences(left.participants, right.participants)
        && sameReferences(left.children, right.children)
        && sameReferences(left.hooks, right.hooks);
    case "active-tool":
      return right.type === "active-tool" && left.toolCall === right.toolCall;
    case "delta":
      return right.type === "delta" && left.text === right.text;
  }
}

function NarrativeRow({
  item,
  index,
  mostActiveSubagentId,
  allToolCalls,
}: NarrativeRowProps) {
  const rowKey = keyForItem(item, index);
  recordNarrativePrototypeRowRender(rowKey);
  return (
    <div
      className={[
        marginClassForItem(item, index),
        "narrative-row-enter min-w-0 max-w-full",
      ].join(" ")}
      data-narrative-prototype-row={rowKey}
    >
      {renderItem(item, mostActiveSubagentId, allToolCalls)}
    </div>
  );
}

const TargetedNarrativeRow = memo(NarrativeRow, (left, right) =>
  left.index === right.index
  && left.mostActiveSubagentId === right.mostActiveSubagentId
  && sameNarrativeItem(left.item, right.item),
);

type LegendRowPayload = NarrativeRowProps;

interface LegendTimelineState {
  order: string[];
  rows: Record<string, LegendRowPayload | undefined>;
}

function sameLegendRowPayload(
  left: LegendRowPayload | undefined,
  right: LegendRowPayload,
): boolean {
  return left !== undefined
    && left.index === right.index
    && left.mostActiveSubagentId === right.mostActiveSubagentId
    && sameNarrativeItem(left.item, right.item);
}

function LegendNarrativeRow({
  rowKey,
  rows$,
}: {
  rowKey: string;
  rows$: Observable<LegendTimelineState["rows"]>;
}) {
  const payload = useValue(rows$[rowKey]);
  if (!payload) return null;
  return <NarrativeRow {...payload} />;
}

function LegendNarrativeTimeline({
  items,
  mostActiveSubagentId,
  allToolCalls,
}: {
  items: readonly NarrativeItem[];
  mostActiveSubagentId: string | null;
  allToolCalls: readonly ToolCall[];
}) {
  const state$ = useObservable<LegendTimelineState>({ order: [], rows: {} });
  const entries = useMemo(
    () => items.map((item, index) => ({
      key: keyForItem(item, index),
      payload: { item, index, mostActiveSubagentId, allToolCalls },
    })),
    [items, mostActiveSubagentId, allToolCalls],
  );

  useLayoutEffect(() => {
    const nextOrder = entries.map((entry) => entry.key);
    batch(() => {
      if (!sameReferences(state$.order.peek(), nextOrder)) {
        state$.order.set(nextOrder);
      }
      const currentRows = state$.rows.peek();
      for (const { key, payload } of entries) {
        if (!sameLegendRowPayload(currentRows[key], payload)) {
          state$.rows[key].set(payload);
        }
      }
      const retainedKeys = new Set(nextOrder);
      for (const key of Object.keys(currentRows)) {
        if (!retainedKeys.has(key)) state$.rows[key].delete();
      }
    });
  }, [entries, state$]);

  const order = useValue(state$.order);
  return order.map((rowKey) => (
    <LegendNarrativeRow key={rowKey} rowKey={rowKey} rows$={state$.rows} />
  ));
}

/**
 * Renders the correct child component for a given narrative item type.
 * `mostActiveSubagentId` is the tool call ID of the running subagent with the
 * most recent child activity - only that one receives the primary tint.
 */
function renderItem(item: NarrativeItem, _mostActiveSubagentId: string | null, allToolCalls: readonly ToolCall[]): React.ReactNode {
  switch (item.type) {
    case "thought":
      return <ThoughtBlock segment={item.segment} isActive={item.isActive} />;
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
          participants={item.participants}
          lifecycle={item.lifecycle}
          children={item.children}
          hooks={item.hooks}
          allToolCalls={allToolCalls}
        />
      );
    case "active-tool":
      return <ActiveToolRow toolCall={item.toolCall} />;
    case "delta":
      return <DeltaBlock text={item.text} />;
    default:
      return null;
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

  /**
   * ID of the running subagent with the most recent child tool call `startedAt`.
   * Only this subagent receives the primary-tinted background.
   * Subagents with no defined timestamps are skipped so we never pick a false winner via `0` fallbacks.
   */
  const mostActiveSubagentId = useMemo<string | null>(() => {
    const runningSubagents = items.filter(
      (item): item is Extract<NarrativeItem, { type: "subagent" }> =>
        item.type === "subagent" && !item.toolCall.isComplete,
    );
    if (runningSubagents.length === 0) return null;

    const latestKnownActivity = (
      sa: Extract<NarrativeItem, { type: "subagent" }>,
    ): number | null => {
      const stamps: number[] = [];
      if (sa.toolCall.startedAt != null) stamps.push(sa.toolCall.startedAt);
      for (const tc of sa.children) {
        if (tc.startedAt != null) stamps.push(tc.startedAt);
      }
      return stamps.length === 0 ? null : Math.max(...stamps);
    };

    let bestId: string | null = null;
    let bestTime = -Infinity;
    for (const sa of runningSubagents) {
      const latest = latestKnownActivity(sa);
      if (latest == null) continue;
      if (latest > bestTime) {
        bestTime = latest;
        bestId = sa.toolCall.id;
      }
    }
    return bestId;
  }, [items]);

  // Split items: timeline rows (tools, sub-agents, hooks, in-line text) all
  // render in chronological order. The delta (final streaming response) lives
  // outside the timeline so it can transition seamlessly into the persisted
  // MessageBubble on turnComplete.
  const timelineItems = items.filter((it) => it.type !== "delta");
  const prototypeVariant = readNarrativePrototypeVariant();

  const timeline = (() => {
    if (prototypeVariant === "legend") {
      return (
        <LegendNarrativeTimeline
          items={timelineItems}
          mostActiveSubagentId={mostActiveSubagentId}
          allToolCalls={toolCalls}
        />
      );
    }
    const Row = prototypeVariant === "zustand-targeted"
      ? TargetedNarrativeRow
      : NarrativeRow;
    return timelineItems.map((item, index) => (
      <Row
        key={keyForItem(item, index)}
        item={item}
        index={index}
        mostActiveSubagentId={mostActiveSubagentId}
        allToolCalls={toolCalls}
      />
    ));
  })();

  return (
    <Profiler id={`narrative-${prototypeVariant}`} onRender={recordNarrativePrototypeCommit}>
      <div
        className="relative min-w-0 max-w-full"
        data-narrative-prototype-variant={prototypeVariant}
      >
      {/* Timeline — no vertical rail, no row dots. Each row component carries
          its own visual marker (chevron, icon, badge), and consecutive action
          rows (tools, hooks, sub-agents) stack tightly as one "actions
          molecule" while text rows breathe with a larger top margin. */}
      {timelineItems.length > 0 && (
        <div className="flex min-w-0 max-w-full flex-col">
          {timeline}
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
    </Profiler>
  );
}
