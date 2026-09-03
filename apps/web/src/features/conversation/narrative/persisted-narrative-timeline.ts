import {
  createCanonicalSubagentPresentation,
  createSubagentPresentation,
  decodeCanonicalSubagentDetailTarget,
  decodeSubagentAliasDetailTarget,
  resolveBrowserNarrativeTool,
} from "@mcode/contracts";
import type {
  HookExecution,
  HookExecutionRecord,
  ThoughtSegmentRecord,
  ToolCall,
  ToolCallRecord,
} from "@/transport/types";
import {
  collapseSubagentRecords,
  isSubagentLifecycleRecord,
  parseSubagentLifecycleInput,
  subagentLifecycleParticipants,
  type SubagentLifecycle,
} from "./subagent-lifecycle";
import {
  AGENT_TOOL_NAME,
  buildToolCallHierarchy,
  createSubagentItem,
  createToolGroupItem,
} from "./narrative-builder-helpers";
import { filterPersistedFinalResponseThoughts } from "./narrative-thought-classification";
import type { NarrativeItem, SubagentActivity, ThoughtSegment } from "./types";

/** Inputs that reconstruct a persisted turn narrative from durable records. */
export interface PersistedNarrativeInputs {
  tools: readonly ToolCallRecord[];
  thoughts: readonly ThoughtSegmentRecord[];
  hooks: readonly HookExecutionRecord[];
  messageContent?: string;
}

/** One chronological persisted event before it projects into a narrative row. */
export type PersistedTimelineEvent =
  | { kind: "thought"; segment: ThoughtSegment; sortOrder: number }
  | { kind: "tool"; call: ToolCall; sortOrder: number }
  | { kind: "subagent"; call: ToolCall; marker?: ToolCall; lifecycle: SubagentLifecycle; sortOrder: number }
  | { kind: "hook"; hook: HookExecution; sortOrder: number };

/** Normalized persisted state that preserves durable ordering and parent groups. */
export interface PersistedNarrativePreparation {
  toolRecords: readonly ToolCallRecord[];
  allToolCalls: readonly ToolCall[];
  liveHooks: readonly HookExecution[];
  childrenByParent: ReadonlyMap<string, readonly ToolCallRecord[]>;
  timeline: readonly PersistedTimelineEvent[];
}

const toolCallCache = new WeakMap<ToolCallRecord, ToolCall>();
const thoughtSegmentCache = new WeakMap<ThoughtSegmentRecord, ThoughtSegment>();
const hookExecutionCache = new WeakMap<HookExecutionRecord, HookExecution>();

/** Maps one persisted tool record to the live row model. */
export function recordToToolCall(record: ToolCallRecord): ToolCall {
  const cached = toolCallCache.get(record);
  if (cached) return cached;

  const durationMs = persistedDurationMs(record.started_at, record.completed_at);
  const lifecycleInput = isSubagentLifecycleRecord(record)
    ? parseSubagentLifecycleInput(record.input_summary)
    : undefined;
  const subagentPresentation = persistedSubagentPresentation(record);
  const toolCall: ToolCall = {
    id: record.id,
    toolName: record.tool_name,
    toolInput: lifecycleInput ?? persistedToolInputWithAgentMetadata(record),
    ...(subagentPresentation ? { subagentPresentation } : {}),
    output: record.output_summary || null,
    isError: record.status === "failed",
    isComplete: record.status === "completed" || record.status === "failed" || record.status === "cancelled",
    ...persistedToolCallOptionalFields(record, durationMs),
    parentToolCallId: record.parent_tool_call_id ?? undefined,
    startedAt: isoToMs(record.started_at),
  };
  toolCallCache.set(record, toolCall);
  return toolCall;
}

/** Maps one persisted hook record to the live row model. */
export function recordToHookExecution(record: HookExecutionRecord): HookExecution {
  const cached = hookExecutionCache.get(record);
  if (cached) return cached;

  const detailLines = persistedHookDetailLines(record);
  const hook: HookExecution = {
    hookName: record.hook_name,
    hookType: record.phase === "stop" ? "stop" : "permission",
    toolName: record.tool_name ?? undefined,
    status: "completed",
    outputLines: detailLines,
    fullOutput: detailLines,
    detailLines,
    durationMs: record.duration_ms ?? undefined,
    didBlock: record.did_block,
    startedAt: isoToMs(record.started_at),
  };
  hookExecutionCache.set(record, hook);
  return hook;
}

/** Formats persisted hook metadata into the bounded detail lines used by HookRow. */
export function persistedHookDetailLines(record: HookExecutionRecord): string[] {
  const lines: string[] = [`phase: ${record.phase}`];
  if (record.tool_name) lines.push(`tool: ${record.tool_name}`);
  if (record.duration_ms != null) lines.push(`duration: ${record.duration_ms}ms`);
  lines.push(`blocked: ${record.did_block ? "yes" : "no"}`);
  const payload = record.payload.trim();
  if (payload.length > 0 && payload !== "{}") {
    lines.push(`payload: ${payload.length > 500 ? `${payload.slice(0, 500)}...` : payload}`);
  }
  return lines;
}

/** Normalizes persisted records into durable ordering and authoritative parent groups. */
export function preparePersistedNarrative(
  inputs: PersistedNarrativeInputs,
): PersistedNarrativePreparation {
  const toolRecords = collapseSubagentRecords(inputs.tools);
  const filteredThoughts = filterPersistedFinalResponseThoughts(inputs.thoughts, inputs.messageContent);
  const hierarchy = buildToolCallHierarchy(
    toolRecords,
    (toolRecord) => toolRecord.parent_tool_call_id,
    false,
  );
  const allToolCalls = toolRecords.map(recordToToolCall);
  const liveHooks = inputs.hooks.map(recordToHookExecution);
  return {
    toolRecords,
    allToolCalls,
    liveHooks,
    childrenByParent: hierarchy.childrenByParent,
    timeline: createPersistedTimeline(
      filteredThoughts,
      hierarchy.topLevel,
      toolRecords,
      hierarchy.childrenByParent,
      inputs.hooks,
    ),
  };
}

/** Projects normalized persisted events into static narrative rows. */
export function projectPersistedNarrativeItems(
  preparation: PersistedNarrativePreparation,
): NarrativeItem[] {
  const items: NarrativeItem[] = [];
  const pendingToolCalls: ToolCall[] = [];

  for (let index = 0; index < preparation.timeline.length; index += 1) {
    const event = preparation.timeline[index]!;
    switch (event.kind) {
      case "thought":
        flushToolGroup(items, pendingToolCalls);
        items.push({ type: "thought", segment: event.segment, isActive: false });
        break;
      case "hook":
        flushToolGroup(items, pendingToolCalls);
        items.push({ type: "hook", hook: event.hook });
        break;
      case "subagent": {
        flushToolGroup(items, pendingToolCalls);
        const groupedEvents = collectSiblingSubagentEvents(preparation.timeline, index);
        items.push(createSubagentItem(createPersistedSubagentActivities(
          groupedEvents.events,
          preparation.childrenByParent,
          preparation.allToolCalls,
          preparation.liveHooks,
        )));
        index = groupedEvents.lastIndex;
        break;
      }
      case "tool":
        pendingToolCalls.push(event.call);
        break;
    }
  }
  flushToolGroup(items, pendingToolCalls);
  return items;
}

function isoToMs(value: string | null | undefined): number {
  if (!value) return 0;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function persistedDurationMs(
  startedAt: string | null | undefined,
  completedAt: string | null | undefined,
): number | undefined {
  if (!startedAt || !completedAt) return undefined;
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start
    ? end - start
    : undefined;
}

function persistedToolInput(record: ToolCallRecord): Record<string, unknown> {
  if (!resolveBrowserNarrativeTool(record.tool_name)) return { _summary: record.input_summary };
  try {
    const parsed: unknown = JSON.parse(record.input_summary);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function persistedToolInputWithAgentMetadata(record: ToolCallRecord): Record<string, unknown> {
  const input = persistedToolInput(record);
  if (record.tool_name !== AGENT_TOOL_NAME) return input;
  addPersistedTextField(input, "agentName", record.display_name);
  addPersistedTextField(input, "prompt", record.subagent_prompt);
  addPersistedTextField(input, "subagentType", record.subagent_type);
  addPersistedTextField(input, "agentId", record.subagent_agent_id);
  addPersistedNumberField(input, "durationMs", record.subagent_duration_ms);
  return input;
}

function persistedSubagentPresentation(record: ToolCallRecord): ToolCall["subagentPresentation"] {
  if (record.tool_name !== AGENT_TOOL_NAME) return undefined;
  const input: Record<string, unknown> = {};
  addPersistedTextField(input, "agentName", record.display_name);
  addPersistedProviderAgentInput(input, record.provider_agent_key);
  addPersistedTextField(input, "subagentProviderName", record.subagent_provider_name);
  addPersistedTextField(input, "prompt", record.subagent_prompt ?? record.input_summary);
  addPersistedTextField(input, "subagentType", record.subagent_type);
  addPersistedTextField(input, "agentId", record.subagent_agent_id);
  addPersistedNumberField(input, "durationMs", record.subagent_duration_ms);
  addPersistedTextField(input, "model", record.model);
  addPersistedTextField(input, "reasoningEffort", record.reasoning_effort);
  const canonicalChildThreadId = decodeCanonicalSubagentDetailTarget(record.subagent_identity_key);
  if (canonicalChildThreadId) {
    return createCanonicalSubagentPresentation(
      input,
      record.provider_agent_key ?? record.id,
      canonicalChildThreadId,
    );
  }
  addPersistedTextField(
    input,
    "nativeThreadId",
    decodeSubagentAliasDetailTarget(record.subagent_identity_key) ?? record.subagent_identity_key,
  );
  return createSubagentPresentation(input, record.provider_agent_key ?? record.id);
}

function addPersistedTextField(
  input: Record<string, unknown>,
  name: string,
  value: string | null | undefined,
): void {
  if (value) input[name] = value;
}

function addPersistedNumberField(
  input: Record<string, unknown>,
  name: string,
  value: number | null | undefined,
): void {
  if (typeof value === "number") input[name] = value;
}

function addPersistedProviderAgentInput(
  input: Record<string, unknown>,
  providerAgentKey: string | null | undefined,
): void {
  if (!providerAgentKey) return;
  input.codexCollabKind = "spawnAgent";
  input.agentPath = providerAgentKey;
}

function persistedToolCallOptionalFields(
  record: ToolCallRecord,
  durationMs: number | undefined,
): Partial<Pick<ToolCall, "isCancelled" | "outputTruncated" | "outputTotalBytes" | "outputArtifactPath" | "durationMs" | "exitCode">> {
  const fields: Partial<Pick<ToolCall, "isCancelled" | "outputTruncated" | "outputTotalBytes" | "outputArtifactPath" | "durationMs" | "exitCode">> = {};
  if (record.status === "cancelled") fields.isCancelled = true;
  if (record.output_truncated === 1) fields.outputTruncated = true;
  if (typeof record.output_total_bytes === "number") fields.outputTotalBytes = record.output_total_bytes;
  if (record.output_artifact_path) fields.outputArtifactPath = record.output_artifact_path;
  if (durationMs !== undefined) fields.durationMs = durationMs;
  if (typeof record.exit_code === "number") fields.exitCode = record.exit_code;
  return fields;
}

function recordToThoughtSegment(record: ThoughtSegmentRecord): ThoughtSegment {
  const cached = thoughtSegmentCache.get(record);
  if (cached) return cached;
  const segment: ThoughtSegment = {
    text: record.text,
    startedAt: isoToMs(record.started_at),
    endedAt: record.ended_at ? isoToMs(record.ended_at) : undefined,
  };
  thoughtSegmentCache.set(record, segment);
  return segment;
}

function createPersistedTimeline(
  thoughts: readonly ThoughtSegmentRecord[],
  topLevelRecords: readonly ToolCallRecord[],
  toolRecords: readonly ToolCallRecord[],
  childrenByParent: ReadonlyMap<string, readonly ToolCallRecord[]>,
  hooks: readonly HookExecutionRecord[],
): PersistedTimelineEvent[] {
  const timeline = createPersistedThoughtEvents(thoughts)
    .concat(createPersistedTopLevelToolEvents(topLevelRecords))
    .concat(createPersistedSubagentEvents(toolRecords, childrenByParent))
    .concat(createPersistedHookEvents(hooks));
  return timeline.sort((left, right) => left.sortOrder - right.sortOrder);
}

function createPersistedThoughtEvents(
  thoughts: readonly ThoughtSegmentRecord[],
): PersistedTimelineEvent[] {
  return thoughts.map((thought) => ({
    kind: "thought",
    segment: recordToThoughtSegment(thought),
    sortOrder: thought.sort_order,
  }));
}

function createPersistedTopLevelToolEvents(
  topLevelRecords: readonly ToolCallRecord[],
): PersistedTimelineEvent[] {
  return topLevelRecords.flatMap((toolRecord) => toolRecord.tool_name === AGENT_TOOL_NAME
    ? []
    : [{ kind: "tool" as const, call: recordToToolCall(toolRecord), sortOrder: toolRecord.sort_order }]);
}

function createPersistedSubagentEvents(
  toolRecords: readonly ToolCallRecord[],
  childrenByParent: ReadonlyMap<string, readonly ToolCallRecord[]>,
): PersistedTimelineEvent[] {
  return toolRecords.flatMap((toolRecord) => {
    if (toolRecord.tool_name !== AGENT_TOOL_NAME) return [];
    const marker = latestPersistedLifecycleMarker(childrenByParent.get(toolRecord.id) ?? []);
    return [{
      kind: "subagent" as const,
      call: recordToToolCall(toolRecord),
      ...(marker ? { marker: recordToToolCall(marker) } : {}),
      lifecycle: toolRecord.status !== "running" ? "finished" : marker ? "updated" : "started",
      sortOrder: toolRecord.sort_order,
    }];
  });
}

function latestPersistedLifecycleMarker(
  children: readonly ToolCallRecord[],
): ToolCallRecord | undefined {
  let latestMarker: ToolCallRecord | undefined;
  for (const child of children) {
    if (!isSubagentLifecycleRecord(child)) continue;
    if (!latestMarker || child.sort_order >= latestMarker.sort_order) latestMarker = child;
  }
  return latestMarker;
}

function createPersistedHookEvents(
  hooks: readonly HookExecutionRecord[],
): PersistedTimelineEvent[] {
  return hooks.flatMap((hook) => hook.phase === "stop"
    ? []
    : [{ kind: "hook" as const, hook: recordToHookExecution(hook), sortOrder: hook.sort_order }]);
}

function collectSiblingSubagentEvents(
  timeline: readonly PersistedTimelineEvent[],
  startIndex: number,
): { events: Extract<PersistedTimelineEvent, { kind: "subagent" }>[]; lastIndex: number } {
  const firstEvent = timeline[startIndex]! as Extract<PersistedTimelineEvent, { kind: "subagent" }>;
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

function createPersistedSubagentActivities(
  events: readonly Extract<PersistedTimelineEvent, { kind: "subagent" }>[],
  childrenByParent: ReadonlyMap<string, readonly ToolCallRecord[]>,
  allToolCalls: readonly ToolCall[],
  hooks: readonly HookExecution[],
): SubagentActivity[] {
  return events.map((event) => ({
    lifecycle: event.lifecycle,
    toolCall: event.call,
    participants: subagentLifecycleParticipants(event.call, event.marker, allToolCalls),
    children: (childrenByParent.get(event.call.id) ?? [])
      .filter((child) => !isSubagentLifecycleRecord(child))
      .slice()
      .sort((left, right) => left.sort_order - right.sort_order)
      .map(recordToToolCall),
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
