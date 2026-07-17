import { describe, it, expect } from "vitest";
import { CreateAndSendSchema, SendMessageSchema } from "../ws/methods.js";
import { MAX_GOAL_OBJECTIVE_CHARS } from "../models/goal.js";
import { MAX_ATTACHMENTS } from "../models/file-types.js";

const sampleAttachment = {
  id: "att-x",
  name: "note.txt",
  mimeType: "text/plain",
  sizeBytes: 4,
  sourcePath: "/tmp/note.txt",
};

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
