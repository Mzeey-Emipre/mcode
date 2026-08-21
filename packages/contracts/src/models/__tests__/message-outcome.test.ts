import { describe, expect, it } from "vitest";
import { MessageSchema } from "../message.js";

const legacyMessage = {
  id: "message-1",
  thread_id: "thread-1",
  role: "assistant" as const,
  content: "answer",
  tool_calls: null,
  files_changed: null,
  cost_usd: null,
  tokens_used: null,
  timestamp: "2026-08-20T12:00:00.000Z",
  sequence: 1,
  attachments: null,
};

describe("Message outcome metadata", () => {
  it("accepts legacy rows without outcome metadata", () => {
    const parsed = MessageSchema().safeParse(legacyMessage);

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.outcome).toBeUndefined();
      expect(parsed.data.outcomeExecutionId).toBeUndefined();
    }
  });

  it("accepts null outcome metadata for rows without a terminal proof", () => {
    const parsed = MessageSchema().parse({
      ...legacyMessage,
      outcome: null,
      outcomeExecutionId: null,
    });

    expect(parsed.outcome).toBeNull();
    expect(parsed.outcomeExecutionId).toBeNull();
  });
});
