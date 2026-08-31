import { z } from "zod";
import { TerminalRetryClassSchema } from "../models/terminal.js";
import { lazySchema } from "../utils/lazySchema.js";

/** Client-to-server RPC request envelope. */
export const WebSocketRequestSchema = lazySchema(() => z.object({
  id: z.string(),
  method: z.string(),
  params: z.record(z.unknown()),
}));
/** Client-to-server RPC request. */
export type WebSocketRequest = z.infer<ReturnType<typeof WebSocketRequestSchema>>;

/** Server-to-client RPC response envelope. */
export const WebSocketResponseSchema = lazySchema(() => z.object({
  id: z.string(),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      retry: TerminalRetryClassSchema().optional(),
      correlationId: z.string().min(1).max(64).optional(),
      /** Optional structured payload for typed errors (e.g. provider availability errors). */
      data: z.record(z.unknown()).optional(),
    })
    .optional(),
}));
/** Server-to-client RPC response. */
export type WebSocketResponse = z.infer<ReturnType<typeof WebSocketResponseSchema>>;

/** Server-to-client push message (no request ID). */
export const WsPushSchema = lazySchema(() => z.object({
  type: z.literal("push"),
  channel: z.string(),
  data: z.unknown(),
}));
/** Server-to-client push message (no request ID). */
export type WsPush = z.infer<ReturnType<typeof WsPushSchema>>;

/**
 * JSON header sent immediately before a binary WebSocket frame.
 * The server matches the next binary frame from this connection to this header.
 */
export const BinaryUploadHeaderSchema = lazySchema(() => z.object({
  type: z.literal("binary-upload"),
  /** RPC request ID for correlating the response. */
  id: z.string(),
  /** Target RPC method (e.g. "clipboard.saveFile"). */
  method: z.string(),
  /** Metadata for the upload (everything except the binary payload). */
  meta: z.record(z.unknown()),
}));

export type BinaryUploadHeader = z.infer<ReturnType<typeof BinaryUploadHeaderSchema>>;
