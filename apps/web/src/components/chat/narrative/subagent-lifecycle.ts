import type { ToolCall, ToolCallRecord } from "@/transport/types";

/** Internal tool name used to persist Codex subagent interaction markers. */
export const SUBAGENT_LIFECYCLE_TOOL_NAME = "__McodeSubagentLifecycle";

/** Lifecycle states rendered in the main chat timeline. */
export type SubagentLifecycle = "started" | "updated" | "finished";

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
