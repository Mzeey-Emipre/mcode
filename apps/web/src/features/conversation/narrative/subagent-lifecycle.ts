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
  const terminal = current.isComplete ? current : incoming.isComplete ? incoming : current;
  return {
    ...current,
    toolInput: { ...current.toolInput, ...incoming.toolInput },
    output: terminal.output ?? current.output,
    isError: terminal.isError,
    isComplete: terminal.isComplete,
    ...(terminal.isCancelled ? { isCancelled: true } : {}),
    ...(terminal.outputTruncated ? { outputTruncated: true } : {}),
    ...(terminal.outputTotalBytes !== undefined ? { outputTotalBytes: terminal.outputTotalBytes } : {}),
    ...(terminal.outputArtifactPath ? { outputArtifactPath: terminal.outputArtifactPath } : {}),
    ...(terminal.exitCode !== undefined ? { exitCode: terminal.exitCode } : {}),
    ...(terminal.durationMs !== undefined ? { durationMs: terminal.durationMs } : {}),
    parentToolCallId: current.parentToolCallId ?? incoming.parentToolCallId,
    startedAt: current.startedAt ?? incoming.startedAt,
    lastActivityAt: Math.max(current.lastActivityAt ?? 0, incoming.lastActivityAt ?? 0) || undefined,
    subagentPresentation: current.subagentPresentation && incoming.subagentPresentation
      ? mergeSubagentPresentation(current.subagentPresentation, incoming.subagentPresentation, current.id)
      : current.subagentPresentation ?? incoming.subagentPresentation,
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
  const canonicalByProviderKey = new Map<string, string>();
  const canonicalByExactIdentity = new Map<string, string>();
  const exactIdentityByCanonical = new Map<string, string>();
  const aliases = new Map<string, string>();
  const canonicalCalls = new Map<string, ToolCall>();
  const orderedIds: string[] = [];

  for (const call of calls) {
    if (call.toolName !== "Agent") {
      canonicalCalls.set(call.id, call);
      orderedIds.push(call.id);
      continue;
    }
    const providerKey = call.subagentPresentation?.providerAgentKey
      ?? resolveProviderAgentKey(call.toolInput);
    const exactIdentity = exactIdentityForCall(call, providerKey);
    let canonicalId = exactIdentity
      ? canonicalByExactIdentity.get(exactIdentity)
      : undefined;
    if (!canonicalId && providerKey) {
      const providerCandidate = canonicalByProviderKey.get(providerKey);
      if (providerCandidate && (!exactIdentity || !exactIdentityByCanonical.has(providerCandidate))) {
        canonicalId = providerCandidate;
      }
    }
    if (!canonicalId) {
      if (providerKey) canonicalByProviderKey.set(providerKey, call.id);
      if (exactIdentity) {
        canonicalByExactIdentity.set(exactIdentity, call.id);
        exactIdentityByCanonical.set(call.id, exactIdentity);
      }
      canonicalCalls.set(call.id, call);
      orderedIds.push(call.id);
      continue;
    }
    aliases.set(call.id, canonicalId);
    if (exactIdentity) {
      canonicalByExactIdentity.set(exactIdentity, canonicalId);
      exactIdentityByCanonical.set(canonicalId, exactIdentity);
    }
    canonicalCalls.set(canonicalId, mergeToolCallState(canonicalCalls.get(canonicalId)!, call));
  }

  return orderedIds.map((id) => {
    const call = rebaseLiveMarker(canonicalCalls.get(id)!, aliases);
    const parentId = call.parentToolCallId ? resolveAlias(call.parentToolCallId, aliases) : undefined;
    return parentId === call.parentToolCallId ? call : { ...call, parentToolCallId: parentId };
  });
}

/** Collapse repeated persisted Agent records using the same provider identity rule as live calls. */
export function collapseSubagentRecords(records: readonly ToolCallRecord[]): ToolCallRecord[] {
  const canonicalByProviderKey = new Map<string, string>();
  const canonicalByExactIdentity = new Map<string, string>();
  const exactIdentityByCanonical = new Map<string, string>();
  const aliases = new Map<string, string>();
  const canonicalRecords = new Map<string, ToolCallRecord>();
  const orderedIds: string[] = [];
  for (const record of records) {
    if (record.tool_name !== "Agent") {
      canonicalRecords.set(record.id, record);
      orderedIds.push(record.id);
      continue;
    }
    const providerKey = record.provider_agent_key ?? undefined;
    const exactIdentity = record.subagent_identity_key ?? undefined;
    let canonicalId = exactIdentity
      ? canonicalByExactIdentity.get(exactIdentity)
      : undefined;
    if (!canonicalId && providerKey) {
      const providerCandidate = canonicalByProviderKey.get(providerKey);
      if (providerCandidate && (!exactIdentity || !exactIdentityByCanonical.has(providerCandidate))) {
        canonicalId = providerCandidate;
      }
    }
    if (!canonicalId) {
      if (providerKey) canonicalByProviderKey.set(providerKey, record.id);
      if (exactIdentity) {
        canonicalByExactIdentity.set(exactIdentity, record.id);
        exactIdentityByCanonical.set(record.id, exactIdentity);
      }
      canonicalRecords.set(record.id, record);
      orderedIds.push(record.id);
      continue;
    }
    aliases.set(record.id, canonicalId);
    if (exactIdentity) {
      canonicalByExactIdentity.set(exactIdentity, canonicalId);
      exactIdentityByCanonical.set(canonicalId, exactIdentity);
    }
    const current = canonicalRecords.get(canonicalId)!;
    const terminal = current.status !== "running" ? current : record.status !== "running" ? record : current;
    canonicalRecords.set(canonicalId, {
      ...current,
      display_name: current.display_name ?? record.display_name,
      provider_agent_key: current.provider_agent_key ?? record.provider_agent_key,
      subagent_identity_key: current.subagent_identity_key ?? record.subagent_identity_key,
      subagent_provider_name: current.subagent_provider_name ?? record.subagent_provider_name,
      subagent_prompt: current.subagent_prompt ?? record.subagent_prompt,
      subagent_type: current.subagent_type ?? record.subagent_type,
      subagent_agent_id: current.subagent_agent_id ?? record.subagent_agent_id,
      subagent_duration_ms: current.subagent_duration_ms ?? record.subagent_duration_ms,
      model: current.model ?? record.model,
      reasoning_effort: current.reasoning_effort ?? record.reasoning_effort,
      input_summary: current.input_summary || record.input_summary,
      output_summary: terminal.output_summary,
      output_truncated: terminal.output_truncated,
      output_total_bytes: terminal.output_total_bytes,
      output_artifact_path: terminal.output_artifact_path,
      exit_code: terminal.exit_code,
      status: terminal.status,
      completed_at: terminal.completed_at,
      parent_tool_call_id: current.parent_tool_call_id ?? record.parent_tool_call_id,
    });
  }
  return orderedIds.map((id) => {
    const record = rebasePersistedMarker(canonicalRecords.get(id)!, aliases);
    const parentId = record.parent_tool_call_id
      ? resolveAlias(record.parent_tool_call_id, aliases)
      : record.parent_tool_call_id;
    return parentId === record.parent_tool_call_id ? record : { ...record, parent_tool_call_id: parentId };
  });
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
