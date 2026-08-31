import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";

/** Persisted thought segment (a contiguous stretch of assistant text deltas
 * captured between tool calls) linked to an assistant message. */
export const ThoughtSegmentRecordSchema = lazySchema(() => z.object({
  id: z.string(),
  message_id: z.string(),
  text: z.string(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  sort_order: z.number(),
  /**
   * Non-zero when this segment is the assistant's final user-facing response.
   * The client suppresses rendering these as ThoughtBlock rows to avoid
   * duplicating text already visible in the assistant message body.
   */
  is_final_response: z.number().optional(),
}));

/** Persisted thought segment linked to an assistant message. */
export type ThoughtSegmentRecord = z.infer<ReturnType<typeof ThoughtSegmentRecordSchema>>;
