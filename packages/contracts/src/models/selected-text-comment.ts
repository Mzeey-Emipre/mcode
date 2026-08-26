import { z } from "zod";
import { THREAD_SEND_MESSAGE_MAX_LENGTH } from "../thread-control.js";
import { lazySchema } from "../utils/lazySchema.js";
import { MessageMentionsSchema } from "./mention.js";

/** The one selected-text comment that a ComposerDraft can send in this slice. */
export const MAX_SELECTED_TEXT_COMMENTS = 1;

/** Maximum source quote or note length, bounded by the accepted thread-message payload. */
export const MAX_SELECTED_TEXT_COMMENT_TEXT_CHARS = THREAD_SEND_MESSAGE_MAX_LENGTH;

const SourceIdentitySchema = z.string().trim().min(1).max(256);
const CommentTextSchema = z.string()
  .max(MAX_SELECTED_TEXT_COMMENT_TEXT_CHARS)
  .refine((value) => value.trim().length > 0, {
    message: "Selected text comments require visible text",
  });

const buildSelectedTextCommentSourceSchema = () =>
  z.object({
    threadId: SourceIdentitySchema,
    messageId: SourceIdentitySchema,
    sourceRole: z.enum(["user", "assistant"]),
    start: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    end: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    quote: CommentTextSchema,
  }).strict().refine((source) => source.end > source.start, {
    message: "Selected text comment end must be greater than start",
    path: ["end"],
  });

type SelectedTextCommentSourceZodSchema = ReturnType<typeof buildSelectedTextCommentSourceSchema>;

/** Durable source coordinates for one selected-text comment. */
export const SelectedTextCommentSourceSchema: () => SelectedTextCommentSourceZodSchema = lazySchema(
  buildSelectedTextCommentSourceSchema,
);

const buildSelectedTextCommentSchema = () =>
  z.object({
    id: z.string().uuid(),
    displayNumber: z.literal(1),
    source: SelectedTextCommentSourceSchema(),
    note: CommentTextSchema,
    mentions: MessageMentionsSchema,
  }).strict();

type SelectedTextCommentZodSchema = ReturnType<typeof buildSelectedTextCommentSchema>;

/** Durable selected-text comment attached to a user Message. */
export const SelectedTextCommentSchema: () => SelectedTextCommentZodSchema = lazySchema(
  buildSelectedTextCommentSchema,
);

const buildSelectedTextCommentsSchema = () =>
  z.array(SelectedTextCommentSchema()).max(MAX_SELECTED_TEXT_COMMENTS);

type SelectedTextCommentsZodSchema = ReturnType<typeof buildSelectedTextCommentsSchema>;

/** One-comment collection carried unchanged across renderer, transport, and persistence. */
export const SelectedTextCommentsSchema: () => SelectedTextCommentsZodSchema = lazySchema(
  buildSelectedTextCommentsSchema,
);

/** Durable source coordinates for one selected-text comment. */
export type SelectedTextCommentSource = z.infer<ReturnType<typeof SelectedTextCommentSourceSchema>>;

/** Durable selected-text comment attached to a user Message. */
export type SelectedTextComment = z.infer<ReturnType<typeof SelectedTextCommentSchema>>;
