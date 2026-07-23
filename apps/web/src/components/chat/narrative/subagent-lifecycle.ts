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
