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

/** Maximum messages accepted in one older-conversation page. */
export const CONVERSATION_OLDER_PAGE_MAX_MESSAGES = CONVERSATION_HISTORY_PAGE_MAX_MESSAGES;

/** Minimum response-byte budget accepted for one older-conversation page. */
export const CONVERSATION_OLDER_PAGE_MIN_BYTES = CONVERSATION_HISTORY_PAGE_MIN_BYTES;

/** Maximum encoded bytes accepted for one older-conversation page response. */
export const CONVERSATION_OLDER_PAGE_MAX_BYTES = CONVERSATION_HISTORY_PAGE_MAX_BYTES;

/** Maximum encoded bytes accepted for one older-conversation page request. */
export const CONVERSATION_OLDER_PAGE_MAX_REQUEST_BYTES = CONVERSATION_HISTORY_PAGE_MAX_REQUEST_BYTES;

/** Versioned stable-sequence cursor for older conversation history. */
export const ConversationOlderPageCursorSchema = lazySchema(() =>
  z.object({
    version: z.literal(1),
    beforeSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }).strict(),
);

/** Identity that binds an older-page response to one renderer request. */
export const ConversationOlderPageIdentitySchema = lazySchema(() =>
  z.object({
    threadId: z.string().trim().min(1).max(256),
    cursor: ConversationOlderPageCursorSchema(),
    direction: z.literal("older"),
    generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    conversationRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }).strict(),
);

/** Bounded request for one page before a stable sequence cursor. */
export const ConversationOlderPageRequestSchema = lazySchema(() =>
  ConversationOlderPageIdentitySchema().extend({
    limit: z.number().int().min(1).max(CONVERSATION_HISTORY_PAGE_MAX_MESSAGES),
    maxBytes: z.number().int()
      .min(CONVERSATION_HISTORY_PAGE_MIN_BYTES)
      .max(CONVERSATION_HISTORY_PAGE_MAX_BYTES),
  }).strict().superRefine((request, context) => {
    if (conversationHistoryPageBytes(request) > CONVERSATION_HISTORY_PAGE_MAX_REQUEST_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Older conversation page request exceeds ${CONVERSATION_HISTORY_PAGE_MAX_REQUEST_BYTES} bytes`,
      });
    }
  }),
);

/** Bounded older-conversation page returned by `conversation.olderPage`. */
export const ConversationOlderPageSchema = lazySchema(() =>
  z.object({
    identity: ConversationOlderPageIdentitySchema(),
    messages: z.array(MessageSchema()).max(CONVERSATION_HISTORY_PAGE_MAX_MESSAGES),
    hasMore: z.boolean(),
    nextCursor: ConversationOlderPageCursorSchema().nullable(),
    answeredPlanMessageIds: z.array(z.string()).max(CONVERSATION_HISTORY_PAGE_MAX_MESSAGES).optional(),
    narrativeByMessage: z.record(ConversationNarrativeBatchSchema()),
  }).strict().superRefine(validateConversationOlderPage),
);

type ConversationOlderPageValidationInput = {
  readonly identity: { readonly threadId: string; readonly cursor: { readonly beforeSequence: number } };
  readonly messages: readonly { readonly id: string; readonly thread_id: string; readonly sequence: number }[];
  readonly hasMore: boolean;
  readonly nextCursor: { readonly beforeSequence: number } | null;
};

function validateConversationOlderPage(
  page: ConversationOlderPageValidationInput,
  context: z.RefinementCtx,
): void {
  validateOlderPageContinuation(page, context);
  validateOlderPageMessages(page, context);
  validateOlderPageCursor(page, context);
  validateOlderPageSize(page, context);
}

function validateOlderPageContinuation(page: ConversationOlderPageValidationInput, context: z.RefinementCtx): void {
  if (page.hasMore === (page.nextCursor !== null)) return;
  context.addIssue({
    code: z.ZodIssueCode.custom,
    message: "Older conversation page continuation does not match hasMore",
  });
}

function validateOlderPageMessages(page: ConversationOlderPageValidationInput, context: z.RefinementCtx): void {
  const messageIds = new Set<string>();
  let previousSequence = 0;
  for (const message of page.messages) {
    if (hasInvalidOlderPageMessage(message, page.identity, previousSequence, messageIds)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Older conversation page messages must be unique and strictly sequence ordered",
      });
      return;
    }
    messageIds.add(message.id);
    previousSequence = message.sequence;
  }
}

function hasInvalidOlderPageMessage(
  message: ConversationOlderPageValidationInput["messages"][number],
  identity: ConversationOlderPageValidationInput["identity"],
  previousSequence: number,
  messageIds: ReadonlySet<string>,
): boolean {
  return message.thread_id !== identity.threadId
    || message.sequence >= identity.cursor.beforeSequence
    || message.sequence <= previousSequence
    || messageIds.has(message.id);
}

function validateOlderPageCursor(page: ConversationOlderPageValidationInput, context: z.RefinementCtx): void {
  if (!page.nextCursor || page.nextCursor.beforeSequence === page.messages[0]?.sequence) return;
  context.addIssue({
    code: z.ZodIssueCode.custom,
    message: "Older conversation page cursor must continue before its first message",
  });
}

function validateOlderPageSize(page: ConversationOlderPageValidationInput, context: z.RefinementCtx): void {
  if (conversationHistoryPageBytes(page) <= CONVERSATION_HISTORY_PAGE_MAX_BYTES) return;
  context.addIssue({
    code: z.ZodIssueCode.custom,
    message: `Older conversation page exceeds ${CONVERSATION_HISTORY_PAGE_MAX_BYTES} bytes`,
  });
}

/** Versioned cursor for older conversation history. */
export type ConversationOlderPageCursor = z.infer<ReturnType<typeof ConversationOlderPageCursorSchema>>;

/** Complete identity for one older-page request. */
export type ConversationOlderPageIdentity = z.infer<ReturnType<typeof ConversationOlderPageIdentitySchema>>;

/** Bounded older-conversation page request. */
export type ConversationOlderPageRequest = z.infer<ReturnType<typeof ConversationOlderPageRequestSchema>>;

/** Bounded older-conversation page response. */
export type ConversationOlderPage = z.infer<ReturnType<typeof ConversationOlderPageSchema>>;
