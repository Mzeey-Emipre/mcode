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

function addPersistedAgentPresentationMetadata(
  input: Record<string, unknown>,
  record: ToolCallRecord,
): void {
  addPersistedTextField(input, "agentName", record.display_name);
  addPersistedProviderAgentInput(input, record.provider_agent_key);
  addPersistedTextField(input, "nativeThreadId", record.subagent_identity_key);
  addPersistedTextField(input, "subagentProviderName", record.subagent_provider_name);
  addPersistedTextField(input, "prompt", record.subagent_prompt);
  addPersistedTextField(input, "subagentType", record.subagent_type);
  addPersistedTextField(input, "agentId", record.subagent_agent_id);
  addPersistedNumberField(input, "durationMs", record.subagent_duration_ms);
  addPersistedTextField(input, "model", record.model);
  addPersistedTextField(input, "reasoningEffort", record.reasoning_effort);
}

function persistedAgentPresentationInput(record: ToolCallRecord): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  addPersistedAgentPresentationMetadata(input, record);
  return input;
}

function persistedTranscriptToolInput(record: ToolCallRecord): Record<string, unknown> {
  const input: Record<string, unknown> = { _summary: record.input_summary };
  if (record.tool_name !== "Agent") return input;
  addPersistedTextField(input, "agentName", record.display_name);
  addPersistedTextField(input, "prompt", record.subagent_prompt);
  addPersistedTextField(input, "subagentType", record.subagent_type);
  addPersistedTextField(input, "agentId", record.subagent_agent_id);
  addPersistedNumberField(input, "durationMs", record.subagent_duration_ms);
  return input;
}

function persistedSubagentPresentation(
  record: ToolCallRecord,
): ToolCall["subagentPresentation"] {
  if (record.tool_name !== "Agent") return undefined;
  return createSubagentPresentation(
    persistedAgentPresentationInput(record),
    record.provider_agent_key ?? record.id,
  );
}

function persistedTranscriptParentField(
  record: ToolCallRecord,
  rootId: string,
): Partial<Pick<ToolCall, "parentToolCallId">> {
  if (!record.parent_tool_call_id || record.parent_tool_call_id === rootId) return {};
  return { parentToolCallId: record.parent_tool_call_id };
}

function persistedTranscriptOptionalFields(
  record: ToolCallRecord,
  startedAt: number,
  completedAt: number | undefined,
): Partial<Pick<ToolCall, "isCancelled" | "outputTruncated" | "outputTotalBytes" | "outputArtifactPath" | "exitCode" | "lastActivityAt" | "durationMs">> {
  const fields: Partial<Pick<ToolCall, "isCancelled" | "outputTruncated" | "outputTotalBytes" | "outputArtifactPath" | "exitCode" | "lastActivityAt" | "durationMs">> = {};
  if (record.status === "cancelled") fields.isCancelled = true;
  if (record.output_truncated === 1) fields.outputTruncated = true;
  if (typeof record.output_total_bytes === "number") fields.outputTotalBytes = record.output_total_bytes;
  if (record.output_artifact_path) fields.outputArtifactPath = record.output_artifact_path;
  if (typeof record.exit_code === "number") fields.exitCode = record.exit_code;
  if (completedAt === undefined) return fields;
  fields.lastActivityAt = completedAt;
  fields.durationMs = Math.max(0, completedAt - startedAt);
  return fields;
}

function persistedRecordToToolCall(record: ToolCallRecord, rootId: string): ToolCall {
  const startedAt = parsedTimestamp(record.started_at) ?? 0;
  const completedAt = parsedTimestamp(record.completed_at);
  const subagentPresentation = persistedSubagentPresentation(record);
  return {
    id: record.id,
    toolName: record.tool_name,
    toolInput: persistedTranscriptToolInput(record),
    ...(subagentPresentation ? { subagentPresentation } : {}),
    output: nonEmptyString(record.output_summary) ?? null,
    isError: record.status === "failed",
    isComplete: record.status !== "running",
    ...persistedTranscriptParentField(record, rootId),
    ...persistedTranscriptOptionalFields(record, startedAt, completedAt),
    startedAt,
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

interface IndexedToolCall {
  readonly call: ToolCall;
  readonly index: number;
}

interface LiveDescendant extends IndexedToolCall {
  readonly depth: number;
}

interface LiveSubtree {
  readonly descendants: readonly LiveDescendant[];
  readonly subtreeIds: readonly string[];
  readonly activityTruncated: boolean;
}

interface PersistedDescendant {
  readonly record: ToolCallRecord;
  readonly depth: number;
}

interface PersistedSubtree {
  readonly descendants: readonly PersistedDescendant[];
  readonly subtreeIds: readonly string[];
  readonly activityTruncated: boolean;
}

type ProjectedSubagentRow = LiveSubagentRow | FinishedSubagentRow;

interface IndexedSubagentRow {
  readonly row: ProjectedSubagentRow;
  readonly index: number;
}

interface OrderedSubagentRow {
  readonly row: ProjectedSubagentRow;
  readonly index: number;
  readonly orderAt: number;
}

interface OrderedLiveSubagentRow {
  readonly row: LiveSubagentRow;
  readonly index: number;
  readonly orderAt: number;
}

interface OrderedFinishedSubagentRow {
  readonly row: FinishedSubagentRow;
  readonly index: number;
  readonly orderAt: number;
}

interface LogicalGroupState {
  readonly groups: Map<string, IndexedSubagentRow[]>;
  readonly providerGroupKeys: Map<string, string>;
  readonly exactGroupKeys: Map<string, string>;
  readonly groupsWithExactIdentity: Set<string>;
}

function indexLiveCalls(calls: readonly ToolCall[] | undefined): {
  childrenByParent: Map<string, IndexedToolCall[]>;
  topLevelAgents: IndexedToolCall[];
} {
  const childrenByParent = new Map<string, IndexedToolCall[]>();
  const topLevelAgents: IndexedToolCall[] = [];
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
  return { childrenByParent, topLevelAgents };
}

function liveSubtree(rootId: string, childrenByParent: ReadonlyMap<string, readonly IndexedToolCall[]>): LiveSubtree {
  const queue = (childrenByParent.get(rootId) ?? []).map((child) => ({ ...child, depth: 1 }));
  const descendants: LiveDescendant[] = [];
  const visited = new Set<string>([rootId]);
  let inspected = 0;

  while (queue.length > 0 && inspected < MAX_SUBAGENT_GRAPH_NODES) {
    const next = queue.shift()!;
    if (visited.has(next.call.id)) continue;
    visited.add(next.call.id);
    descendants.push(next);
    inspected += 1;
    for (const child of childrenByParent.get(next.call.id) ?? []) {
      queue.push({ ...child, depth: next.depth + 1 });
    }
  }

  return {
    descendants,
    subtreeIds: [...visited],
    activityTruncated: descendants.length > MAX_DETAIL_ACTIVITY || queue.length > 0,
  };
}

function isNewerActivity(candidate: IndexedToolCall, current: IndexedToolCall): boolean {
  const candidateTimestamp = activityTimestamp(candidate.call);
  const currentTimestamp = activityTimestamp(current.call);
  return candidateTimestamp > currentTimestamp
    || (candidateTimestamp === currentTimestamp && candidate.index > current.index);
}

function latestLiveActivity(root: IndexedToolCall, descendants: readonly LiveDescendant[]): IndexedToolCall {
  return descendants.reduce<IndexedToolCall>(
    (latest, descendant) => isNewerActivity(descendant, latest) ? descendant : latest,
    root,
  );
}

function statusActivity(status: "running" | FinishedSubagentStatus): string {
  if (status === "running") return "Working";
  if (status === "failed") return "Errored";
  if (status === "cancelled") return "Cancelled";
  return "Finished";
}

function rowActivity(agent: ToolCall, latest: ToolCall, status: "running" | FinishedSubagentStatus): string {
  return latest.id === agent.id ? statusActivity(status) : activityLabel(latest);
}

function liveCompletionAt(agent: ToolCall, startedAt: number): number {
  return agent.lastActivityAt ?? (agent.durationMs === undefined ? startedAt : startedAt + agent.durationMs);
}

function liveElapsedSeconds(agent: ToolCall, startedAt: number, completedAt: number, now: number): number {
  const elapsedMilliseconds = agent.elapsedSeconds === undefined
    ? (agent.isComplete ? agent.durationMs ?? completedAt - startedAt : now - startedAt)
    : agent.elapsedSeconds * 1_000;
  return Math.max(0, Math.floor(elapsedMilliseconds / 1_000));
}

function detailFileEffects(
  fileEffectSummary: TurnFileEffectSummary | undefined,
  subtreeIds: readonly string[],
): readonly FileEffect[] {
  const subtreeIdSet = new Set(subtreeIds);
  return fileEffectSummary?.effects.filter((effect) =>
    effect.toolCallIds.length > 0 && effect.toolCallIds.every((id) => subtreeIdSet.has(id)),
  ) ?? [];
}

function liveSubagentDetail(
  agent: ToolCall,
  subtree: LiveSubtree,
  fileEffectSummary: TurnFileEffectSummary | undefined,
): SubagentDetail {
  return {
    model: nonEmptyString(agent.toolInput.model),
    reasoningEffort: nonEmptyString(agent.toolInput.reasoningEffort),
    stepCount: subtree.descendants.filter(({ depth }) => depth === 1).length,
    subagentCount: subtree.descendants.filter(({ call, depth }) => depth === 1 && call.toolName === "Agent").length,
    output: nonEmptyString(agent.output) ?? "",
    outputTruncated: agent.outputTruncated === true,
    outputTotalBytes: agent.outputTotalBytes,
    outputArtifactPath: agent.outputArtifactPath,
    activity: subtree.descendants.slice(0, MAX_DETAIL_ACTIVITY).map(({ call, depth }) => {
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
    transcript: subtree.descendants.slice(0, MAX_DETAIL_ACTIVITY).map(({ call }) => ({
      ...call,
      ...(call.parentToolCallId === agent.id ? { parentToolCallId: undefined } : {}),
    })),
    activityTruncated: subtree.activityTruncated,
    subtreeIds: subtree.subtreeIds,
    fileEffects: detailFileEffects(fileEffectSummary, subtree.subtreeIds),
  };
}

function liveSubagentRow(
  indexedAgent: IndexedToolCall,
  childrenByParent: ReadonlyMap<string, readonly IndexedToolCall[]>,
  now: number,
  fileEffectSummary: TurnFileEffectSummary | undefined,
): ProjectedSubagentRow {
  const { call: agent } = indexedAgent;
  const subtree = liveSubtree(agent.id, childrenByParent);
  const latest = latestLiveActivity(indexedAgent, subtree.descendants);
  const status = liveStatus(agent);
  const startedAt = agent.startedAt ?? now;
  const completedAt = liveCompletionAt(agent, startedAt);
  const providerAgentKey = resolveProviderAgentKey(agent.toolInput);
  const detail = liveSubagentDetail(agent, subtree, fileEffectSummary);
  const activity = rowActivity(agent, latest.call, status);
  const base: SubagentRow = {
    id: agent.id,
    memberCallIds: [agent.id],
    providerAgentKey,
    logicalIdentityKey: exactIdentityForCall(agent, providerAgentKey),
    ...subagentIdentity(agent),
    task: boundedDisplayText(extractSubagentDescription(agent), MAX_TASK_LENGTH),
    startedAt,
    activity: status === "running" ? activity : terminalLiveActivity(agent, activity),
    activityAt: status === "running" ? activityTimestamp(latest.call) : completedAt,
    elapsedSeconds: liveElapsedSeconds(agent, startedAt, completedAt, now),
    detail,
  };
  return status === "running" ? base : { ...base, status, completedAt };
}

function liveSubagentRows(
  calls: readonly ToolCall[] | undefined,
  now: number,
  fileEffectSummary: TurnFileEffectSummary | undefined,
): Map<string, IndexedSubagentRow> {
  const { childrenByParent, topLevelAgents } = indexLiveCalls(calls);
  const rows = new Map<string, IndexedSubagentRow>();
  for (const agent of topLevelAgents) {
    rows.set(agent.call.id, {
      row: liveSubagentRow(agent, childrenByParent, now, fileEffectSummary),
      index: agent.index,
    });
  }
  return rows;
}

function persistedChildrenByParent(batch: readonly ToolCallRecord[] | undefined): Map<string, ToolCallRecord[]> {
  const childrenByParent = new Map<string, ToolCallRecord[]>();
  for (const record of batch ?? []) {
    if (isSubagentLifecycleRecord(record) || !record.parent_tool_call_id) continue;
    const children = childrenByParent.get(record.parent_tool_call_id) ?? [];
    children.push(record);
    childrenByParent.set(record.parent_tool_call_id, children);
  }
  return childrenByParent;
}

function persistedSubtree(
  rootId: string,
  childrenByParent: ReadonlyMap<string, readonly ToolCallRecord[]>,
): PersistedSubtree {
  const queue = (childrenByParent.get(rootId) ?? []).map((record) => ({ record, depth: 1 }));
  const descendants: PersistedDescendant[] = [];
  const visited = new Set<string>([rootId]);
  let inspected = 0;

  while (queue.length > 0 && inspected < MAX_SUBAGENT_GRAPH_NODES) {
    const next = queue.shift()!;
    if (visited.has(next.record.id)) continue;
    visited.add(next.record.id);
    descendants.push(next);
    inspected += 1;
    for (const child of childrenByParent.get(next.record.id) ?? []) {
      queue.push({ record: child, depth: next.depth + 1 });
    }
  }

  return {
    descendants,
    subtreeIds: [...visited],
    activityTruncated: descendants.length > MAX_DETAIL_ACTIVITY || queue.length > 0,
  };
}

function persistedSubagentDetail(record: ToolCallRecord, subtree: PersistedSubtree): SubagentDetail {
  return {
    model: nonEmptyString(record.model),
    reasoningEffort: nonEmptyString(record.reasoning_effort),
    stepCount: subtree.descendants.filter(({ depth }) => depth === 1).length,
    subagentCount: subtree.descendants.filter(({ record: child, depth }) => depth === 1 && child.tool_name === "Agent").length,
    output: nonEmptyString(record.output_summary) ?? "",
    outputTruncated: (record.output_truncated ?? 0) > 0,
    outputTotalBytes: record.output_total_bytes ?? undefined,
    outputArtifactPath: record.output_artifact_path ?? undefined,
    activity: subtree.descendants.slice(0, MAX_DETAIL_ACTIVITY).map(({ record: child, depth }) => {
      const canonicalName = resolveToolName(child.tool_name);
      return {
        id: child.id,
        parentId: child.parent_tool_call_id ?? undefined,
        depth,
        label: TOOL_LABELS[canonicalName] ?? canonicalName,
        detail: boundedDisplayText(nonEmptyString(child.input_summary) ?? child.tool_name, MAX_ACTIVITY_LENGTH),
        isAgent: child.tool_name === "Agent",
        isComplete: child.status !== "running",
        isError: child.status === "failed",
      };
    }),
    transcript: subtree.descendants.slice(0, MAX_DETAIL_ACTIVITY).map(({ record: child }) =>
      persistedRecordToToolCall(child, record.id)),
    activityTruncated: subtree.activityTruncated,
    subtreeIds: subtree.subtreeIds,
    fileEffects: [],
  };
}

function isTopLevelPersistedAgent(record: ToolCallRecord): boolean {
  return !isSubagentLifecycleRecord(record)
    && record.tool_name === "Agent"
    && !record.parent_tool_call_id;
}

function reconciledIdentity(record: ToolCallRecord, liveRow: ProjectedSubagentRow | undefined): {
  identity: string;
  hasExplicitIdentity: boolean;
} {
  const persistedIdentity = hydratedIdentity(record);
  return persistedIdentity.hasExplicitIdentity || !liveRow?.hasExplicitIdentity
    ? persistedIdentity
    : { identity: liveRow.identity, hasExplicitIdentity: true };
}

function persistedSubagentRow(
  record: ToolCallRecord,
  childrenByParent: ReadonlyMap<string, readonly ToolCallRecord[]>,
  liveRow: ProjectedSubagentRow | undefined,
  now: number,
): ProjectedSubagentRow {
  const startedAt = parsedTimestamp(record.started_at) ?? 0;
  const completedAt = parsedTimestamp(record.completed_at) ?? startedAt;
  const task = hydratedTask(record);
  const base: SubagentRow = {
    id: record.id,
    memberCallIds: [record.id],
    providerAgentKey: nonEmptyString(record.provider_agent_key),
    logicalIdentityKey: record.subagent_identity_key ?? undefined,
    ...reconciledIdentity(record, liveRow),
    task,
    startedAt,
    activity: boundedDisplayText(nonEmptyString(record.output_summary) ?? task, MAX_ACTIVITY_LENGTH),
    activityAt: record.status === "running" ? startedAt : completedAt,
    elapsedSeconds: elapsedSeconds(startedAt, record.status === "running" ? now : completedAt),
    detail: liveRow?.detail ?? persistedSubagentDetail(record, persistedSubtree(record.id, childrenByParent)),
  };
  return record.status === "running" ? base : { ...base, status: record.status, completedAt };
}

function persistedRowsForBatch(
  batch: readonly ToolCallRecord[] | undefined,
  liveRows: ReadonlyMap<string, IndexedSubagentRow>,
  now: number,
  persistedIndex: number,
): IndexedSubagentRow[] {
  const childrenByParent = persistedChildrenByParent(batch);
  return (batch ?? []).flatMap((record) => {
    if (!isTopLevelPersistedAgent(record)) return [];
    return [{
      row: persistedSubagentRow(record, childrenByParent, liveRows.get(record.id)?.row, now),
      index: persistedIndex + record.sort_order,
    }];
  });
}

function addPersistedRows(
  liveRows: Map<string, IndexedSubagentRow>,
  calls: readonly ToolCall[] | undefined,
  narrativeBatches: readonly (readonly ToolCallRecord[] | undefined)[] | undefined,
  now: number,
): void {
  let persistedIndex = calls?.length ?? 0;
  for (const batch of narrativeBatches ?? []) {
    for (const row of persistedRowsForBatch(batch, liveRows, now, persistedIndex)) {
      liveRows.set(row.row.id, row);
    }
    persistedIndex += batch?.length ?? 0;
  }
}

function providerGroupKey(member: IndexedSubagentRow, state: LogicalGroupState): string | undefined {
  const providerKey = member.row.providerAgentKey;
  if (!providerKey) return undefined;
  const groupKey = state.providerGroupKeys.get(providerKey);
  if (!groupKey) return undefined;
  return !member.row.logicalIdentityKey || !state.groupsWithExactIdentity.has(groupKey)
    ? groupKey
    : undefined;
}

function fallbackGroupKey(member: IndexedSubagentRow): string {
  if (member.row.logicalIdentityKey) return `identity:${member.row.logicalIdentityKey}`;
  if (member.row.providerAgentKey) return `provider:${member.row.providerAgentKey}`;
  return `call:${member.row.id}`;
}

function groupKeyForMember(member: IndexedSubagentRow, state: LogicalGroupState): string {
  const exactIdentity = member.row.logicalIdentityKey;
  const exactGroupKey = exactIdentity ? state.exactGroupKeys.get(exactIdentity) : undefined;
  const groupKey = exactGroupKey ?? providerGroupKey(member, state) ?? fallbackGroupKey(member);
  if (exactIdentity) {
    state.exactGroupKeys.set(exactIdentity, groupKey);
    state.groupsWithExactIdentity.add(groupKey);
  }
  const providerKey = member.row.providerAgentKey;
  if (providerKey && !state.providerGroupKeys.has(providerKey)) {
    state.providerGroupKeys.set(providerKey, groupKey);
  }
  return groupKey;
}

function logicalGroups(rows: ReadonlyMap<string, IndexedSubagentRow>): Map<string, IndexedSubagentRow[]> {
  const state: LogicalGroupState = {
    groups: new Map(),
    providerGroupKeys: new Map(),
    exactGroupKeys: new Map(),
    groupsWithExactIdentity: new Set(),
  };
  for (const member of rows.values()) {
    const groupKey = groupKeyForMember(member, state);
    const group = state.groups.get(groupKey);
    if (group) group.push(member);
    else state.groups.set(groupKey, [member]);
  }
  return state.groups;
}

function isFinishedSubagentRow(row: ProjectedSubagentRow): row is FinishedSubagentRow {
  return "status" in row;
}

function requireFinishedSubagentRow(row: ProjectedSubagentRow): FinishedSubagentRow {
  if (isFinishedSubagentRow(row)) return row;
  throw new Error("A settled subagent group must have a settled representative.");
}

function representativeIsNewer(candidate: IndexedSubagentRow, current: IndexedSubagentRow): boolean {
  return candidate.index > current.index
    || (candidate.index === current.index && candidate.row.id.localeCompare(current.row.id) > 0);
}

function groupRepresentative(members: readonly IndexedSubagentRow[]): IndexedSubagentRow {
  return members.reduce((latest, member) => representativeIsNewer(member, latest) ? member : latest);
}

function groupOrderAt(members: readonly IndexedSubagentRow[]): number {
  return Math.max(...members.map(({ row }) =>
    isFinishedSubagentRow(row) ? row.completedAt : row.activityAt));
}

function groupedFileEffects(
  fileEffectSummary: TurnFileEffectSummary | undefined,
  members: readonly IndexedSubagentRow[],
  subtreeIdSet: ReadonlySet<string>,
): readonly FileEffect[] {
  const effects = fileEffectSummary?.effects.filter((effect) =>
    effect.toolCallIds.length > 0 && effect.toolCallIds.every((id) => subtreeIdSet.has(id)),
  ) ?? members.flatMap(({ row }) => row.detail.fileEffects);
  const uniqueEffects = new Map<string, FileEffect>();
  for (const effect of effects) {
    const key = `${effect.scope}:${effect.kind}:${effect.path}:${effect.toolCallIds.join(",")}`;
    if (!uniqueEffects.has(key)) uniqueEffects.set(key, effect);
  }
  return [...uniqueEffects.values()];
}

function groupedDetail(
  representative: IndexedSubagentRow,
  members: readonly IndexedSubagentRow[],
  fileEffectSummary: TurnFileEffectSummary | undefined,
): SubagentDetail {
  const allSubtreeIds = [...new Set(members.flatMap(({ row }) => row.detail.subtreeIds))];
  const activity = members.flatMap(({ row }) => row.detail.activity);
  const transcript = members.flatMap(({ row }) => row.detail.transcript);
  return {
    ...representative.row.detail,
    stepCount: members.reduce((total, { row }) => total + row.detail.stepCount, 0),
    subagentCount: members.reduce((total, { row }) => total + row.detail.subagentCount, 0),
    activity: activity.slice(0, MAX_DETAIL_ACTIVITY),
    transcript: transcript.slice(0, MAX_DETAIL_ACTIVITY),
    activityTruncated: members.some(({ row }) => row.detail.activityTruncated)
      || activity.length > MAX_DETAIL_ACTIVITY
      || transcript.length > MAX_DETAIL_ACTIVITY
      || allSubtreeIds.length > MAX_SUBAGENT_GRAPH_NODES,
    subtreeIds: allSubtreeIds.slice(0, MAX_SUBAGENT_GRAPH_NODES),
    fileEffects: groupedFileEffects(fileEffectSummary, members, new Set(allSubtreeIds)),
  };
}

function groupedRow(
  members: readonly IndexedSubagentRow[],
  fileEffectSummary: TurnFileEffectSummary | undefined,
): OrderedSubagentRow {
  const representative = groupRepresentative(members);
  const base: SubagentRow = {
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
    detail: groupedDetail(representative, members, fileEffectSummary),
  };
  const orderAt = groupOrderAt(members);
  if (members.some(({ row }) => !isFinishedSubagentRow(row))) {
    return { row: base, index: representative.index, orderAt };
  }
  const settledRepresentative = requireFinishedSubagentRow(representative.row);
  return {
    row: { ...base, status: settledRepresentative.status, completedAt: settledRepresentative.completedAt },
    index: representative.index,
    orderAt,
  };
}

function compareOrderedRows(left: OrderedSubagentRow, right: OrderedSubagentRow): number {
  return right.orderAt - left.orderAt
    || left.index - right.index
    || left.row.id.localeCompare(right.row.id);
}

function aggregateSubagentRows(
  rows: ReadonlyMap<string, IndexedSubagentRow>,
  fileEffectSummary: TurnFileEffectSummary | undefined,
): SubagentRoster {
  const active: OrderedLiveSubagentRow[] = [];
  const finished: OrderedFinishedSubagentRow[] = [];
  for (const members of logicalGroups(rows).values()) {
    const row = groupedRow(members, fileEffectSummary);
    if (isFinishedSubagentRow(row.row)) {
      finished.push({ ...row, row: row.row });
    } else {
      active.push({ ...row, row: row.row });
    }
  }
  active.sort(compareOrderedRows);
  finished.sort(compareOrderedRows);
  return {
    active: active.map(({ row }) => row),
    finished: finished.map(({ row }) => row),
  };
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
  const rows = liveSubagentRows(calls, now, fileEffectSummary);
  addPersistedRows(rows, calls, narrativeBatches, now);
  return aggregateSubagentRows(rows, fileEffectSummary);
}
