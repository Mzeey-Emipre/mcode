import { z } from "zod";
import { MessageRoleSchema } from "./enums.js";
import { lazySchema } from "../utils/lazySchema.js";

/** Maximum number of messages returned by the first-paint conversation tail. */
export const CONVERSATION_TAIL_MAX_MESSAGES = 2;

/** Maximum characters accepted for a thread identifier in conversation reads. */
export const CONVERSATION_TAIL_THREAD_ID_MAX_LENGTH = 128;

/** Minimal persisted message shape used for first-paint conversation content. */
export const ConversationTailMessageSchema = lazySchema(() =>
  z.object({
    id: z.string().min(1),
    thread_id: z.string().min(1),
    role: MessageRoleSchema,
    content: z.string(),
    timestamp: z.string(),
    sequence: z.number().int().nonnegative(),
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
export const ConversationTailSchema = lazySchema(() =>
  z.object({
    messages: z.array(ConversationTailMessageSchema()).max(CONVERSATION_TAIL_MAX_MESSAGES),
    hasMore: z.boolean(),
    nextBefore: z.number().int().nonnegative().optional(),
  }),
);

/** Result returned by `conversation.tail`. */
export const ConversationTailResultSchema = ConversationTailSchema;

/** Parameters accepted by `conversation.tail`. */
export type ConversationTailParams = z.infer<ReturnType<typeof ConversationTailParamsSchema>>;

/** Minimal message returned by `conversation.tail`. */
export type ConversationTailMessage = z.infer<ReturnType<typeof ConversationTailMessageSchema>>;

/** Result returned by `conversation.tail`. */
export type ConversationTail = z.infer<ReturnType<typeof ConversationTailSchema>>;

/** Result returned by `conversation.tail`. */
export type ConversationTailResult = ConversationTail;
