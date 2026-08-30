import {
  mergeSubagentPresentation,
  resolveProviderAgentKey,
  resolveSubagentExactIdentity,
} from "@mcode/contracts";
import type { ToolCall, ToolCallRecord } from "@/transport/types";

/** Internal tool name used to persist Codex subagent interaction markers. */
export const SUBAGENT_LIFECYCLE_TOOL_NAME = "__McodeSubagentLifecycle";

/** Lifecycle states rendered in the main chat timeline. */
export type SubagentLifecycle = "started" | "updated" | "finished";

function mergeToolCallState(current: ToolCall, incoming: ToolCall): ToolCall {
  const terminal = terminalToolCall(current, incoming);
  return {
    ...current,
    toolInput: { ...current.toolInput, ...incoming.toolInput },
    ...terminalToolCallState(current, terminal),
    parentToolCallId: current.parentToolCallId ?? incoming.parentToolCallId,
    startedAt: current.startedAt ?? incoming.startedAt,
    lastActivityAt: Math.max(current.lastActivityAt ?? 0, incoming.lastActivityAt ?? 0) || undefined,
    subagentPresentation: mergedSubagentPresentation(current, incoming),
  };
}

function terminalToolCall(current: ToolCall, incoming: ToolCall): ToolCall {
  return current.isComplete ? current : incoming.isComplete ? incoming : current;
}

function terminalToolCallState(current: ToolCall, terminal: ToolCall): Partial<ToolCall> {
  return {
    output: terminal.output ?? current.output,
    isError: terminal.isError,
    isComplete: terminal.isComplete,
    ...(terminal.isCancelled ? { isCancelled: true } : {}),
    ...(terminal.outputTruncated ? { outputTruncated: true } : {}),
    ...(terminal.outputTotalBytes === undefined ? {} : { outputTotalBytes: terminal.outputTotalBytes }),
    ...(terminal.outputArtifactPath ? { outputArtifactPath: terminal.outputArtifactPath } : {}),
    ...(terminal.exitCode === undefined ? {} : { exitCode: terminal.exitCode }),
    ...(terminal.durationMs === undefined ? {} : { durationMs: terminal.durationMs }),
  };
}

function mergedSubagentPresentation(current: ToolCall, incoming: ToolCall) {
  return current.subagentPresentation && incoming.subagentPresentation
    ? mergeSubagentPresentation(current.subagentPresentation, incoming.subagentPresentation, current.id)
    : current.subagentPresentation ?? incoming.subagentPresentation;
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

function resolveAlias(id: string, aliases: ReadonlyMap<string, string>): string {
  let current = id;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const next = aliases.get(current);
    if (!next) break;
    current = next;
  }
  return current;
}

function rebaseLiveMarker(call: ToolCall, aliases: ReadonlyMap<string, string>): ToolCall {
  if (call.toolName !== SUBAGENT_LIFECYCLE_TOOL_NAME) return call;
  const source = call.toolInput.sourceAgentToolCallId;
  if (typeof source !== "string" || source.length === 0) return call;
  const rebased = resolveAlias(source, aliases);
  return rebased === source
    ? call
    : { ...call, toolInput: { ...call.toolInput, sourceAgentToolCallId: rebased } };
}

function rebasePersistedMarker(record: ToolCallRecord, aliases: ReadonlyMap<string, string>): ToolCallRecord {
  if (record.tool_name !== SUBAGENT_LIFECYCLE_TOOL_NAME) return record;
  const input = parseSubagentLifecycleInput(record.input_summary);
  const source = input?.sourceAgentToolCallId;
  if (typeof source !== "string" || source.length === 0) return record;
  const rebased = resolveAlias(source, aliases);
  return rebased === source
    ? record
    : { ...record, input_summary: JSON.stringify({ ...input, sourceAgentToolCallId: rebased }) };
}

/**
 * Collapse repeated provider Agent records into one logical child while
 * retaining the first record's terminal outcome and rebasing descendants.
 */
export function collapseSubagentCalls(calls: readonly ToolCall[]): ToolCall[] {
  const state = createLiveSubagentCollapseState();
  for (const call of calls) collapseSubagentCall(state, call);
  return state.orderedIds.map((id) => rebaseLiveCall(state.canonicalCalls.get(id)!, state.aliases));
}

interface LiveSubagentCollapseState {
  canonicalByProviderKey: Map<string, string>;
  canonicalByExactIdentity: Map<string, string>;
  exactIdentityByCanonical: Map<string, string>;
  aliases: Map<string, string>;
  canonicalCalls: Map<string, ToolCall>;
  orderedIds: string[];
}

function createLiveSubagentCollapseState(): LiveSubagentCollapseState {
  return { canonicalByProviderKey: new Map(), canonicalByExactIdentity: new Map(), exactIdentityByCanonical: new Map(), aliases: new Map(), canonicalCalls: new Map(), orderedIds: [] };
}

function liveCanonicalId(state: LiveSubagentCollapseState, providerKey: string | undefined, exactIdentity: string | undefined): string | undefined {
  const exactMatch = exactIdentity ? state.canonicalByExactIdentity.get(exactIdentity) : undefined;
  if (exactMatch || !providerKey) return exactMatch;
  const providerMatch = state.canonicalByProviderKey.get(providerKey);
  return providerMatch && (!exactIdentity || !state.exactIdentityByCanonical.has(providerMatch)) ? providerMatch : undefined;
}

function rememberLiveCanonical(state: LiveSubagentCollapseState, call: ToolCall, providerKey: string | undefined, exactIdentity: string | undefined): void {
  if (providerKey) state.canonicalByProviderKey.set(providerKey, call.id);
  if (exactIdentity) {
    state.canonicalByExactIdentity.set(exactIdentity, call.id);
    state.exactIdentityByCanonical.set(call.id, exactIdentity);
  }
  state.canonicalCalls.set(call.id, call);
  state.orderedIds.push(call.id);
}

function mergeLiveCanonical(state: LiveSubagentCollapseState, call: ToolCall, canonicalId: string, exactIdentity: string | undefined): void {
  state.aliases.set(call.id, canonicalId);
  if (exactIdentity) {
    state.canonicalByExactIdentity.set(exactIdentity, canonicalId);
    state.exactIdentityByCanonical.set(canonicalId, exactIdentity);
  }
  state.canonicalCalls.set(canonicalId, mergeToolCallState(state.canonicalCalls.get(canonicalId)!, call));
}

function collapseSubagentCall(state: LiveSubagentCollapseState, call: ToolCall): void {
  if (call.toolName !== "Agent") {
    state.canonicalCalls.set(call.id, call);
    state.orderedIds.push(call.id);
    return;
  }
  const providerKey = call.subagentPresentation?.providerAgentKey ?? resolveProviderAgentKey(call.toolInput);
  const exactIdentity = exactIdentityForCall(call, providerKey);
  const canonicalId = liveCanonicalId(state, providerKey, exactIdentity);
  if (canonicalId) mergeLiveCanonical(state, call, canonicalId, exactIdentity);
  else rememberLiveCanonical(state, call, providerKey, exactIdentity);
}

function rebaseLiveCall(call: ToolCall, aliases: ReadonlyMap<string, string>): ToolCall {
  const rebasedMarker = rebaseLiveMarker(call, aliases);
  const parentId = rebasedMarker.parentToolCallId ? resolveAlias(rebasedMarker.parentToolCallId, aliases) : undefined;
  return parentId === rebasedMarker.parentToolCallId ? rebasedMarker : { ...rebasedMarker, parentToolCallId: parentId };
}

interface PersistedSubagentIdentity {
  providerKey: string | undefined;
  exactIdentity: string | undefined;
}

interface PersistedSubagentCollapseState {
  canonicalByProviderKey: Map<string, string>;
  canonicalByExactIdentity: Map<string, string>;
  exactIdentityByCanonical: Map<string, string>;
  aliases: Map<string, string>;
  canonicalRecords: Map<string, ToolCallRecord>;
  orderedIds: string[];
}

function persistedSubagentIdentity(record: ToolCallRecord): PersistedSubagentIdentity {
  return {
    providerKey: record.provider_agent_key ?? undefined,
    exactIdentity: record.subagent_identity_key ?? undefined,
  };
}

function createPersistedSubagentCollapseState(): PersistedSubagentCollapseState {
  return {
    canonicalByProviderKey: new Map<string, string>(),
    canonicalByExactIdentity: new Map<string, string>(),
    exactIdentityByCanonical: new Map<string, string>(),
    aliases: new Map<string, string>(),
    canonicalRecords: new Map<string, ToolCallRecord>(),
    orderedIds: [],
  };
}

function storePersistedRecord(
  state: PersistedSubagentCollapseState,
  record: ToolCallRecord,
): void {
  state.canonicalRecords.set(record.id, record);
  state.orderedIds.push(record.id);
}

function rememberPersistedCanonicalIdentity(
  state: PersistedSubagentCollapseState,
  record: ToolCallRecord,
  identity: PersistedSubagentIdentity,
): void {
  if (identity.providerKey) state.canonicalByProviderKey.set(identity.providerKey, record.id);
  if (identity.exactIdentity) {
    state.canonicalByExactIdentity.set(identity.exactIdentity, record.id);
    state.exactIdentityByCanonical.set(record.id, identity.exactIdentity);
  }
}

function persistedCanonicalId(
  state: PersistedSubagentCollapseState,
  identity: PersistedSubagentIdentity,
): string | undefined {
  if (identity.exactIdentity) {
    const exactMatch = state.canonicalByExactIdentity.get(identity.exactIdentity);
    if (exactMatch) return exactMatch;
  }
  if (!identity.providerKey) return undefined;
  const providerCandidate = state.canonicalByProviderKey.get(identity.providerKey);
  if (!providerCandidate) return undefined;
  if (identity.exactIdentity && state.exactIdentityByCanonical.has(providerCandidate)) {
    return undefined;
  }
  return providerCandidate;
}

function terminalPersistedRecord(
  current: ToolCallRecord,
  incoming: ToolCallRecord,
): ToolCallRecord {
  if (current.status !== "running") return current;
  return incoming.status !== "running" ? incoming : current;
}

function mergedPersistedIdentityMetadata(
  current: ToolCallRecord,
  incoming: ToolCallRecord,
): Pick<
  ToolCallRecord,
  "display_name" | "provider_agent_key" | "subagent_identity_key" | "subagent_provider_name" | "subagent_prompt"
> {
  return {
    display_name: current.display_name ?? incoming.display_name,
    provider_agent_key: current.provider_agent_key ?? incoming.provider_agent_key,
    subagent_identity_key: current.subagent_identity_key ?? incoming.subagent_identity_key,
    subagent_provider_name: current.subagent_provider_name ?? incoming.subagent_provider_name,
    subagent_prompt: current.subagent_prompt ?? incoming.subagent_prompt,
  };
}

function mergedPersistedExecutionMetadata(
  current: ToolCallRecord,
  incoming: ToolCallRecord,
): Pick<
  ToolCallRecord,
  "subagent_type" | "subagent_agent_id" | "subagent_duration_ms" | "model" | "reasoning_effort"
> {
  return {
    subagent_type: current.subagent_type ?? incoming.subagent_type,
    subagent_agent_id: current.subagent_agent_id ?? incoming.subagent_agent_id,
    subagent_duration_ms: current.subagent_duration_ms ?? incoming.subagent_duration_ms,
    model: current.model ?? incoming.model,
    reasoning_effort: current.reasoning_effort ?? incoming.reasoning_effort,
  };
}

function mergePersistedRecordState(
  current: ToolCallRecord,
  incoming: ToolCallRecord,
): ToolCallRecord {
  const terminal = terminalPersistedRecord(current, incoming);
  return {
    ...current,
    ...mergedPersistedIdentityMetadata(current, incoming),
    ...mergedPersistedExecutionMetadata(current, incoming),
    input_summary: current.input_summary || incoming.input_summary,
    output_summary: terminal.output_summary,
    output_truncated: terminal.output_truncated,
    output_total_bytes: terminal.output_total_bytes,
    output_artifact_path: terminal.output_artifact_path,
    exit_code: terminal.exit_code,
    status: terminal.status,
    completed_at: terminal.completed_at,
    parent_tool_call_id: current.parent_tool_call_id ?? incoming.parent_tool_call_id,
  };
}

function mergePersistedSubagentRecord(
  state: PersistedSubagentCollapseState,
  record: ToolCallRecord,
  identity: PersistedSubagentIdentity,
  canonicalId: string,
): void {
  state.aliases.set(record.id, canonicalId);
  if (identity.exactIdentity) {
    state.canonicalByExactIdentity.set(identity.exactIdentity, canonicalId);
    state.exactIdentityByCanonical.set(canonicalId, identity.exactIdentity);
  }
  const current = state.canonicalRecords.get(canonicalId)!;
  state.canonicalRecords.set(canonicalId, mergePersistedRecordState(current, record));
}

function rebasePersistedRecordParent(
  record: ToolCallRecord,
  aliases: ReadonlyMap<string, string>,
): ToolCallRecord {
  const parentId = record.parent_tool_call_id;
  if (!parentId) return record;
  const canonicalParentId = resolveAlias(parentId, aliases);
  if (canonicalParentId === parentId) return record;
  return { ...record, parent_tool_call_id: canonicalParentId };
}

function rebasePersistedRecord(
  record: ToolCallRecord,
  aliases: ReadonlyMap<string, string>,
): ToolCallRecord {
  return rebasePersistedRecordParent(rebasePersistedMarker(record, aliases), aliases);
}

/** Collapse repeated persisted Agent records using the same provider identity rule as live calls. */
export function collapseSubagentRecords(records: readonly ToolCallRecord[]): ToolCallRecord[] {
  const state = createPersistedSubagentCollapseState();
  for (const record of records) {
    if (record.tool_name !== "Agent") {
      storePersistedRecord(state, record);
      continue;
    }
    const identity = persistedSubagentIdentity(record);
    const canonicalId = persistedCanonicalId(state, identity);
    if (canonicalId) {
      mergePersistedSubagentRecord(state, record, identity, canonicalId);
      continue;
    }
    rememberPersistedCanonicalIdentity(state, record, identity);
    storePersistedRecord(state, record);
  }
  return state.orderedIds.map((id) => rebasePersistedRecord(
    state.canonicalRecords.get(id)!,
    state.aliases,
  ));
}

/** Returns whether a live call is an internal subagent lifecycle marker. */
export function isSubagentLifecycleCall(call: Pick<ToolCall, "toolName">): boolean {
  return call.toolName === SUBAGENT_LIFECYCLE_TOOL_NAME;
}

/** Returns whether a persisted record is an internal subagent lifecycle marker. */
export function isSubagentLifecycleRecord(record: Pick<ToolCallRecord, "tool_name">): boolean {
  return record.tool_name === SUBAGENT_LIFECYCLE_TOOL_NAME;
}

/** Parses persisted metadata for an internal lifecycle marker. */
export function parseSubagentLifecycleInput(inputSummary: string): Record<string, unknown> {
  if (!inputSummary) return {};
  try {
    const parsed: unknown = JSON.parse(inputSummary);
    return parsed != null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/** Returns authoritative lifecycle participants in source-then-target order. */
export function subagentLifecycleParticipants(
  target: ToolCall,
  marker: ToolCall | undefined,
  allToolCalls: readonly ToolCall[],
): ToolCall[] {
  const explicitSourceId = marker?.toolInput.sourceAgentToolCallId;
  const sourceId = typeof explicitSourceId === "string" && explicitSourceId.length > 0
    ? explicitSourceId
    : target.parentToolCallId;
  const source = sourceId
    ? allToolCalls.find((call) => call.id === sourceId && call.toolName === "Agent")
    : undefined;
  return source && source.id !== target.id ? [source, target] : [target];
}
