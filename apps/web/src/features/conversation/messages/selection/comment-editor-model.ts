import type {
  MessageMention,
  SelectedTextComment,
  SelectedTextCommentSource,
} from "@mcode/contracts";
import {
  MAX_MESSAGE_MENTIONS,
  MAX_SELECTED_TEXT_COMMENT_TEXT_CHARS,
} from "@mcode/contracts";

export type CommentDismissalFamily = "escape" | "outside";

export type CommentDismissalDecision =
  | { readonly kind: "close" }
  | { readonly kind: "warn"; readonly announcement: string };

/** Returns whether one note and its typed mentions fit the comment contract. */
export function canSaveSelectedTextComment(
  note: string,
  mentions: readonly MessageMention[],
): boolean {
  return note.trim().length > 0
    && note.length <= MAX_SELECTED_TEXT_COMMENT_TEXT_CHARS
    && mentions.length <= MAX_MESSAGE_MENTIONS;
}

/** Builds the durable comment payload from the compact editor state. */
export function buildSelectedTextComment({
  comment,
  source,
  note,
  mentions,
}: {
  readonly comment?: SelectedTextComment;
  readonly source: SelectedTextCommentSource;
  readonly note: string;
  readonly mentions: MessageMention[];
}): SelectedTextComment {
  return comment
    ? { ...comment, note, mentions }
    : {
        id: crypto.randomUUID(),
        displayNumber: 1,
        source,
        note,
        mentions,
      };
}

/** Applies the independent two-attempt dismissal policy for dirty comments. */
export function decideCommentDismissal({
  family,
  isDirty,
  escapeWarned,
  outsideWarned,
}: {
  readonly family: CommentDismissalFamily;
  readonly isDirty: boolean;
  readonly escapeWarned: boolean;
  readonly outsideWarned: boolean;
}): CommentDismissalDecision {
  if (!isDirty || (family === "escape" ? escapeWarned : outsideWarned)) {
    return { kind: "close" };
  }
  return {
    kind: "warn",
    announcement: family === "escape"
      ? "Press Escape again to discard this comment."
      : "Repeat this action to discard this comment.",
  };
}
