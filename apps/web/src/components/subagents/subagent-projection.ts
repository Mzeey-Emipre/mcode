import { extractSubagentDescription } from "@/components/chat/narrative/extract-subagent-description";
import { extractToolInputDetail } from "@/components/chat/narrative/tool-detail";
import { TOOL_LABELS, resolveToolName } from "@/components/chat/tool-renderers/constants";
import type { FileEffect, TurnFileEffectSummary } from "@mcode/contracts";
import type { ToolCall, ToolCallRecord } from "@/transport/types";

/** Maximum live graph nodes inspected beneath a single top-level subagent. */
const MAX_SUBAGENT_GRAPH_NODES = 128;
const MAX_IDENTITY_LENGTH = 96;
const MAX_TASK_LENGTH = 280;
const MAX_ACTIVITY_LENGTH = 160;
const MAX_DETAIL_ACTIVITY = 32;

/** One bounded child action attributed to a selected Agent subtree. */
export interface SubagentDetailActivity {
  readonly id: string;
  readonly parentId?: string;
  readonly depth: number;
  readonly label: string;
  readonly detail: string;
  readonly isAgent: boolean;
  readonly isComplete: boolean;
  readonly isError: boolean;
}

/** Detail retained for a top-level delegated Agent. */
export interface SubagentDetail {
  readonly output: string;
  readonly outputTruncated: boolean;
  readonly outputTotalBytes?: number;
  readonly outputArtifactPath?: string;
  readonly activity: readonly SubagentDetailActivity[];
  readonly activityTruncated: boolean;
  readonly subtreeIds: readonly string[];
  readonly fileEffects: readonly FileEffect[];
}

/** Terminal state for a settled delegated Agent call. */
export type FinishedSubagentStatus = "completed" | "failed" | "cancelled";

/** A row shared by the Active and Finished subagent rosters. */
interface SubagentRow {
  /** Stable Agent tool-call id. */
  readonly id: string;
  /** Best surviving display identity for the delegated agent. */
  readonly identity: string;
  /** Stable delegated-task description. */
  readonly task: string;
  /** Latest provider-supplied activity or terminal result summary. */
  readonly activity: string;
  /** Epoch milliseconds for stable row ordering. */
  readonly activityAt: number;
  /** Elapsed seconds for the delegation. */
  readonly elapsedSeconds: number;
  /** Bounded data rendered by the same-panel detail view. */
  readonly detail: SubagentDetail;
}

/** A running top-level subagent row shown by the right-panel roster. */
export type LiveSubagentRow = SubagentRow;

/** A settled top-level subagent row shown by the right-panel roster. */
export interface FinishedSubagentRow extends SubagentRow {
  /** Explicit terminal outcome retained through narrative hydration. */
  readonly status: FinishedSubagentStatus;
  /** Epoch milliseconds when the Agent reached its terminal outcome. */
  readonly completedAt: number;
}

/** Reconciled roster state for the currently loaded thread narrative. */
export interface SubagentRoster {
  /** Running top-level Agent rows, newest meaningful activity first. */
  readonly active: readonly LiveSubagentRow[];
  /** Settled top-level Agent rows, newest terminal event first. */
  readonly finished: readonly FinishedSubagentRow[];
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function boundedDisplayText(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength - 1)}…`;
}

function subagentIdentity(agent: ToolCall): string {
  const input = agent.toolInput;
  const providerName = nonEmptyString(input.agentName)
    ?? nonEmptyString(input.subagentName)
    ?? nonEmptyString(input.name);
  if (providerName) return boundedDisplayText(providerName, MAX_IDENTITY_LENGTH);

  const task = extractSubagentDescription(agent);
  return task === "Running subagent" || task === "Subagent task"
    ? "Subagent"
    : boundedDisplayText(task, MAX_IDENTITY_LENGTH);
}

function hydratedTask(record: ToolCallRecord): string {
  return boundedDisplayText(nonEmptyString(record.input_summary) ?? "Subagent task", MAX_TASK_LENGTH);
}

function hydratedIdentity(record: ToolCallRecord): string {
  const task = hydratedTask(record);
  return task === "Subagent task" ? "Subagent" : boundedDisplayText(task, MAX_IDENTITY_LENGTH);
}

function activityTimestamp(call: ToolCall): number {
  return call.lastActivityAt ?? call.startedAt ?? 0;
}

function activityLabel(call: ToolCall): string {
  const toolName = resolveToolName(call.toolName);
  const label = TOOL_LABELS[toolName] ?? toolName;
  const detail = extractToolInputDetail(call);
  return boundedDisplayText(
    detail === call.toolName ? label : `${label}: ${detail}`,
    MAX_ACTIVITY_LENGTH,
  );
}

function liveStatus(call: ToolCall): "running" | FinishedSubagentStatus {
  if (!call.isComplete) return "running";
  if (call.isCancelled) return "cancelled";
  return call.isError ? "failed" : "completed";
}

function parsedTimestamp(value: string | null): number | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function elapsedSeconds(startedAt: number, completedAt: number): number {
  return Math.max(0, Math.floor((completedAt - startedAt) / 1_000));
}

function terminalLiveActivity(agent: ToolCall, fallback: string): string {
  return nonEmptyString(agent.output)
    ? boundedDisplayText(agent.output!, MAX_ACTIVITY_LENGTH)
    : fallback;
}

/**
 * Projects live calls and the current hydrated narrative into one bounded
 * per-thread roster. Persisted records win a same-ID reconciliation because
 * they carry the canonical settled status and terminal time.
 */
export function projectSubagents(
  calls: readonly ToolCall[] | undefined,
  narrativeBatches: readonly (readonly ToolCallRecord[] | undefined)[] | undefined,
  now: number = Date.now(),
  fileEffectSummary?: TurnFileEffectSummary,
): SubagentRoster {
  const liveRows = new Map<string, { row: LiveSubagentRow | FinishedSubagentRow; index: number }>();
  const childrenByParent = new Map<string, Array<{ call: ToolCall; index: number }>>();
  const topLevelAgents: Array<{ call: ToolCall; index: number }> = [];

  calls?.forEach((call, index) => {
    const parentId = call.parentToolCallId;
    if (typeof parentId === "string" && parentId.length > 0) {
      const children = childrenByParent.get(parentId) ?? [];
      children.push({ call, index });
      childrenByParent.set(parentId, children);
      return;
    }
    if (call.toolName === "Agent") topLevelAgents.push({ call, index });
  });

  for (const { call: agent, index } of topLevelAgents) {
    let latestCall = agent;
    let latestIndex = index;
    const queue = [...(childrenByParent.get(agent.id) ?? [])];
    const visited = new Set<string>([agent.id]);
    let inspected = 0;
    const descendants: Array<{ call: ToolCall; depth: number; index: number }> = [];
    const depthById = new Map<string, number>([[agent.id, 0]]);

    while (queue.length > 0 && inspected < MAX_SUBAGENT_GRAPH_NODES) {
      const next = queue.shift();
      if (!next || visited.has(next.call.id)) continue;
      visited.add(next.call.id);
      inspected += 1;
      const depth = (depthById.get(next.call.parentToolCallId ?? "") ?? 0) + 1;
      depthById.set(next.call.id, depth);
      descendants.push({ ...next, depth });

      const nextTimestamp = activityTimestamp(next.call);
      const latestTimestamp = activityTimestamp(latestCall);
      if (nextTimestamp > latestTimestamp || (nextTimestamp === latestTimestamp && next.index > latestIndex)) {
        latestCall = next.call;
        latestIndex = next.index;
      }

      const children = childrenByParent.get(next.call.id);
      if (children) queue.push(...children);
    }

    const subtreeIds = [...visited];
    const subtreeIdSet = new Set(subtreeIds);
    const detail: SubagentDetail = {
      output: nonEmptyString(agent.output) ?? "",
      outputTruncated: agent.outputTruncated === true,
      outputTotalBytes: agent.outputTotalBytes,
      outputArtifactPath: agent.outputArtifactPath,
      activity: descendants.slice(0, MAX_DETAIL_ACTIVITY).map(({ call, depth }) => {
        const canonicalName = resolveToolName(call.toolName);
        return {
          id: call.id,
          parentId: call.parentToolCallId,
          depth,
          label: TOOL_LABELS[canonicalName] ?? canonicalName,
          detail: boundedDisplayText(extractToolInputDetail(call), MAX_ACTIVITY_LENGTH),
          isAgent: call.toolName === "Agent",
          isComplete: call.isComplete,
          isError: call.isError,
        };
      }),
      activityTruncated: descendants.length > MAX_DETAIL_ACTIVITY || queue.length > 0,
      subtreeIds,
      fileEffects: fileEffectSummary?.effects.filter((effect) =>
        effect.toolCallIds.length > 0 && effect.toolCallIds.every((id) => subtreeIdSet.has(id)),
      ) ?? [],
    };

    const startedAt = agent.startedAt ?? now;
    const status = liveStatus(agent);
    const latestActivity = activityLabel(latestCall);
    if (status === "running") {
      liveRows.set(agent.id, {
        index,
        row: {
          id: agent.id,
          identity: subagentIdentity(agent),
          task: boundedDisplayText(extractSubagentDescription(agent), MAX_TASK_LENGTH),
          activity: latestActivity,
          activityAt: activityTimestamp(latestCall),
          elapsedSeconds: Math.max(0, Math.floor(agent.elapsedSeconds ?? (now - startedAt) / 1_000)),
          detail,
        },
      });
      continue;
    }

    const completedAt = agent.lastActivityAt ?? (agent.durationMs === undefined ? startedAt : startedAt + agent.durationMs);
    liveRows.set(agent.id, {
      index,
      row: {
        id: agent.id,
        identity: subagentIdentity(agent),
        task: boundedDisplayText(extractSubagentDescription(agent), MAX_TASK_LENGTH),
        activity: terminalLiveActivity(agent, latestActivity),
        activityAt: completedAt,
        elapsedSeconds: Math.max(0, Math.floor(agent.elapsedSeconds ?? (agent.durationMs ?? completedAt - startedAt) / 1_000)),
        status,
        completedAt,
        detail,
      },
    });
  }

  let persistedIndex = calls?.length ?? 0;
  for (const batch of narrativeBatches ?? []) {
    const persistedChildren = new Map<string, ToolCallRecord[]>();
    for (const child of batch ?? []) {
      if (!child.parent_tool_call_id) continue;
      const siblings = persistedChildren.get(child.parent_tool_call_id) ?? [];
      siblings.push(child);
      persistedChildren.set(child.parent_tool_call_id, siblings);
    }
    for (const record of batch ?? []) {
      if (record.tool_name !== "Agent" || record.parent_tool_call_id) continue;
      const startedAt = parsedTimestamp(record.started_at) ?? 0;
      const completedAt = parsedTimestamp(record.completed_at) ?? startedAt;
      const task = hydratedTask(record);
      const persistedVisited = new Set<string>([record.id]);
      const persistedActivity: SubagentDetailActivity[] = [];
      const persistedQueue = (persistedChildren.get(record.id) ?? []).map((child) => ({ child, depth: 1 }));
      let persistedInspected = 0;
      while (persistedQueue.length > 0 && persistedInspected < MAX_SUBAGENT_GRAPH_NODES) {
        const next = persistedQueue.shift();
        if (!next || persistedVisited.has(next.child.id)) continue;
        persistedVisited.add(next.child.id);
        persistedInspected += 1;
        if (persistedActivity.length < MAX_DETAIL_ACTIVITY) {
          const canonicalName = resolveToolName(next.child.tool_name);
          persistedActivity.push({
            id: next.child.id,
            parentId: next.child.parent_tool_call_id ?? undefined,
            depth: next.depth,
            label: TOOL_LABELS[canonicalName] ?? canonicalName,
            detail: boundedDisplayText(nonEmptyString(next.child.input_summary) ?? next.child.tool_name, MAX_ACTIVITY_LENGTH),
            isAgent: next.child.tool_name === "Agent",
            isComplete: next.child.status !== "running",
            isError: next.child.status === "failed",
          });
        }
        for (const child of persistedChildren.get(next.child.id) ?? []) {
          persistedQueue.push({ child, depth: next.depth + 1 });
        }
      }
      const base = {
        id: record.id,
        identity: hydratedIdentity(record),
        task,
        activity: boundedDisplayText(nonEmptyString(record.output_summary) ?? task, MAX_ACTIVITY_LENGTH),
        activityAt: record.status === "running" ? startedAt : completedAt,
        elapsedSeconds: elapsedSeconds(startedAt, record.status === "running" ? now : completedAt),
        detail: liveRows.get(record.id)?.row.detail ?? {
          output: nonEmptyString(record.output_summary) ?? "",
          outputTruncated: false,
          activity: persistedActivity,
          activityTruncated: persistedQueue.length > 0,
          subtreeIds: [...persistedVisited],
          fileEffects: [],
        },
      };
      const row: LiveSubagentRow | FinishedSubagentRow = record.status === "running"
        ? base
        : { ...base, status: record.status, completedAt };
      liveRows.set(record.id, { row, index: persistedIndex + record.sort_order });
    }
    persistedIndex += batch?.length ?? 0;
  }

  const active: Array<LiveSubagentRow & { index: number }> = [];
  const finished: Array<FinishedSubagentRow & { index: number }> = [];
  for (const { row, index } of liveRows.values()) {
    if ("status" in row) finished.push({ ...row, index });
    else active.push({ ...row, index });
  }

  active.sort((left, right) => right.activityAt - left.activityAt || left.index - right.index || left.id.localeCompare(right.id));
  finished.sort((left, right) => right.completedAt - left.completedAt || left.index - right.index || left.id.localeCompare(right.id));
  return {
    active: active.map(({ index: _index, ...row }) => row),
    finished: finished.map(({ index: _index, ...row }) => row),
  };
}
