import { describe, expect, it } from "vitest";
import {
  CONVERSATION_OLDER_PAGE_MAX_BYTES,
  CONVERSATION_OLDER_PAGE_MAX_MESSAGES,
  ConversationOlderPageRequestSchema,
  ConversationOlderPageSchema,
} from "../conversation-older-page.js";

const identity = {
  threadId: "thread-1",
  cursor: { version: 1 as const, beforeSequence: 42 },
  direction: "older" as const,
  generation: 3,
  conversationRevision: 7,
};

describe("ConversationOlderPageRequestSchema", () => {
  it("accepts a complete versioned request identity", () => {
    expect(ConversationOlderPageRequestSchema().safeParse({
      ...identity,
      limit: CONVERSATION_OLDER_PAGE_MAX_MESSAGES,
      maxBytes: CONVERSATION_OLDER_PAGE_MAX_BYTES,
    }).success).toBe(true);
  });

  it("rejects unsupported cursors and values above the count and byte limits", () => {
    expect(ConversationOlderPageRequestSchema().safeParse({
      ...identity,
      cursor: { version: 2, beforeSequence: 42 },
      limit: 1,
      maxBytes: 65_536,
    }).success).toBe(false);
    expect(ConversationOlderPageRequestSchema().safeParse({
      ...identity,
      limit: 1,
      maxBytes: 65_536,
      unboundedPayload: "x".repeat(5_000),
    }).success).toBe(false);
    expect(ConversationOlderPageRequestSchema().safeParse({
      ...identity,
      limit: CONVERSATION_OLDER_PAGE_MAX_MESSAGES + 1,
      maxBytes: CONVERSATION_OLDER_PAGE_MAX_BYTES + 1,
    }).success).toBe(false);
  });
});

describe("ConversationOlderPageSchema", () => {
  it("echoes request identity and advances with a stable sequence cursor", () => {
    const message = {
      id: "message-21",
      thread_id: "thread-1",
      role: "assistant" as const,
      content: "done",
      tool_calls: null,
      files_changed: null,
      cost_usd: null,
      tokens_used: null,
      timestamp: "2026-08-09T00:00:00.000Z",
      sequence: 21,
      attachments: null,
    };
    const result = ConversationOlderPageSchema().safeParse({
      identity,
      messages: [message],
      hasMore: true,
      nextCursor: { version: 1, beforeSequence: 21 },
      narrativeByMessage: { "message-21": { tools: [], thoughts: [], hooks: [] } },
    });

    expect(result.success).toBe(true);
  });

  it("rejects responses above the global count boundary", () => {
    const message = {
      id: "message",
      thread_id: "thread-1",
      role: "assistant" as const,
      content: "done",
      tool_calls: null,
      files_changed: null,
      cost_usd: null,
      tokens_used: null,
      timestamp: "2026-08-09T00:00:00.000Z",
      sequence: 1,
      attachments: null,
    };
    const result = ConversationOlderPageSchema().safeParse({
      identity,
      messages: Array.from(
        { length: CONVERSATION_OLDER_PAGE_MAX_MESSAGES + 1 },
        (_, index) => ({ ...message, id: `message-${index}`, sequence: index + 1 }),
      ),
      hasMore: false,
      nextCursor: null,
      narrativeByMessage: {},
    });

    expect(result.success).toBe(false);
  });

  it("rejects messages that are duplicated, out of order, or outside the cursor", () => {
    const message = {
      id: "message-1",
      thread_id: "thread-1",
      role: "assistant" as const,
      content: "done",
      tool_calls: null,
      files_changed: null,
      cost_usd: null,
      tokens_used: null,
      timestamp: "2026-08-09T00:00:00.000Z",
      sequence: 41,
      attachments: null,
    };
    const result = ConversationOlderPageSchema().safeParse({
      identity,
      messages: [message, { ...message }],
      hasMore: false,
      nextCursor: null,
      narrativeByMessage: {},
    });

    expect(result.success).toBe(false);
  });
});
