import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";
import { ConversationNarrativeBatchSchema } from "./conversation-page.js";
import {
  CONVERSATION_HISTORY_PAGE_MAX_BYTES,
  CONVERSATION_HISTORY_PAGE_MAX_MESSAGES,
  CONVERSATION_HISTORY_PAGE_MAX_REQUEST_BYTES,
  CONVERSATION_HISTORY_PAGE_MIN_BYTES,
  conversationHistoryPageBytes,
} from "./conversation-history-page.js";
import { MessageSchema } from "./message.js";

/** Versioned stable-sequence cursor for newer conversation history. */
export const ConversationNewerPageCursorSchema = lazySchema(() =>
  z.object({
    version: z.literal(1),
    afterSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }).strict(),
);

/** Identity that binds a newer-page response to one renderer request. */
export const ConversationNewerPageIdentitySchema = lazySchema(() =>
  z.object({
    threadId: z.string().trim().min(1).max(256),
    cursor: ConversationNewerPageCursorSchema(),
    direction: z.literal("newer"),
    generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    conversationRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }).strict(),
);

/** Bounded request for one page after a stable sequence cursor. */
export const ConversationNewerPageRequestSchema = lazySchema(() =>
  ConversationNewerPageIdentitySchema().extend({
    limit: z.number().int().min(1).max(CONVERSATION_HISTORY_PAGE_MAX_MESSAGES),
    maxBytes: z.number().int()
      .min(CONVERSATION_HISTORY_PAGE_MIN_BYTES)
      .max(CONVERSATION_HISTORY_PAGE_MAX_BYTES),
  }).strict().superRefine((request, context) => {
    if (conversationHistoryPageBytes(request) > CONVERSATION_HISTORY_PAGE_MAX_REQUEST_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Newer conversation page request exceeds ${CONVERSATION_HISTORY_PAGE_MAX_REQUEST_BYTES} bytes`,
      });
    }
  }),
);

/** Bounded newer-conversation page returned by `conversation.newerPage`. */
export const ConversationNewerPageSchema = lazySchema(() =>
  z.object({
    identity: ConversationNewerPageIdentitySchema(),
    messages: z.array(MessageSchema()).max(CONVERSATION_HISTORY_PAGE_MAX_MESSAGES),
    hasMore: z.boolean(),
    nextCursor: ConversationNewerPageCursorSchema().nullable(),
    answeredPlanMessageIds: z.array(z.string()).max(CONVERSATION_HISTORY_PAGE_MAX_MESSAGES).optional(),
    narrativeByMessage: z.record(ConversationNarrativeBatchSchema()),
  }).strict().superRefine((page, context) => {
    if (page.hasMore !== (page.nextCursor !== null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Newer conversation page continuation does not match hasMore",
      });
    }
    const messageIds = new Set<string>();
    let previousSequence = page.identity.cursor.afterSequence;
    for (const message of page.messages) {
      if (
        message.thread_id !== page.identity.threadId
        || message.sequence <= previousSequence
        || messageIds.has(message.id)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Newer conversation page messages must be unique and strictly sequence ordered",
        });
        break;
      }
      messageIds.add(message.id);
      previousSequence = message.sequence;
    }
    if (page.nextCursor && page.nextCursor.afterSequence !== page.messages.at(-1)?.sequence) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Newer conversation page cursor must continue after its last message",
      });
    }
    if (conversationHistoryPageBytes(page) > CONVERSATION_HISTORY_PAGE_MAX_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Newer conversation page exceeds ${CONVERSATION_HISTORY_PAGE_MAX_BYTES} bytes`,
      });
    }
  }),
);

/** Versioned cursor for newer conversation history. */
export type ConversationNewerPageCursor = z.infer<ReturnType<typeof ConversationNewerPageCursorSchema>>;

/** Complete identity for one newer-page request. */
export type ConversationNewerPageIdentity = z.infer<ReturnType<typeof ConversationNewerPageIdentitySchema>>;

/** Bounded newer-conversation page request. */
export type ConversationNewerPageRequest = z.infer<ReturnType<typeof ConversationNewerPageRequestSchema>>;

/** Bounded newer-conversation page response. */
export type ConversationNewerPage = z.infer<ReturnType<typeof ConversationNewerPageSchema>>;
