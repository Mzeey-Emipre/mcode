import type { ToolCallRecord, ToolCall } from "@/transport/types";

/** Convert a persisted ToolCallRecord to the ToolCall shape used by renderers. */
export function recordToToolCall(record: ToolCallRecord): ToolCall {
  return {
    id: record.id,
    toolName: record.tool_name,
    toolInput: { summary: record.input_summary },
    output: record.output_summary || null,
    isError: record.status === "failed",
    isComplete: true,
  };
}
