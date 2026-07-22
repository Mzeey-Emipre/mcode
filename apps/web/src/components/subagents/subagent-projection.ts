import { extractSubagentDescription } from "@/components/chat/narrative/extract-subagent-description";
import { extractToolInputDetail } from "@/components/chat/narrative/tool-detail";
import { TOOL_LABELS, resolveToolName } from "@/components/chat/tool-renderers/constants";
import type { ToolCall, ToolCallRecord } from "@/transport/types";

/** Maximum live graph nodes inspected beneath a single top-level subagent. */
const MAX_SUBAGENT_GRAPH_NODES = 128;
const MAX_IDENTITY_LENGTH = 96;
const MAX_TASK_LENGTH = 280;
const MAX_ACTIVITY_LENGTH = 160;

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

    while (queue.length > 0 && inspected < MAX_SUBAGENT_GRAPH_NODES) {
      const next = queue.shift();
      if (!next || visited.has(next.call.id)) continue;
      visited.add(next.call.id);
      inspected += 1;

      const nextTimestamp = activityTimestamp(next.call);
      const latestTimestamp = activityTimestamp(latestCall);
      if (nextTimestamp > latestTimestamp || (nextTimestamp === latestTimestamp && next.index > latestIndex)) {
        latestCall = next.call;
        latestIndex = next.index;
      }

      const children = childrenByParent.get(next.call.id);
      if (children) queue.push(...children);
    }

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
      },
    });
  }

  let persistedIndex = calls?.length ?? 0;
  for (const batch of narrativeBatches ?? []) {
    for (const record of batch ?? []) {
      if (record.tool_name !== "Agent" || record.parent_tool_call_id) continue;
      const startedAt = parsedTimestamp(record.started_at) ?? 0;
      const completedAt = parsedTimestamp(record.completed_at) ?? startedAt;
      const task = hydratedTask(record);
      const base = {
        id: record.id,
        identity: hydratedIdentity(record),
        task,
        activity: boundedDisplayText(nonEmptyString(record.output_summary) ?? task, MAX_ACTIVITY_LENGTH),
        activityAt: record.status === "running" ? startedAt : completedAt,
        elapsedSeconds: elapsedSeconds(startedAt, record.status === "running" ? now : completedAt),
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
