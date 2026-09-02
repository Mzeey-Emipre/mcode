import { z } from "zod";
import { THREAD_SEND_MESSAGE_MAX_LENGTH } from "../thread-control.js";
import { lazySchema } from "../utils/lazySchema.js";
import { MessageMentionsSchema } from "./mention.js";

/** Maximum source quote or note length, bounded by the accepted thread-message payload. */
export const MAX_SELECTED_TEXT_COMMENT_TEXT_CHARS = THREAD_SEND_MESSAGE_MAX_LENGTH;
/** Maximum structural entries accepted from one untrusted transport payload. */
export const MAX_SELECTED_TEXT_COMMENTS = 128;
/** Maximum combined source quote and note characters accepted from one payload. */
export const MAX_SELECTED_TEXT_COMMENT_TOTAL_CHARS = THREAD_SEND_MESSAGE_MAX_LENGTH;

const SourceIdentitySchema = z.string().trim().min(1).max(256);
const CommentTextSchema = z.string()
  .max(MAX_SELECTED_TEXT_COMMENT_TEXT_CHARS)
  .refine((value) => value.trim().length > 0, {
    message: "Selected text comments require visible text",
  });

/** Durable source coordinates for one selected-text comment. */
export const SelectedTextCommentSourceSchema = lazySchema(() =>
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
  }),
);

/** Durable selected-text comment attached to a user Message. */
export const SelectedTextCommentSchema = lazySchema(() =>
  z.object({
    id: z.string().uuid(),
    displayNumber: z.number().int().min(1),
    source: SelectedTextCommentSourceSchema(),
    note: CommentTextSchema,
    mentions: MessageMentionsSchema(),
  }).strict(),
);

/** Selected-text comments carried unchanged across renderer, transport, and persistence. */
export const SelectedTextCommentsSchema = lazySchema(() =>
  z.array(SelectedTextCommentSchema()).max(MAX_SELECTED_TEXT_COMMENTS).superRefine((comments, context) => {
    const ids = new Set<string>();
    let totalCharacters = 0;
    for (const [index, comment] of comments.entries()) {
      if (ids.has(comment.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Selected text comment IDs must be unique",
          path: [index, "id"],
        });
      }
      ids.add(comment.id);
      if (comment.displayNumber !== index + 1) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Selected text comment display numbers must be contiguous",
          path: [index, "displayNumber"],
        });
      }
      totalCharacters += comment.source.quote.length + comment.note.length;
    }
    // The UI has no count limit. Transport input still needs one shared budget.
    if (totalCharacters > MAX_SELECTED_TEXT_COMMENT_TOTAL_CHARS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Selected text comments exceed the message payload budget",
      });
    }
    if (JSON.stringify(comments).length > MAX_SELECTED_TEXT_COMMENT_TOTAL_CHARS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Selected text comments exceed the serialized message payload budget",
      });
    }
  }),
);

/** Durable source coordinates for one selected-text comment. */
export type SelectedTextCommentSource = z.infer<ReturnType<typeof SelectedTextCommentSourceSchema>>;

/** Durable selected-text comment attached to a user Message. */
export type SelectedTextComment = z.infer<ReturnType<typeof SelectedTextCommentSchema>>;
