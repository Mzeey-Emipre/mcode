import { describe, expect, it } from "vitest";
import { SelectedTextCommentsSchema } from "../selected-text-comment.js";

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
  it("accepts one durable comment with structured mention metadata", () => {
    expect(SelectedTextCommentsSchema().parse([comment])).toEqual([comment]);
  });

  it("rejects a collection that cannot represent one valid selected range", () => {
    const invalidCollections = [
      [{ ...comment, id: "not-a-uuid" }],
      [{ ...comment, source: { ...comment.source, start: 12, end: 12 } }],
      [{ ...comment, source: { ...comment.source, quote: "" } }],
      [comment, { ...comment, id: "9eb99cb2-ff6d-4d3b-a797-dc805bb98cfd" }],
    ];

    for (const value of invalidCollections) {
      expect(SelectedTextCommentsSchema().safeParse(value).success).toBe(false);
    }
  });
});
