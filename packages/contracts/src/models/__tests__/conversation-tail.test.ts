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
  cost_usd: null,
  tokens_used: null,
  timestamp: "2026-07-29T12:00:00.000Z",
  sequence: 2,
  attachments: null,
};

const renderCompleteMessage = {
  ...message,
  content: "src/App.tsx",
  tool_calls: [{ name: "Read" }],
  files_changed: [{ path: "src/App.tsx" }],
  cost_usd: 0.42,
  tokens_used: 128,
  attachments: [
    { id: "attachment-1", name: "preview.png", mimeType: "image/png", sizeBytes: 128 },
  ],
  previewAnnotations: {
    schemaVersion: 1,
    annotations: [{
      kind: "diff",
      id: "550e8400-e29b-41d4-a716-446655440001",
      displayNumber: 1,
      filePath: "src/App.tsx",
      side: "right",
      line: 1,
      lineContent: "const app = true;",
      note: "Keep this visible.",
    }],
  },
  mentions: [{
    id: "file:src/App.tsx",
    kind: "file",
    label: "src/App.tsx",
    path: "src/App.tsx",
    range: { start: 0, end: 10 },
  }],
  tool_call_count: 1,
  reply_to_message_id: "message-1",
  quoted_text: "Earlier answer",
  model: "gpt-5.6",
  outcome: "completed",
  outcomeExecutionId: "execution-1",
  is_internal: false,
  legacyProvenance: {
    source: "messages",
    migrationVersion: 1,
    mapping: "legacy",
    reason: "Compatibility record",
  },
  parentAgentProvenance: {
    parentThreadId: "parent-thread",
    parentTurnId: "parent-turn",
    parentItemId: "parent-item",
    providerIdentities: [],
  },
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

  it("retains render metadata while stripping only excluded message fields", () => {
    const result = ConversationTailMessageSchema().safeParse(renderCompleteMessage);

    expect(result.success).toBe(true);
    if (result.success) {
      const {
        tool_calls: _toolCalls,
        files_changed: _filesChanged,
        legacyProvenance: _legacyProvenance,
        ...expected
      } = renderCompleteMessage;
      expect(result.data).toEqual(expected);
      expect(result.data).not.toHaveProperty("tool_calls");
      expect(result.data).not.toHaveProperty("files_changed");
      expect(result.data).not.toHaveProperty("legacyProvenance");
    }
  });
});
