import { describe, expect, it } from "vitest";
import type { MessageMention, SelectedTextCommentSource } from "@mcode/contracts";
import {
  MAX_MESSAGE_MENTIONS,
  MAX_SELECTED_TEXT_COMMENT_TEXT_CHARS,
} from "@mcode/contracts";
import {
  buildSelectedTextComment,
  canSaveSelectedTextComment,
  decideCommentDismissal,
} from "./comment-editor-model";

const source: SelectedTextCommentSource = {
  threadId: "thread-1",
  messageId: "message-1",
  sourceRole: "assistant",
  start: 8,
  end: 16,
  quote: "important",
};

const mentions: MessageMention[] = [{
  id: "mention-1",
  kind: "file",
  label: "notes.ts",
  path: "src/notes.ts",
  range: { start: 0, end: 9 },
}];

describe("selected-text comment editor model", () => {
  it("rejects blank and contract-exceeding comment drafts", () => {
    expect(canSaveSelectedTextComment("   ", [])).toBe(false);
    expect(canSaveSelectedTextComment("Valid note", [])).toBe(true);
    expect(canSaveSelectedTextComment("x".repeat(MAX_SELECTED_TEXT_COMMENT_TEXT_CHARS + 1), [])).toBe(false);
    expect(canSaveSelectedTextComment("Valid note", Array.from({ length: MAX_MESSAGE_MENTIONS + 1 }, () => mentions[0]))).toBe(false);
  });

  it("builds a new comment with its captured source and typed mention metadata", () => {
    const comment = buildSelectedTextComment({
      source,
      note: "@notes.ts needs clarification",
      mentions,
    });

    expect(comment).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
      displayNumber: 1,
      source,
      note: "@notes.ts needs clarification",
      mentions,
    });
  });

  it("updates a saved comment without changing its durable identity or source", () => {
    const existing = {
      id: "11111111-1111-4111-8111-111111111111",
      displayNumber: 1 as const,
      source,
      note: "Original note",
      mentions: [],
    };

    expect(buildSelectedTextComment({
      comment: existing,
      source: { ...source, quote: "different text" },
      note: "Reworded note",
      mentions,
    })).toEqual({
      ...existing,
      note: "Reworded note",
      mentions,
    });
  });

  it("requires a separate confirmation for each dirty-dismissal family and re-arms after editing", () => {
    expect(decideCommentDismissal({
      family: "escape",
      isDirty: true,
      escapeWarned: false,
      outsideWarned: false,
    })).toEqual({
      kind: "warn",
      announcement: "Press Escape again to discard this comment.",
    });
    expect(decideCommentDismissal({
      family: "outside",
      isDirty: true,
      escapeWarned: true,
      outsideWarned: false,
    })).toEqual({
      kind: "warn",
      announcement: "Repeat this action to discard this comment.",
    });
    expect(decideCommentDismissal({
      family: "outside",
      isDirty: true,
      escapeWarned: true,
      outsideWarned: true,
    })).toEqual({ kind: "close" });
    expect(decideCommentDismissal({
      family: "escape",
      isDirty: true,
      escapeWarned: false,
      outsideWarned: false,
    })).toEqual({
      kind: "warn",
      announcement: "Press Escape again to discard this comment.",
    });
  });
});
