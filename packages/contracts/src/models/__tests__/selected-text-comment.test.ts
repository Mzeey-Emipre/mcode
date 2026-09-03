import { describe, expect, it } from "vitest";
import {
  MAX_SELECTED_TEXT_COMMENTS,
  MAX_SELECTED_TEXT_COMMENT_TOTAL_CHARS,
  SelectedTextCommentsSchema,
} from "../selected-text-comment.js";

const comment = {
  id: "76da3c6e-6b42-4c01-aaf2-3ad0b29a4756",
  displayNumber: 1,
  source: {
    threadId: "thread-7",
    messageId: "message-9",
    sourceRole: "assistant",
    start: 4,
    end: 12,
    quote: "const x;",
  },
  note: "Why this branch?",
  mentions: [{
    id: "file:src/index.ts",
    kind: "file",
    label: "src/index.ts",
    path: "src/index.ts",
    range: { start: 0, end: 12 },
  }],
};

describe("SelectedTextCommentsSchema", () => {
  it("accepts several durable comments with stable display numbers and structured mentions", () => {
    const nextComment = {
      ...comment,
      id: "9eb99cb2-ff6d-4d3b-a797-dc805bb98cfd",
      displayNumber: 2,
    };

    expect(SelectedTextCommentsSchema().parse([comment, nextComment])).toEqual([comment, nextComment]);
  });

  it("rejects a collection that cannot represent one valid selected range", () => {
    const invalidCollections = [
      [{ ...comment, id: "not-a-uuid" }],
      [{ ...comment, source: { ...comment.source, start: 12, end: 12 } }],
      [{ ...comment, source: { ...comment.source, quote: "" } }],
      [{ ...comment, displayNumber: 0 }],
    ];

    for (const value of invalidCollections) {
      expect(SelectedTextCommentsSchema().safeParse(value).success).toBe(false);
    }
  });

  it("rejects structural overflow without imposing a UI-facing comment limit", () => {
    const tooMany = Array.from({ length: MAX_SELECTED_TEXT_COMMENTS + 1 }, (_, index) => ({
      ...comment,
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      displayNumber: index + 1,
    }));

    expect(SelectedTextCommentsSchema().safeParse(tooMany).success).toBe(false);
  });

  it("rejects comments that exceed the shared message payload budget", () => {
    const oversized = [{
      ...comment,
      source: { ...comment.source, quote: "a".repeat(MAX_SELECTED_TEXT_COMMENT_TOTAL_CHARS) },
      note: "b",
    }];

    expect(SelectedTextCommentsSchema().safeParse(oversized).success).toBe(false);
  });

  it("rejects serialized metadata that exceeds the shared message payload budget", () => {
    const oversized = [{
      ...comment,
      mentions: Array.from({ length: 50 }, (_, index) => ({
        id: `file-${index}`,
        kind: "file" as const,
        label: "file.ts",
        path: `src/${"a".repeat(4_000)}-${index}.ts`,
        range: { start: 0, end: 1 },
      })),
    }];

    expect(SelectedTextCommentsSchema().safeParse(oversized).success).toBe(false);
  });

  it("rejects duplicate IDs and display numbers that do not match creation order", () => {
    const duplicateIds = [comment, { ...comment, displayNumber: 2 }];
    const skippedDisplayNumber = [{ ...comment, displayNumber: 2 }];

    expect(SelectedTextCommentsSchema().safeParse(duplicateIds).success).toBe(false);
    expect(SelectedTextCommentsSchema().safeParse(skippedDisplayNumber).success).toBe(false);
  });
});
