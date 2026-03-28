import { z } from "zod";

/** Status of a persisted tool call record. */
export const ToolCallStatusSchema = z.enum(["running", "completed", "failed"]);

/** Status of a persisted tool call record. */
export type ToolCallStatus = z.infer<typeof ToolCallStatusSchema>;

/** Persisted tool call record linked to an assistant message. */
export const ToolCallRecordSchema = z.object({
  id: z.string(),
  message_id: z.string(),
  parent_tool_call_id: z.string().nullable(),
  tool_name: z.string(),
  input_summary: z.string(),
  output_summary: z.string(),
  status: ToolCallStatusSchema,
  started_at: z.string(),
  completed_at: z.string().nullable(),
  sort_order: z.number(),
});

/** Persisted tool call record linked to an assistant message. */
export type ToolCallRecord = z.infer<typeof ToolCallRecordSchema>;
