import { describe, it, expect } from "vitest";
import { CreateAndSendSchema, SendMessageSchema, WS_METHODS } from "../ws/methods.js";
import { supportsCodexUltraOrchestration } from "../providers/codex-static-fallback.js";
import { MAX_GOAL_OBJECTIVE_CHARS } from "../models/goal.js";
import { MAX_ATTACHMENTS } from "../models/file-types.js";

const sampleAttachment = {
  id: "att-x",
  name: "note.txt",
  mimeType: "text/plain",
  sizeBytes: 4,
  sourcePath: "/tmp/note.txt",
};

const selectedTextComments = [{
  id: "11111111-1111-4111-8111-111111111111",
  displayNumber: 1,
  source: {
    threadId: "thread-1",
    messageId: "message-1",
    sourceRole: "assistant" as const,
    start: 0,
    end: 5,
    quote: "focus",
  },
  note: "Explain this choice.",
  mentions: [],
}];

describe("SendMessageSchema attachments", () => {
  it(`allows up to ${MAX_ATTACHMENTS} attachments`, () => {
    const attachments = Array.from({ length: MAX_ATTACHMENTS }, (_, i) => ({
      ...sampleAttachment,
      id: `att-${i}`,
    }));
    const result = SendMessageSchema().safeParse({
      threadId: "550e8400-e29b-41d4-a716-446655440000",
      content: "hi",
      attachments,
    });
    expect(result.success).toBe(true);
  });

  it("rejects more than MAX_ATTACHMENTS", () => {
    const attachments = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => ({
      ...sampleAttachment,
      id: `att-${i}`,
    }));
    const result = SendMessageSchema().safeParse({
      threadId: "550e8400-e29b-41d4-a716-446655440000",
      content: "hi",
      attachments,
    });
    expect(result.success).toBe(false);
  });
});

describe("SendMessageSchema client message identity", () => {
  const base = {
    threadId: "550e8400-e29b-41d4-a716-446655440000",
    content: "follow-up",
  };

  it("accepts a UUID and rejects a malformed client message ID", () => {
    expect(SendMessageSchema().safeParse({
      ...base,
      messageId: "550e8400-e29b-41d4-a716-446655440001",
    }).success).toBe(true);
    expect(SendMessageSchema().safeParse({
      ...base,
      messageId: "optimistic-message",
    }).success).toBe(false);
  });
});

describe("selected-text comment transport", () => {
  it("accepts saved cards on existing and initial turns, including comment-only submissions", () => {
    expect(SendMessageSchema().safeParse({
      threadId: "550e8400-e29b-41d4-a716-446655440000",
      content: "",
      selectedTextComments,
    }).success).toBe(true);
    expect(CreateAndSendSchema().safeParse({
      workspaceId: "550e8400-e29b-41d4-a716-446655440000",
      content: "",
      model: "claude-sonnet-4-6",
      selectedTextComments,
    }).success).toBe(true);
  });
});

describe("typed goal objectives", () => {
  it("accepts bounded objectives on send and create-and-send", () => {
    const goalObjective = "Ship the composer capability";
    expect(SendMessageSchema().safeParse({
      threadId: "550e8400-e29b-41d4-a716-446655440000",
      content: goalObjective,
      goalObjective,
    }).success).toBe(true);
    expect(CreateAndSendSchema().safeParse({
      workspaceId: "550e8400-e29b-41d4-a716-446655440000",
      content: goalObjective,
      model: "claude-sonnet-4-6",
      goalObjective,
    }).success).toBe(true);
  });

  it("rejects blank and oversized objectives", () => {
    const base = {
      threadId: "550e8400-e29b-41d4-a716-446655440000",
      content: "run",
    };
    expect(SendMessageSchema().safeParse({ ...base, goalObjective: "   " }).success).toBe(false);
    expect(SendMessageSchema().safeParse({
      ...base,
      goalObjective: "x".repeat(MAX_GOAL_OBJECTIVE_CHARS + 1),
    }).success).toBe(false);
  });
});

describe("orchestration mode", () => {
  it("accepts proactive orchestration on send, create-and-send, and thread settings", () => {
    expect(SendMessageSchema().safeParse({
      threadId: "550e8400-e29b-41d4-a716-446655440000",
      content: "delegate this work",
      orchestrationMode: "proactive",
    }).success).toBe(true);
    expect(CreateAndSendSchema().safeParse({
      workspaceId: "550e8400-e29b-41d4-a716-446655440000",
      content: "delegate this work",
      model: "gpt-5.6-sol",
      orchestrationMode: "proactive",
    }).success).toBe(true);
    expect(WS_METHODS()["thread.updateSettings"].params.safeParse({
      threadId: "550e8400-e29b-41d4-a716-446655440000",
      orchestrationMode: "proactive",
    }).success).toBe(true);
  });

  it("advertises Codex Ultra for Astra, Sol, and Terra", () => {
    expect(supportsCodexUltraOrchestration("gpt-6-astra")).toBe(true);
    expect(supportsCodexUltraOrchestration("gpt-5.6-sol")).toBe(true);
    expect(supportsCodexUltraOrchestration("gpt-5.6-terra")).toBe(true);
    expect(supportsCodexUltraOrchestration("gpt-5.6-luna")).toBe(false);
    expect(supportsCodexUltraOrchestration("gpt-5.4")).toBe(false);
  });
});
