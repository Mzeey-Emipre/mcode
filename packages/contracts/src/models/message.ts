import { z } from "zod";
import { MessageRoleSchema } from "./enums.js";
import { StoredAttachmentSchema } from "./attachment.js";

/** Message schema matching the SQLite row shape. */
export const MessageSchema = z.object({
  id: z.string(),
  thread_id: z.string(),
  role: MessageRoleSchema,
  content: z.string(),
  tool_calls: z.unknown().nullable(),
  files_changed: z.unknown().nullable(),
  cost_usd: z.number().nullable(),
  tokens_used: z.number().nullable(),
  timestamp: z.string(),
  sequence: z.number(),
  attachments: z.array(StoredAttachmentSchema).nullable(),
  tool_call_count: z.number().optional(),
});
/** Message record from the database. */
export type Message = z.infer<typeof MessageSchema>;
