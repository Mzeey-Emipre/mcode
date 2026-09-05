import { z } from "zod";
import { MessageSchema, SessionNoticesSchema, type Message } from "./message.js";
import { lazySchema } from "../utils/lazySchema.js";

/** Maximum number of messages returned by the first-paint conversation tail. */
export const CONVERSATION_TAIL_MAX_MESSAGES = 2;

/** Maximum characters accepted for a thread identifier in conversation reads. */
export const CONVERSATION_TAIL_THREAD_ID_MAX_LENGTH = 128;

/** Render-complete message returned by `conversation.tail`. */
export type ConversationTailMessage = Omit<
  Message,
  "tool_calls" | "files_changed" | "legacyProvenance"
>;

/** Result returned by `conversation.tail`. */
export interface ConversationTail {
  messages: ConversationTailMessage[];
  sessionNotices?: Message[];
  hasMore: boolean;
  nextBefore?: number;
}

/** Render-complete persisted message shape used for first-paint conversation content. */
export const ConversationTailMessageSchema = lazySchema<z.ZodType<ConversationTailMessage>>(() =>
  MessageSchema().omit({
    tool_calls: true,
    files_changed: true,
    legacyProvenance: true,
  }),
);

/** Parameters for loading a bounded conversation tail. */
export const ConversationTailParamsSchema = lazySchema(() =>
  z.object({
    threadId: z.string().trim().min(1).max(CONVERSATION_TAIL_THREAD_ID_MAX_LENGTH),
    limit: z.number().int().min(1).max(CONVERSATION_TAIL_MAX_MESSAGES),
  }),
);

/** Minimal conversation tail with cursor facts for a follow-up page request. */
export const ConversationTailSchema = lazySchema<z.ZodType<ConversationTail>>(() =>
  z.object({
    messages: z.array(ConversationTailMessageSchema()).max(CONVERSATION_TAIL_MAX_MESSAGES),
    sessionNotices: SessionNoticesSchema().optional(),
    hasMore: z.boolean(),
    nextBefore: z.number().int().nonnegative().optional(),
  }),
);

/** Result returned by `conversation.tail`. */
export const ConversationTailResultSchema = ConversationTailSchema;

/** Parameters accepted by `conversation.tail`. */
export type ConversationTailParams = z.infer<ReturnType<typeof ConversationTailParamsSchema>>;

/** Result returned by `conversation.tail`. */
export type ConversationTailResult = ConversationTail;
