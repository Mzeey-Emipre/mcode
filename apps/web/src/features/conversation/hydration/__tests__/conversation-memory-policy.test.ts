import { describe, expect, it } from "vitest";
import type { Message } from "@/transport";
import {
  ACTIVE_CONVERSATION_MESSAGE_BYTES,
  measureConversationMessages,
  selectConversationNarrative,
  selectConversationWindow,
} from "../conversation-memory-policy";

function makeMessages(count: number, contentBytes = 16_000): Message[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `message-${index + 1}`,
    thread_id: "thread-a",
    role: index % 2 === 0 ? "user" : "assistant",
    content: "x".repeat(contentBytes),
    tool_calls: null,
    files_changed: null,
    cost_usd: null,
    tokens_used: null,
    timestamp: "2026-08-10T00:00:00.000Z",
    sequence: index + 1,
    attachments: null,
  }));
}

describe("conversation memory policy", () => {
  it("measures representative 100-message and 1,000-message histories", () => {
    const hundredMessageBytes = measureConversationMessages(makeMessages(100));
    const thousandMessageBytes = measureConversationMessages(makeMessages(1_000));

    expect(hundredMessageBytes).toBeGreaterThan(1_600_000);
    expect(hundredMessageBytes).toBeLessThan(ACTIVE_CONVERSATION_MESSAGE_BYTES);
    expect(thousandMessageBytes).toBeGreaterThan(ACTIVE_CONVERSATION_MESSAGE_BYTES);
  });

  it("keeps the visible anchor and both reload boundaries under byte pressure", () => {
    const messages = makeMessages(1_000);
    const result = selectConversationWindow(messages, {
      anchorMessageId: "message-500",
      maxBytes: ACTIVE_CONVERSATION_MESSAGE_BYTES,
      maxMessages: 200,
      preference: "older",
    });

    expect(result.messages.some((message) => message.id === "message-500")).toBe(true);
    expect(result.evictedOlder).toBe(true);
    expect(result.evictedNewer).toBe(true);
    expect(measureConversationMessages(result.messages)).toBeLessThanOrEqual(
      ACTIVE_CONVERSATION_MESSAGE_BYTES,
    );
  });

  it("does not retain one narrative entry that exceeds the narrative budget", () => {
    const messages = makeMessages(1, 10);
    const result = selectConversationNarrative(
      { "message-1": { output: "x".repeat(1_000) } },
      messages,
      { anchorMessageId: "message-1", maxBytes: 100 },
    );

    expect(result).toEqual({});
  });
});
