import { describe, expect, it } from "vitest";
import {
  CONVERSATION_TAIL_MAX_MESSAGES,
  ConversationTailMessageSchema,
  ConversationTailParamsSchema,
  ConversationTailSchema,
} from "../conversation-tail.js";

const message = {
  id: "message-2",
  thread_id: "thread-1",
  role: "assistant" as const,
  content: "Done",
  timestamp: "2026-07-29T12:00:00.000Z",
  sequence: 2,
};

describe("ConversationTailSchema", () => {
  it("accepts a bounded tail without narrative payload", () => {
    const result = ConversationTailSchema().safeParse({
      messages: [message],
      hasMore: true,
      nextBefore: 2,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.messages).toEqual([message]);
      expect("narrativeByMessage" in result.data).toBe(false);
    }
  });

  it("rejects more than two messages", () => {
    const result = ConversationTailSchema().safeParse({
      messages: [message, { ...message, id: "message-1", sequence: 1 }, { ...message, id: "message-0", sequence: 0 }],
      hasMore: false,
    });

    expect(result.success).toBe(false);
  });

  it("bounds the request limit to the first-paint tail size", () => {
    expect(ConversationTailParamsSchema().safeParse({ threadId: "thread-1", limit: CONVERSATION_TAIL_MAX_MESSAGES }).success).toBe(true);
    expect(ConversationTailParamsSchema().safeParse({ threadId: "thread-1", limit: CONVERSATION_TAIL_MAX_MESSAGES + 1 }).success).toBe(false);
    expect(ConversationTailParamsSchema().safeParse({ threadId: "thread-1", limit: 0 }).success).toBe(false);
  });

  it("does not accept narrative fields on a tail message", () => {
    const result = ConversationTailMessageSchema().safeParse({
      ...message,
      tool_calls: [],
      narrativeByMessage: {},
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("tool_calls");
      expect(result.data).not.toHaveProperty("narrativeByMessage");
    }
  });
});
