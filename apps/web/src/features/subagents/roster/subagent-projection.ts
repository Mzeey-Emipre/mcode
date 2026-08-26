import {
  isSubagentLifecycleCall,
  isSubagentLifecycleRecord,
  extractSubagentDescription,
  extractToolInputDetail,
} from "@/features/conversation";
import { TOOL_LABELS, resolveToolName } from "@/components/chat/tool-renderers/constants";
import {
  resolveProviderAgentKey,
  createSubagentPresentation,
  resolveSubagentExactIdentity,
  resolveSubagentDisplayName,
  type FileEffect,
  type TurnFileEffectSummary,
} from "@mcode/contracts";
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
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly stepCount: number;
  readonly subagentCount: number;
  readonly output: string;
  readonly outputTruncated: boolean;
  readonly outputTotalBytes?: number;
  readonly outputArtifactPath?: string;
  readonly activity: readonly SubagentDetailActivity[];
  /** Descendant calls rebased for rendering through the main narrative flow. */
  readonly transcript: readonly ToolCall[];
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
  /** Every dispatch call represented by this logical roster row. */
  readonly memberCallIds: readonly string[];
  /** Explicit provider identity used only for safe logical grouping. */
  readonly providerAgentKey?: string;
  /** Exact receiver/native identity when provider paths are shared by parallel children. */
  readonly logicalIdentityKey?: string;
  /** Best surviving display identity for the delegated agent. */
  readonly identity: string;
  /** Whether the identity came from explicit provider or persisted metadata. */
  readonly hasExplicitIdentity: boolean;
  /** Stable delegated-task description. */
  readonly task: string;
  /** Epoch milliseconds when the delegated Agent started. */
  readonly startedAt: number;
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

function subagentIdentity(agent: ToolCall): { identity: string; hasExplicitIdentity: boolean } {
  const identity = resolveSubagentDisplayName(agent.toolInput);
  return {
    identity: identity ?? "Subagent",
    hasExplicitIdentity: identity !== undefined,
  };
}

function exactIdentityForCall(call: ToolCall, providerKey: string | undefined): string | undefined {
  const inputIdentity = resolveSubagentExactIdentity(call.toolInput);
  if (inputIdentity) return inputIdentity;
  const presentationIdentity = call.subagentPresentation?.identityKey;
  return presentationIdentity
    && presentationIdentity !== providerKey
    && presentationIdentity !== call.id
    ? presentationIdentity
    : undefined;
}

function hydratedTask(record: ToolCallRecord): string {
  return boundedDisplayText(nonEmptyString(record.input_summary) ?? "Subagent task", MAX_TASK_LENGTH);
}

function hydratedIdentity(record: ToolCallRecord): { identity: string; hasExplicitIdentity: boolean } {
  const identity = nonEmptyString(record.display_name);
  return {
    identity: boundedDisplayText(identity ?? "Subagent", MAX_IDENTITY_LENGTH),
    hasExplicitIdentity: identity !== undefined,
  };
}

function persistedRecordToToolCall(record: ToolCallRecord, rootId: string): ToolCall {
  const startedAt = parsedTimestamp(record.started_at) ?? 0;
  const completedAt = parsedTimestamp(record.completed_at);
  const subagentPresentation = record.tool_name === "Agent"
    ? createSubagentPresentation({
        ...(record.display_name ? { agentName: record.display_name } : {}),
        ...(record.provider_agent_key
          ? { codexCollabKind: "spawnAgent", agentPath: record.provider_agent_key }
          : {}),
        ...(record.subagent_identity_key ? { nativeThreadId: record.subagent_identity_key } : {}),
        ...(record.subagent_provider_name ? { subagentProviderName: record.subagent_provider_name } : {}),
        ...(record.subagent_prompt ? { prompt: record.subagent_prompt } : {}),
        ...(record.subagent_type ? { subagentType: record.subagent_type } : {}),
        ...(record.subagent_agent_id ? { agentId: record.subagent_agent_id } : {}),
        ...(typeof record.subagent_duration_ms === "number" ? { durationMs: record.subagent_duration_ms } : {}),
        ...(record.model ? { model: record.model } : {}),
        ...(record.reasoning_effort ? { reasoningEffort: record.reasoning_effort } : {}),
      }, record.provider_agent_key ?? record.id)
    : undefined;
  return {
    id: record.id,
    toolName: record.tool_name,
    toolInput: {
      _summary: record.input_summary,
      ...(record.tool_name === "Agent" && record.display_name
        ? { agentName: record.display_name }
        : {}),
      ...(record.tool_name === "Agent" && record.subagent_prompt
        ? { prompt: record.subagent_prompt }
        : {}),
      ...(record.tool_name === "Agent" && record.subagent_type
        ? { subagentType: record.subagent_type }
        : {}),
      ...(record.tool_name === "Agent" && record.subagent_agent_id
        ? { agentId: record.subagent_agent_id }
        : {}),
      ...(record.tool_name === "Agent" && typeof record.subagent_duration_ms === "number"
        ? { durationMs: record.subagent_duration_ms }
        : {}),
    },
    ...(subagentPresentation ? { subagentPresentation } : {}),
    output: nonEmptyString(record.output_summary) ?? null,
    isError: record.status === "failed",
    isComplete: record.status !== "running",
    ...(record.status === "cancelled" ? { isCancelled: true } : {}),
    ...(record.parent_tool_call_id && record.parent_tool_call_id !== rootId
      ? { parentToolCallId: record.parent_tool_call_id }
      : {}),
    ...(record.output_truncated === 1 ? { outputTruncated: true } : {}),
    ...(typeof record.output_total_bytes === "number"
      ? { outputTotalBytes: record.output_total_bytes }
      : {}),
    ...(record.output_artifact_path ? { outputArtifactPath: record.output_artifact_path } : {}),
    ...(typeof record.exit_code === "number" ? { exitCode: record.exit_code } : {}),
    startedAt,
    ...(completedAt === undefined ? {} : { lastActivityAt: completedAt, durationMs: Math.max(0, completedAt - startedAt) }),
  };
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
    if (isSubagentLifecycleCall(call)) return;
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
      model: nonEmptyString(agent.toolInput.model),
      reasoningEffort: nonEmptyString(agent.toolInput.reasoningEffort),
      stepCount: descendants.filter(({ depth }) => depth === 1).length,
      subagentCount: descendants.filter(({ call, depth }) => depth === 1 && call.toolName === "Agent").length,
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
      transcript: descendants.slice(0, MAX_DETAIL_ACTIVITY).map(({ call }) => ({
        ...call,
        ...(call.parentToolCallId === agent.id
          ? { parentToolCallId: undefined }
          : {}),
      })),
      activityTruncated: descendants.length > MAX_DETAIL_ACTIVITY || queue.length > 0,
      subtreeIds,
      fileEffects: fileEffectSummary?.effects.filter((effect) =>
        effect.toolCallIds.length > 0 && effect.toolCallIds.every((id) => subtreeIdSet.has(id)),
      ) ?? [],
    };

    const startedAt = agent.startedAt ?? now;
    const status = liveStatus(agent);
    const providerAgentKey = resolveProviderAgentKey(agent.toolInput);
    const logicalIdentityKey = exactIdentityForCall(agent, providerAgentKey);
    const latestActivity = latestCall.id === agent.id
      ? status === "running"
        ? "Working"
        : status === "failed"
          ? "Errored"
          : status === "cancelled"
            ? "Cancelled"
            : "Finished"
      : activityLabel(latestCall);
    if (status === "running") {
      liveRows.set(agent.id, {
        index,
        row: {
          id: agent.id,
          memberCallIds: [agent.id],
          providerAgentKey,
          logicalIdentityKey,
          ...subagentIdentity(agent),
          task: boundedDisplayText(extractSubagentDescription(agent), MAX_TASK_LENGTH),
          startedAt,
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
        memberCallIds: [agent.id],
        providerAgentKey,
        logicalIdentityKey,
        ...subagentIdentity(agent),
        task: boundedDisplayText(extractSubagentDescription(agent), MAX_TASK_LENGTH),
        startedAt,
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
      if (isSubagentLifecycleRecord(child)) continue;
      if (!child.parent_tool_call_id) continue;
      const siblings = persistedChildren.get(child.parent_tool_call_id) ?? [];
      siblings.push(child);
      persistedChildren.set(child.parent_tool_call_id, siblings);
    }
    for (const record of batch ?? []) {
      if (isSubagentLifecycleRecord(record)) continue;
      if (record.tool_name !== "Agent" || record.parent_tool_call_id) continue;
      const startedAt = parsedTimestamp(record.started_at) ?? 0;
      const completedAt = parsedTimestamp(record.completed_at) ?? startedAt;
      const task = hydratedTask(record);
      const liveRow = liveRows.get(record.id)?.row;
      const persistedIdentity = hydratedIdentity(record);
      const identity = persistedIdentity.hasExplicitIdentity || !liveRow?.hasExplicitIdentity
        ? persistedIdentity
        : { identity: liveRow.identity, hasExplicitIdentity: true };
      const persistedVisited = new Set<string>([record.id]);
      const persistedActivity: SubagentDetailActivity[] = [];
      const persistedTranscript: ToolCall[] = [];
      const persistedQueue = (persistedChildren.get(record.id) ?? []).map((child) => ({ child, depth: 1 }));
      let persistedInspected = 0;
      let persistedStepCount = 0;
      let persistedSubagentCount = 0;
      while (persistedQueue.length > 0 && persistedInspected < MAX_SUBAGENT_GRAPH_NODES) {
        const next = persistedQueue.shift();
        if (!next || persistedVisited.has(next.child.id)) continue;
        persistedVisited.add(next.child.id);
        persistedInspected += 1;
        if (next.depth === 1) {
          persistedStepCount += 1;
          if (next.child.tool_name === "Agent") persistedSubagentCount += 1;
        }
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
          persistedTranscript.push(persistedRecordToToolCall(next.child, record.id));
        }
        for (const child of persistedChildren.get(next.child.id) ?? []) {
          persistedQueue.push({ child, depth: next.depth + 1 });
        }
      }
      const base = {
        id: record.id,
        memberCallIds: [record.id],
        providerAgentKey: nonEmptyString(record.provider_agent_key),
        logicalIdentityKey: record.subagent_identity_key ?? undefined,
        ...identity,
        task,
        startedAt,
        activity: boundedDisplayText(nonEmptyString(record.output_summary) ?? task, MAX_ACTIVITY_LENGTH),
        activityAt: record.status === "running" ? startedAt : completedAt,
        elapsedSeconds: elapsedSeconds(startedAt, record.status === "running" ? now : completedAt),
        detail: liveRow?.detail ?? {
          model: nonEmptyString(record.model),
          reasoningEffort: nonEmptyString(record.reasoning_effort),
          stepCount: persistedStepCount,
          subagentCount: persistedSubagentCount,
          output: nonEmptyString(record.output_summary) ?? "",
          outputTruncated: (record.output_truncated ?? 0) > 0,
          outputTotalBytes: record.output_total_bytes ?? undefined,
          outputArtifactPath: record.output_artifact_path ?? undefined,
          activity: persistedActivity,
          transcript: persistedTranscript,
          activityTruncated: persistedInspected > MAX_DETAIL_ACTIVITY || persistedQueue.length > 0,
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

  const active: Array<LiveSubagentRow & { index: number; orderAt: number }> = [];
  const finished: Array<FinishedSubagentRow & { index: number; orderAt: number }> = [];
  const logicalGroups = new Map<string, Array<{ row: LiveSubagentRow | FinishedSubagentRow; index: number }>>();
  const providerGroupKeys = new Map<string, string>();
  const exactGroupKeys = new Map<string, string>();
  const groupsWithExactIdentity = new Set<string>();
  for (const member of liveRows.values()) {
    const providerKey = member.row.providerAgentKey;
    const exactIdentity = member.row.logicalIdentityKey;
    let groupKey = exactIdentity ? exactGroupKeys.get(exactIdentity) : undefined;
    if (!groupKey && providerKey) {
      const providerGroup = providerGroupKeys.get(providerKey);
      if (providerGroup && (!exactIdentity || !groupsWithExactIdentity.has(providerGroup))) {
        groupKey = providerGroup;
      }
    }
    if (!groupKey) {
      groupKey = exactIdentity
        ? `identity:${exactIdentity}`
        : providerKey
          ? `provider:${providerKey}`
          : `call:${member.row.id}`;
    }
    if (exactIdentity) {
      exactGroupKeys.set(exactIdentity, groupKey);
      groupsWithExactIdentity.add(groupKey);
    }
    if (providerKey && !providerGroupKeys.has(providerKey)) {
      providerGroupKeys.set(providerKey, groupKey);
    }
    const group = logicalGroups.get(groupKey) ?? [];
    group.push(member);
    logicalGroups.set(groupKey, group);
  }

  for (const members of logicalGroups.values()) {
    const representative = [...members].sort((left, right) =>
      right.index - left.index
      || right.row.id.localeCompare(left.row.id)
    )[0]!;
    const isActive = members.some(({ row }) => !("status" in row));
    const orderAt = Math.max(...members.map(({ row }) =>
      "completedAt" in row ? row.completedAt : row.activityAt
    ));
    const allSubtreeIds = [...new Set(members.flatMap(({ row }) => row.detail.subtreeIds))];
    const subtreeIds = allSubtreeIds.slice(0, MAX_SUBAGENT_GRAPH_NODES);
    const subtreeIdSet = new Set(allSubtreeIds);
    const activity = members.flatMap(({ row }) => row.detail.activity);
    const transcript = members.flatMap(({ row }) => row.detail.transcript);
    const fileEffects = new Map<string, FileEffect>();
    const trustworthyEffects = fileEffectSummary?.effects.filter((effect) =>
      effect.toolCallIds.length > 0 && effect.toolCallIds.every((id) => subtreeIdSet.has(id)),
    ) ?? members.flatMap(({ row }) => row.detail.fileEffects);
    for (const effect of trustworthyEffects) {
      const key = `${effect.scope}:${effect.kind}:${effect.path}:${effect.toolCallIds.join(",")}`;
      if (!fileEffects.has(key)) fileEffects.set(key, effect);
    }
    const detail: SubagentDetail = {
      ...representative.row.detail,
      stepCount: members.reduce((total, { row }) => total + row.detail.stepCount, 0),
      subagentCount: members.reduce((total, { row }) => total + row.detail.subagentCount, 0),
      activity: activity.slice(0, MAX_DETAIL_ACTIVITY),
      transcript: transcript.slice(0, MAX_DETAIL_ACTIVITY),
      activityTruncated: members.some(({ row }) => row.detail.activityTruncated)
        || activity.length > MAX_DETAIL_ACTIVITY
        || transcript.length > MAX_DETAIL_ACTIVITY
        || allSubtreeIds.length > MAX_SUBAGENT_GRAPH_NODES,
      subtreeIds,
      fileEffects: [...fileEffects.values()],
    };
    const shared: LiveSubagentRow & { index: number; orderAt: number } = {
      id: representative.row.id,
      memberCallIds: members.map(({ row }) => row.id),
      providerAgentKey: representative.row.providerAgentKey,
      logicalIdentityKey: representative.row.logicalIdentityKey,
      identity: representative.row.identity,
      hasExplicitIdentity: representative.row.hasExplicitIdentity,
      task: representative.row.task,
      startedAt: representative.row.startedAt,
      activity: representative.row.activity,
      activityAt: representative.row.activityAt,
      elapsedSeconds: members.reduce((total, { row }) => total + row.elapsedSeconds, 0),
      detail,
      index: representative.index,
      orderAt,
    };
    if (isActive) {
      active.push(shared);
    } else if ("status" in representative.row) {
      finished.push({
        ...shared,
        status: representative.row.status,
        completedAt: representative.row.completedAt,
      });
    }
  }

  active.sort((left, right) => right.orderAt - left.orderAt || left.index - right.index || left.id.localeCompare(right.id));
  finished.sort((left, right) => right.orderAt - left.orderAt || left.index - right.index || left.id.localeCompare(right.id));
  return {
    active: active.map(({ index: _index, orderAt: _orderAt, ...row }) => row),
    finished: finished.map(({ index: _index, orderAt: _orderAt, ...row }) => row),
  };
}
