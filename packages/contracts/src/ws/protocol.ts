import { z } from "zod";

/** Client-to-server RPC request envelope. */
export const WebSocketRequestSchema = z.object({
  id: z.string(),
  method: z.string(),
  params: z.record(z.unknown()),
});
/** Client-to-server RPC request. */
export type WebSocketRequest = z.infer<typeof WebSocketRequestSchema>;

/** Server-to-client RPC response envelope. */
export const WebSocketResponseSchema = z.object({
  id: z.string(),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
});
/** Server-to-client RPC response. */
export type WebSocketResponse = z.infer<typeof WebSocketResponseSchema>;

/** Server-to-client push message (no request ID). */
export const WsPushSchema = z.object({
  type: z.literal("push"),
  channel: z.string(),
  data: z.unknown(),
});
/** Server-to-client push message (no request ID). */
export type WsPush = z.infer<typeof WsPushSchema>;
