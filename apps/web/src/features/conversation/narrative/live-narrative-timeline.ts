import type { HookExecution, ToolCall } from "@/transport/types";
import {
  collapseSubagentCalls,
  isSubagentLifecycleCall,
  subagentLifecycleParticipants,
  type SubagentLifecycle,
} from "./subagent-lifecycle";
import {
  AGENT_TOOL_NAME,
  buildToolCallHierarchy,
  createSubagentItem,
  createToolGroupItem,
} from "./narrative-builder-helpers";
import { filterThoughtsMatchingAssistantBody } from "./narrative-thought-classification";
import type { NarrativeItem, SubagentActivity, ThoughtSegment } from "./types";

/** Inputs that describe the volatile narrative state for one live turn. */
export interface LiveNarrativeInputs {
  toolCalls: readonly ToolCall[];
  hooks: readonly HookExecution[];
  thoughtSegments: readonly ThoughtSegment[];
  streamingText: string;
  isAgentRunning: boolean;
  committedAssistantBody?: string;
}

/** One chronological live event before it projects into a narrative row. */
export type LiveTimelineEvent =
  | { kind: "thought"; segment: ThoughtSegment; startedAt: number }
  | { kind: "tool"; call: ToolCall; startedAt: number }
  | { kind: "subagent"; call: ToolCall; marker?: ToolCall; lifecycle: SubagentLifecycle; startedAt: number }
  | { kind: "hook"; hook: HookExecution; startedAt: number };

/** Normalized live state that preserves parent grouping before row projection. */
export interface LiveNarrativePreparation {
  toolCalls: readonly ToolCall[];
  topLevelCalls: readonly ToolCall[];
  childrenByParent: ReadonlyMap<string, readonly ToolCall[]>;
  thoughtSegments: readonly ThoughtSegment[];
  timeline: readonly LiveTimelineEvent[];
  activeToolCall: ToolCall | null;
  hasRunningTopLevelTool: boolean;
}

/** Normalizes live events into deterministic timeline inputs and parent groups. */
export function prepareLiveNarrative(
  inputs: LiveNarrativeInputs,
): LiveNarrativePreparation {
  const toolCalls = collapseSubagentCalls(inputs.toolCalls);
  const thoughtSegments = filterLiveThoughtSegments(
    inputs.thoughtSegments,
    inputs.committedAssistantBody,
  );
  const hierarchy = buildToolCallHierarchy(
    toolCalls,
    (toolCall) => toolCall.parentToolCallId,
    true,
  );
  const activeToolCall = findActiveToolCall(hierarchy.topLevel);
  const hasRunningTopLevelTool = hierarchy.topLevel.some((toolCall) => !toolCall.isComplete);
  return {
    toolCalls,
    topLevelCalls: hierarchy.topLevel,
    childrenByParent: hierarchy.childrenByParent,
    thoughtSegments,
    timeline: createLiveTimeline(
      toolCalls,
      hierarchy.topLevel,
      hierarchy.childrenByParent,
      thoughtSegments,
      inputs.hooks,
      activeToolCall,
    ),
    activeToolCall,
    hasRunningTopLevelTool,
  };
}

/** Projects normalized live events into rows, active tools, and final-response deltas. */
export function projectLiveNarrativeItems(
  preparation: LiveNarrativePreparation,
  inputs: Pick<LiveNarrativeInputs, "hooks" | "streamingText" | "isAgentRunning">,
): NarrativeItem[] {
  if (isEmptyLiveNarrative(preparation, inputs.hooks)) {
    return projectStreamingOnlyResponse(inputs.streamingText, inputs.isAgentRunning);
  }

  const streamingSuffix = liveStreamingSuffix(
    preparation.thoughtSegments,
    inputs.streamingText,
    inputs.isAgentRunning,
    preparation.hasRunningTopLevelTool,
  );
  const { items, emittedFinalDeltaFromTape } = projectLiveTimeline(
    preparation,
    inputs.hooks,
    inputs.isAgentRunning,
    streamingSuffix,
  );
  if (preparation.activeToolCall) {
    items.push({ type: "active-tool", toolCall: preparation.activeToolCall });
  }
  if (shouldAppendStreamingSuffix(emittedFinalDeltaFromTape, streamingSuffix, inputs.isAgentRunning)) {
    items.push({ type: "delta", text: streamingSuffix });
  }
  return items;
}

function filterLiveThoughtSegments(
  thoughtSegments: readonly ThoughtSegment[],
  committedAssistantBody: string | undefined,
): readonly ThoughtSegment[] {
  const bodyTrimmed = (committedAssistantBody ?? "").trim();
  return bodyTrimmed.length > 0
    ? filterThoughtsMatchingAssistantBody(thoughtSegments, bodyTrimmed)
    : thoughtSegments;
}

function findActiveToolCall(topLevelCalls: readonly ToolCall[]): ToolCall | null {
  return [...topLevelCalls].reverse().find(
    (toolCall) => !toolCall.isComplete && toolCall.toolName !== AGENT_TOOL_NAME,
  ) ?? null;
}

function createLiveTimeline(
  toolCalls: readonly ToolCall[],
  topLevelCalls: readonly ToolCall[],
  childrenByParent: ReadonlyMap<string, readonly ToolCall[]>,
  thoughtSegments: readonly ThoughtSegment[],
  hooks: readonly HookExecution[],
  activeToolCall: ToolCall | null,
): LiveTimelineEvent[] {
  const timeline = createThoughtEvents(thoughtSegments)
    .concat(createTopLevelToolEvents(topLevelCalls, activeToolCall))
    .concat(createSubagentEvents(toolCalls, childrenByParent))
    .concat(createHookEvents(hooks));
  return timeline.sort((left, right) => left.startedAt - right.startedAt);
}

function createThoughtEvents(
  thoughtSegments: readonly ThoughtSegment[],
): LiveTimelineEvent[] {
  return thoughtSegments.map((segment) => ({
    kind: "thought",
    segment,
    startedAt: segment.startedAt,
  }));
}

function createTopLevelToolEvents(
  topLevelCalls: readonly ToolCall[],
  activeToolCall: ToolCall | null,
): LiveTimelineEvent[] {
  return topLevelCalls.flatMap((toolCall) => {
    if (toolCall === activeToolCall || toolCall.toolName === AGENT_TOOL_NAME) return [];
    return [{ kind: "tool" as const, call: toolCall, startedAt: liveEventStartedAt(toolCall) }];
  });
}

function createSubagentEvents(
  toolCalls: readonly ToolCall[],
  childrenByParent: ReadonlyMap<string, readonly ToolCall[]>,
): LiveTimelineEvent[] {
  return toolCalls.flatMap((toolCall) => {
    if (toolCall.toolName !== AGENT_TOOL_NAME) return [];
    const startedAt = liveEventStartedAt(toolCall);
    const marker = latestLifecycleMarker(childrenByParent.get(toolCall.id) ?? [], startedAt);
    return [{
      kind: "subagent" as const,
      call: toolCall,
      ...(marker ? { marker } : {}),
      lifecycle: toolCall.isComplete ? "finished" : marker ? "updated" : "started",
      startedAt,
    }];
  });
}

function createHookEvents(hooks: readonly HookExecution[]): LiveTimelineEvent[] {
  return hooks.map((hook) => ({ kind: "hook", hook, startedAt: hook.startedAt }));
}

function latestLifecycleMarker(
  children: readonly ToolCall[],
  parentStartedAt: number,
): ToolCall | undefined {
  let latestMarker: ToolCall | undefined;
  for (const child of children) {
    if (!isSubagentLifecycleCall(child)) continue;
    if (!latestMarker || liveEventStartedAt(child, parentStartedAt) >= liveEventStartedAt(latestMarker, parentStartedAt)) {
      latestMarker = child;
    }
  }
  return latestMarker;
}

function liveEventStartedAt(toolCall: ToolCall, fallback = Number.MAX_SAFE_INTEGER): number {
  return toolCall.startedAt ?? fallback;
}

function isEmptyLiveNarrative(
  preparation: LiveNarrativePreparation,
  hooks: readonly HookExecution[],
): boolean {
  return preparation.thoughtSegments.length === 0
    && preparation.toolCalls.length === 0
    && hooks.length === 0;
}

function projectStreamingOnlyResponse(streamingText: string, isAgentRunning: boolean): NarrativeItem[] {
  return isAgentRunning && streamingText.length > 0
    ? [{ type: "delta", text: streamingText }]
    : [];
}

function liveStreamingSuffix(
  thoughtSegments: readonly ThoughtSegment[],
  streamingText: string,
  isAgentRunning: boolean,
  hasRunningTopLevelTool: boolean,
): string {
  if (!isAgentRunning || hasRunningTopLevelTool) return "";
  const thoughtTape = thoughtSegments.map((segment) => segment.text).join("");
  return streamingText.startsWith(thoughtTape)
    ? streamingText.slice(thoughtTape.length)
    : "";
}

function projectLiveTimeline(
  preparation: LiveNarrativePreparation,
  hooks: readonly HookExecution[],
  isAgentRunning: boolean,
  streamingSuffix: string,
): { items: NarrativeItem[]; emittedFinalDeltaFromTape: boolean } {
  const items: NarrativeItem[] = [];
  const pendingToolCalls: ToolCall[] = [];
  const latestThoughtStartedAt = preparation.thoughtSegments.at(-1)?.startedAt ?? -1;
  let emittedFinalDeltaFromTape = false;

  for (let index = 0; index < preparation.timeline.length; index += 1) {
    const event = preparation.timeline[index]!;
    switch (event.kind) {
      case "thought":
        flushToolGroup(items, pendingToolCalls);
        if (projectThoughtEvent(
          items,
          event.segment,
          latestThoughtStartedAt,
          isAgentRunning,
          preparation.hasRunningTopLevelTool,
          streamingSuffix,
        )) {
          emittedFinalDeltaFromTape = true;
        }
        break;
      case "hook":
        flushToolGroup(items, pendingToolCalls);
        items.push({ type: "hook", hook: event.hook });
        break;
      case "subagent": {
        flushToolGroup(items, pendingToolCalls);
        const groupedEvents = collectSiblingSubagentEvents(preparation.timeline, index);
        items.push(createSubagentItem(createLiveSubagentActivities(
          groupedEvents.events,
          preparation.childrenByParent,
          preparation.toolCalls,
          hooks,
        )));
        index = groupedEvents.lastIndex;
        break;
      }
      case "tool":
        if (event.call.isComplete) pendingToolCalls.push(event.call);
        break;
    }
  }
  flushToolGroup(items, pendingToolCalls);
  return { items, emittedFinalDeltaFromTape };
}

function projectThoughtEvent(
  items: NarrativeItem[],
  segment: ThoughtSegment,
  latestThoughtStartedAt: number,
  isAgentRunning: boolean,
  hasRunningTopLevelTool: boolean,
  streamingSuffix: string,
): boolean {
  if (shouldPromoteThoughtToFinalDelta(
    segment,
    latestThoughtStartedAt,
    isAgentRunning,
    hasRunningTopLevelTool,
    streamingSuffix,
  )) {
    items.push({ type: "delta", text: segment.text });
    return true;
  }
  items.push({ type: "thought", segment, isActive: isAgentRunning });
  return false;
}

function shouldPromoteThoughtToFinalDelta(
  segment: ThoughtSegment,
  latestThoughtStartedAt: number,
  isAgentRunning: boolean,
  hasRunningTopLevelTool: boolean,
  streamingSuffix: string,
): boolean {
  if (streamingSuffix.length > 0 || segment.startedAt !== latestThoughtStartedAt) return false;
  if (segment.endedAt != null || hasRunningTopLevelTool || !isAgentRunning) return false;
  return !segment.isExplicitNonFinal;
}

function collectSiblingSubagentEvents(
  timeline: readonly LiveTimelineEvent[],
  startIndex: number,
): { events: Extract<LiveTimelineEvent, { kind: "subagent" }>[]; lastIndex: number } {
  const firstEvent = timeline[startIndex]! as Extract<LiveTimelineEvent, { kind: "subagent" }>;
  const events = [firstEvent];
  let lastIndex = startIndex;
  while (lastIndex + 1 < timeline.length) {
    const nextEvent = timeline[lastIndex + 1];
    if (nextEvent?.kind !== "subagent" || !sameSubagentParent(firstEvent.call, nextEvent.call)) break;
    events.push(nextEvent);
    lastIndex += 1;
  }
  return { events, lastIndex };
}

function createLiveSubagentActivities(
  events: readonly Extract<LiveTimelineEvent, { kind: "subagent" }>[],
  childrenByParent: ReadonlyMap<string, readonly ToolCall[]>,
  allToolCalls: readonly ToolCall[],
  hooks: readonly HookExecution[],
): SubagentActivity[] {
  return events.map((event) => ({
    lifecycle: event.lifecycle,
    toolCall: event.call,
    participants: subagentLifecycleParticipants(event.call, event.marker, allToolCalls),
    children: (childrenByParent.get(event.call.id) ?? []).filter(
      (child) => !isSubagentLifecycleCall(child),
    ),
    hooks: hooks.filter((hook) => hook.toolName === AGENT_TOOL_NAME),
  }));
}

function sameSubagentParent(left: ToolCall, right: ToolCall): boolean {
  return normalizedParentId(left) === normalizedParentId(right);
}

function normalizedParentId(toolCall: ToolCall): string | null {
  const parentId = toolCall.parentToolCallId;
  return typeof parentId === "string" && parentId.length > 0 ? parentId : null;
}

function flushToolGroup(items: NarrativeItem[], pendingToolCalls: ToolCall[]): void {
  const toolGroup = createToolGroupItem(pendingToolCalls);
  if (toolGroup) items.push(toolGroup);
  pendingToolCalls.length = 0;
}

function shouldAppendStreamingSuffix(
  emittedFinalDeltaFromTape: boolean,
  streamingSuffix: string,
  isAgentRunning: boolean,
): boolean {
  return !emittedFinalDeltaFromTape && streamingSuffix.length > 0 && isAgentRunning;
}
