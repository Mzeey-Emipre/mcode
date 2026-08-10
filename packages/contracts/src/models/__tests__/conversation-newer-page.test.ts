import { describe, expect, it } from "vitest";
import {
  ConversationNewerPageRequestSchema,
  ConversationNewerPageSchema,
} from "../conversation-newer-page.js";

const identity = {
  threadId: "thread-1",
  cursor: { version: 1 as const, afterSequence: 10 },
  direction: "newer" as const,
  generation: 4,
  conversationRevision: 7,
};

describe("ConversationNewerPageRequestSchema", () => {
  it("accepts a bounded identity-bound newer request", () => {
    expect(ConversationNewerPageRequestSchema().safeParse({
      ...identity,
      limit: 50,
      maxBytes: 65_536,
    }).success).toBe(true);
  });

  it("rejects invalid cursors and boundary violations", () => {
    expect(ConversationNewerPageRequestSchema().safeParse({
      ...identity,
      cursor: { version: 2, afterSequence: 10 },
      limit: 50,
      maxBytes: 65_536,
    }).success).toBe(false);
    expect(ConversationNewerPageRequestSchema().safeParse({
      ...identity,
      limit: 101,
      maxBytes: 65_536,
    }).success).toBe(false);
    expect(ConversationNewerPageRequestSchema().safeParse({
      ...identity,
      limit: 50,
      maxBytes: 65_535,
    }).success).toBe(false);
  });
});

describe("ConversationNewerPageSchema", () => {
  it("accepts unique ascending messages after the cursor", () => {
    const result = ConversationNewerPageSchema().safeParse({
      identity,
      messages: [
        {
          id: "m11",
          thread_id: "thread-1",
          role: "user",
          content: "eleven",
          timestamp: "2026-08-10T00:00:00.000Z",
          sequence: 11,
          tool_calls: null,
          files_changed: null,
          cost_usd: null,
          tokens_used: null,
          attachments: null,
        },
      ],
      hasMore: true,
      nextCursor: { version: 1, afterSequence: 11 },
      narrativeByMessage: {},
    });

    expect(result.success).toBe(true);
  });

  it("rejects messages at or before the cursor and inconsistent continuation", () => {
    const result = ConversationNewerPageSchema().safeParse({
      identity,
      messages: [
        {
          id: "m10",
          thread_id: "thread-1",
          role: "user",
          content: "ten",
          timestamp: "2026-08-10T00:00:00.000Z",
          sequence: 10,
          tool_calls: null,
          files_changed: null,
          cost_usd: null,
          tokens_used: null,
          attachments: null,
        },
      ],
      hasMore: false,
      nextCursor: { version: 1, afterSequence: 10 },
      narrativeByMessage: {},
    });

    expect(result.success).toBe(false);
  });
});
