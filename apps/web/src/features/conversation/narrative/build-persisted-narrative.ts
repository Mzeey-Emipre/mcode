import type {
  ToolCallRecord,
  ThoughtSegmentRecord,
  HookExecutionRecord,
  ToolCall,
  HookExecution,
} from "@/transport/types";
import type { ThoughtSegment, NarrativeItem } from "./types";
import { resolveBrowserNarrativeTool } from "@mcode/contracts";
import {
  isSubagentLifecycleRecord,
  parseSubagentLifecycleInput,
  subagentLifecycleParticipants,
  type SubagentLifecycle,
} from "./subagent-lifecycle";

/** Inputs for `buildPersistedNarrativeItems`. */
export interface PersistedNarrativeInputs {
  tools: readonly ToolCallRecord[];
  thoughts: readonly ThoughtSegmentRecord[];
  hooks: readonly HookExecutionRecord[];
  /** Assistant message body — used for client-side suffix-match safety net. */
  messageContent?: string;
}

const AGENT_TOOL_NAME = "Agent";
const toolCallCache = new WeakMap<ToolCallRecord, ToolCall>();
const thoughtSegmentCache = new WeakMap<ThoughtSegmentRecord, ThoughtSegment>();
const hookExecutionCache = new WeakMap<HookExecutionRecord, HookExecution>();

/**
 * Parse an ISO-8601 timestamp string to epoch ms. Returns 0 on parse failure
 * so chronological sort still orders unparseable rows together at the front.
 */
function isoToMs(s: string | null | undefined): number {
  if (!s) return 0;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

/** Derive a valid elapsed duration from persisted lifecycle timestamps. */
function persistedDurationMs(
  startedAt: string | null | undefined,
  completedAt: string | null | undefined,
): number | undefined {
  if (!startedAt || !completedAt) return undefined;

  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;

  return end - start;
}

function persistedToolInput(r: ToolCallRecord): Record<string, unknown> {
  if (resolveBrowserNarrativeTool(r.tool_name)) {
    try {
      const parsed: unknown = JSON.parse(r.input_summary);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return { _summary: r.input_summary };
}

/** Map a persisted tool record to the live `ToolCall` shape used by row components. */
export function recordToToolCall(r: ToolCallRecord): ToolCall {
  const cached = toolCallCache.get(r);
  if (cached) return cached;

  const durationMs = persistedDurationMs(r.started_at, r.completed_at);
  const lifecycleInput = isSubagentLifecycleRecord(r)
    ? parseSubagentLifecycleInput(r.input_summary)
    : undefined;

  const toolCall: ToolCall = {
    id: r.id,
    toolName: r.tool_name,
    // Live components only inspect a few fields; the input summary suffices
    // for label derivation in the persisted view.
    toolInput: lifecycleInput ?? {
      ...persistedToolInput(r),
      ...(r.tool_name === AGENT_TOOL_NAME && r.display_name
        ? { agentName: r.display_name }
        : {}),
    },
    output: r.output_summary || null,
    isError: r.status === "failed",
    isComplete: r.status === "completed" || r.status === "failed" || r.status === "cancelled",
    ...(r.status === "cancelled" ? { isCancelled: true } : {}),
    ...(r.output_truncated === 1 ? { outputTruncated: true } : {}),
    ...(typeof r.output_total_bytes === "number" ? { outputTotalBytes: r.output_total_bytes } : {}),
    ...(r.output_artifact_path ? { outputArtifactPath: r.output_artifact_path } : {}),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(typeof r.exit_code === "number" ? { exitCode: r.exit_code } : {}),
    parentToolCallId: r.parent_tool_call_id ?? undefined,
    startedAt: isoToMs(r.started_at),
  };
  toolCallCache.set(r, toolCall);
  return toolCall;
}

/** Map a persisted thought record to the live `ThoughtSegment` shape. */
function recordToThoughtSegment(r: ThoughtSegmentRecord): ThoughtSegment {
  const cached = thoughtSegmentCache.get(r);
  if (cached) return cached;

  const segment: ThoughtSegment = {
    text: r.text,
    startedAt: isoToMs(r.started_at),
    endedAt: r.ended_at ? isoToMs(r.ended_at) : undefined,
  };
  thoughtSegmentCache.set(r, segment);
  return segment;
}

/** Map a persisted hook record to the live `HookExecution` shape. */
export function recordToHookExecution(r: HookExecutionRecord): HookExecution {
  const cached = hookExecutionCache.get(r);
  if (cached) return cached;

  // Phase strings from server are arbitrary; coerce to the live discriminator.
  const hookType: HookExecution["hookType"] =
    r.phase === "stop" ? "stop" : "permission";
  const detailLines = persistedHookDetailLines(r);
  const hook: HookExecution = {
    hookName: r.hook_name,
    hookType,
    toolName: r.tool_name ?? undefined,
    status: "completed",
    outputLines: detailLines,
    fullOutput: detailLines,
    detailLines,
    durationMs: r.duration_ms ?? undefined,
    didBlock: r.did_block,
    startedAt: isoToMs(r.started_at),
  };
  hookExecutionCache.set(r, hook);
  return hook;
}

/** Format persisted hook metadata into bounded detail lines for HookRow. */
export function persistedHookDetailLines(r: HookExecutionRecord): string[] {
  const lines: string[] = [`phase: ${r.phase}`];
  if (r.tool_name) lines.push(`tool: ${r.tool_name}`);
  if (r.duration_ms != null) lines.push(`duration: ${r.duration_ms}ms`);
  lines.push(`blocked: ${r.did_block ? "yes" : "no"}`);
  const payload = r.payload.trim();
  if (payload.length > 0 && payload !== "{}") {
    lines.push(`payload: ${payload.length > 500 ? `${payload.slice(0, 500)}...` : payload}`);
  }
  return lines;
}

/** A unified timeline event sorted by persisted `sort_order` ascending. */
type TimelineEvent =
  | { kind: "thought"; segment: ThoughtSegment; sortOrder: number }
  | { kind: "tool"; call: ToolCall; sortOrder: number }
  | { kind: "subagent"; call: ToolCall; marker?: ToolCall; lifecycle: SubagentLifecycle; sortOrder: number }
  | { kind: "hook"; hook: HookExecution; sortOrder: number };

/**
 * Build a chronological `NarrativeItem[]` from persisted DB records.
 *
 * Mirrors `buildNarrativeItems` for the live path but sorts by the
 * server-allocated `sort_order` (not wall-clock time) and never emits a
 * `delta` or `active-tool` item — both are live-only constructs.
 *
 * Sub-agent children nest under their parent's `subagent` item via the
 * `parent_tool_call_id` field. Consecutive completed non-Agent tool calls
 * are coalesced into `tool-group` items, matching the live grouping.
 */
/**
 * WeakMap-based memo so `buildPersistedNarrativeItems` does not rebuild the
 * item tree on every render when inputs are stable. Keyed by the `thoughts`
 * array reference plus trimmed `messageContent` because suffix-match filtering
 * depends on the assistant body even when DB rows are unchanged.
 */
const _memoCache = new WeakMap<
  readonly ThoughtSegmentRecord[],
  Map<string, NarrativeItem[]>
>();

export function buildPersistedNarrativeItems(
  inputs: PersistedNarrativeInputs,
): NarrativeItem[] {
  const { tools, thoughts, hooks, messageContent } = inputs;

  if (tools.length === 0 && thoughts.length === 0 && hooks.length === 0) {
    return [];
  }

  const msgTrimmed = (messageContent ?? "").trim();
  const cachedByContent = _memoCache.get(thoughts);
  const cached = cachedByContent?.get(msgTrimmed);
  if (cached !== undefined) return cached;

  // Filter out thought segments that are the assistant's final response to
  // prevent them appearing as ThoughtBlock rows alongside the message body.
  // Server `is_final_response` is primary; client fallbacks cover older rows:
  // exact trimmed body match (any segment order) plus suffix match on the last
  // segment by sort_order.
  let filteredThoughts = thoughts;

  if (thoughts.length > 0) {
    // Find the last segment by sort_order (chronologically last).
    let maxSortOrder = -Infinity;
    for (const t of thoughts) {
      if (t.sort_order > maxSortOrder) maxSortOrder = t.sort_order;
    }
    filteredThoughts = thoughts.filter((t) => {
      if (t.is_final_response) return false;
      const segTrimmed = t.text.trim();
      if (msgTrimmed.length > 0 && segTrimmed === msgTrimmed) return false;
      // Client-side suffix match on the chronologically last segment only.
      if (t.sort_order === maxSortOrder && segTrimmed.length > 0 && msgTrimmed.endsWith(segTrimmed)) {
        return false;
      }
      return true;
    });
  }

  // Split tools by parent_tool_call_id.
  const topLevel: ToolCallRecord[] = [];
  const childrenByParent = new Map<string, ToolCallRecord[]>();
  for (const t of tools) {
    if (t.parent_tool_call_id == null) {
      topLevel.push(t);
    } else {
      const siblings = childrenByParent.get(t.parent_tool_call_id) ?? [];
      siblings.push(t);
      childrenByParent.set(t.parent_tool_call_id, siblings);
    }
  }

  // Map all hooks to live shape once.
  const liveHooks: HookExecution[] = hooks.map(recordToHookExecution);

  // Build unified timeline of TOP-LEVEL items, sorted by sort_order.
  const timeline: TimelineEvent[] = [];
  for (const seg of filteredThoughts) {
    timeline.push({
      kind: "thought",
      segment: recordToThoughtSegment(seg),
      sortOrder: seg.sort_order,
    });
  }
  for (const t of topLevel) {
    const call = recordToToolCall(t);
    if (t.tool_name !== AGENT_TOOL_NAME) {
      timeline.push({ kind: "tool", call, sortOrder: t.sort_order });
    }
  }
  const agentRecords = tools.filter((tool) => tool.tool_name === AGENT_TOOL_NAME);
  for (const t of agentRecords) {
    const call = recordToToolCall(t);

    const lifecycleMarkers = (childrenByParent.get(t.id) ?? [])
      .filter(isSubagentLifecycleRecord);
    const latestMarker = lifecycleMarkers.reduce<ToolCallRecord | undefined>(
      (latest, marker) => (!latest || marker.sort_order >= latest.sort_order ? marker : latest),
      undefined,
    );
    timeline.push({
      kind: "subagent",
      call,
      ...(latestMarker ? { marker: recordToToolCall(latestMarker) } : {}),
      lifecycle: t.status !== "running" ? "finished" : latestMarker ? "updated" : "started",
      sortOrder: t.sort_order,
    });
  }
  for (const h of hooks) {
    if (h.phase === "stop") continue;
    timeline.push({
      kind: "hook",
      hook: recordToHookExecution(h),
      sortOrder: h.sort_order,
    });
  }
  timeline.sort((a, b) => a.sortOrder - b.sortOrder);

  const items: NarrativeItem[] = [];
  const allToolCalls = tools.map(recordToToolCall);
  const pendingGroup: ToolCall[] = [];

  const flushGroup = () => {
    if (pendingGroup.length === 0) return;
    items.push({
      type: "tool-group",
      group: { calls: pendingGroup.slice() },
      hasError: pendingGroup.some((c) => c.isError),
      hasCancelled: pendingGroup.some(
        (c) => c.isCancelled === true
          || (typeof c.output === "string" && c.output.toLowerCase().includes("cancelled")),
      ),
    });
    pendingGroup.length = 0;
  };

  for (const evt of timeline) {
    if (evt.kind === "thought") {
      flushGroup();
      // Persisted thoughts are always closed — never `isActive`.
      items.push({ type: "thought", segment: evt.segment, isActive: false });
      continue;
    }

    if (evt.kind === "hook") {
      flushGroup();
      items.push({ type: "hook", hook: evt.hook });
      continue;
    }

    if (evt.kind === "subagent") {
      flushGroup();
      const childRecords = (childrenByParent.get(evt.call.id) ?? [])
        .filter((child) => !isSubagentLifecycleRecord(child));
      const children = childRecords
        .slice()
        .sort((a, b) => a.sort_order - b.sort_order)
        .map(recordToToolCall);
      items.push({
        type: "subagent",
        lifecycle: evt.lifecycle,
        toolCall: evt.call,
        participants: subagentLifecycleParticipants(evt.call, evt.marker, allToolCalls),
        children,
        hooks: liveHooks.filter((h) => h.toolName === AGENT_TOOL_NAME),
      });
      continue;
    }

    const tc = evt.call;
    // Non-Agent tool: coalesce into the current tool-group.
    pendingGroup.push(tc);
  }
  flushGroup();

  const contentCache = _memoCache.get(thoughts) ?? new Map<string, NarrativeItem[]>();
  contentCache.set(msgTrimmed, items);
  _memoCache.set(thoughts, contentCache);
  return items;
}
