import { extractSubagentDescription } from "@/components/chat/narrative/extract-subagent-description";
import { extractToolInputDetail } from "@/components/chat/narrative/tool-detail";
import { TOOL_LABELS, resolveToolName } from "@/components/chat/tool-renderers/constants";
import type { ToolCall } from "@/transport/types";

/** Maximum live graph nodes inspected beneath a single top-level subagent. */
const MAX_SUBAGENT_GRAPH_NODES = 128;
const MAX_IDENTITY_LENGTH = 96;
const MAX_TASK_LENGTH = 280;
const MAX_ACTIVITY_LENGTH = 160;

/** A live top-level subagent row shown by the right-panel roster. */
export interface LiveSubagentRow {
  /** Stable Agent tool-call id. */
  readonly id: string;
  /** Best provider-supplied display identity available for the delegated agent. */
  readonly identity: string;
  /** Stable delegated-task description. */
  readonly task: string;
  /** Most recent provider-supplied tool activity in the Agent graph. */
  readonly activity: string;
  /** Epoch milliseconds for stable latest-activity ordering. */
  readonly activityAt: number;
  /** Elapsed seconds for the running delegation. */
  readonly elapsedSeconds: number;
}

/** Live-only roster state derived from one thread's normalized tool-call graph. */
export interface LiveSubagentRoster {
  /** Running top-level Agent rows, newest meaningful activity first. */
  readonly active: readonly LiveSubagentRow[];
  /** Completed top-level Agent boundaries still present in the live turn. */
  readonly finishedCount: number;
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

/**
 * Projects the current thread's normalized tool-call graph into live roster rows.
 *
 * Only top-level Agent calls form rows. Descendant traversal is bounded and
 * cycle-safe so malformed provider parent links cannot expand render work.
 */
export function projectLiveSubagents(
  calls: readonly ToolCall[] | undefined,
  now: number = Date.now(),
): LiveSubagentRoster {
  if (!calls?.length) return { active: [], finishedCount: 0 };

  const childrenByParent = new Map<string, Array<{ call: ToolCall; index: number }>>();
  const topLevelAgents: Array<{ call: ToolCall; index: number }> = [];

  calls.forEach((call, index) => {
    const parentId = call.parentToolCallId;
    if (typeof parentId === "string" && parentId.length > 0) {
      const children = childrenByParent.get(parentId) ?? [];
      children.push({ call, index });
      childrenByParent.set(parentId, children);
      return;
    }
    if (call.toolName === "Agent") topLevelAgents.push({ call, index });
  });

  const active: Array<LiveSubagentRow & { index: number }> = [];
  let finishedCount = 0;

  for (const { call: agent, index } of topLevelAgents) {
    if (agent.isComplete) {
      finishedCount += 1;
      continue;
    }

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
    active.push({
      id: agent.id,
      identity: subagentIdentity(agent),
      task: boundedDisplayText(extractSubagentDescription(agent), MAX_TASK_LENGTH),
      activity: activityLabel(latestCall),
      activityAt: activityTimestamp(latestCall),
      elapsedSeconds: Math.max(0, Math.floor(agent.elapsedSeconds ?? (now - startedAt) / 1000)),
      index,
    });
  }

  active.sort((left, right) => right.activityAt - left.activityAt || left.index - right.index);
  return {
    active: active.map(({ index: _index, ...row }) => row),
    finishedCount,
  };
}
