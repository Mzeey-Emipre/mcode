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
    ...(record.output_truncated === 1 ? { outputTruncated: true } : {}),
    ...(typeof record.output_total_bytes === "number" ? { outputTotalBytes: record.output_total_bytes } : {}),
    ...(record.output_artifact_path ? { outputArtifactPath: record.output_artifact_path } : {}),
  };
}
