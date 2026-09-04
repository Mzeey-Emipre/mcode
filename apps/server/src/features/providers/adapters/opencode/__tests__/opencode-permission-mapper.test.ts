import { describe, expect, it } from "vitest";
import {
  mapPermissionDecisionToReply,
  synthesizeOpenCodePermissionRequest,
  synthesizeOpenCodeQuestionRequest,
} from "../opencode-permission-mapper.js";

describe("mapPermissionDecisionToReply", () => {
  it("maps approve-once to once, session approval to always, and deny/cancel to reject", () => {
    expect(mapPermissionDecisionToReply("allow")).toBe("once");
    expect(mapPermissionDecisionToReply("allow-session")).toBe("always");
    expect(mapPermissionDecisionToReply("deny")).toBe("reject");
    expect(mapPermissionDecisionToReply("cancelled")).toBe("reject");
  });
});

describe("synthesizeOpenCodePermissionRequest", () => {
  it("builds a shell card from a v2 permission ask", () => {
    const request = synthesizeOpenCodePermissionRequest({
      threadId: "thread-1",
      properties: {
        id: "per_abc",
        sessionID: "ses_1",
        action: "bash",
        resources: ["echo hi"],
      },
    });
    expect(request).toEqual({
      requestId: "per_abc",
      threadId: "thread-1",
      toolName: "bash",
      input: { action: "bash", resources: ["echo hi"] },
    });
  });

  it("omits resources when the ask carries none", () => {
    const request = synthesizeOpenCodePermissionRequest({
      threadId: "thread-1",
      properties: { id: "per_1", sessionID: "ses_1", action: "edit" },
    });
    expect(request).toEqual({
      requestId: "per_1",
      threadId: "thread-1",
      toolName: "edit",
      input: { action: "edit" },
    });
  });

  it("builds a card from the legacy permission shape", () => {
    const request = synthesizeOpenCodePermissionRequest({
      threadId: "thread-1",
      properties: { id: "per_legacy", sessionID: "ses_1", permission: "edit" },
    });
    expect(request?.toolName).toBe("edit");
    expect(request?.requestId).toBe("per_legacy");
  });

  it("keeps hostile-only fields out of the card input", () => {
    const request = synthesizeOpenCodePermissionRequest({
      threadId: "thread-1",
      properties: {
        id: "per_1",
        action: "bash",
        resources: ["ls"],
        metadata: { exec: "rm -rf /", nested: { deep: true } },
        save: ["*"],
      },
    });
    expect(request?.input).toEqual({ action: "bash", resources: ["ls"] });
  });

  it("bounds long actions and resources instead of rejecting the card", () => {
    const request = synthesizeOpenCodePermissionRequest({
      threadId: "thread-1",
      properties: { id: "per_1", action: `b${"a".repeat(500)}`, resources: [`r${"e".repeat(900)}`] },
    });
    expect(request?.toolName).toBe(`b${"a".repeat(127)}`);
    expect(request?.input).toEqual({ action: `b${"a".repeat(127)}`, resources: [`r${"e".repeat(511)}`] });
  });

  it("returns null without a usable id or action", () => {
    expect(synthesizeOpenCodePermissionRequest({ threadId: "t", properties: {} })).toBeNull();
    expect(synthesizeOpenCodePermissionRequest({ threadId: "t", properties: { id: "per_1" } })).toBeNull();
    expect(synthesizeOpenCodePermissionRequest({ threadId: "t", properties: { action: "bash" } })).toBeNull();
    expect(synthesizeOpenCodePermissionRequest({ threadId: "t", properties: { id: "", action: "bash" } })).toBeNull();
  });
});

describe("synthesizeOpenCodeQuestionRequest", () => {
  it("builds bounded canonical questions with exact reply labels", () => {
    const result = synthesizeOpenCodeQuestionRequest({
      threadId: "thread-1",
      properties: {
        id: "que_1",
        sessionID: "ses_1",
        questions: [{
          header: "Deploy",
          question: "Deploy now?",
          options: [
            { label: "Yes", description: "Ship it" },
            { label: "No", description: "Wait" },
          ],
          multiple: true,
          custom: true,
        }],
      },
    });
    expect(result).toEqual({
      requestId: "que_1",
      threadId: "thread-1",
      toolName: "Question",
      input: {},
      title: "Deploy",
      questions: [{
        header: "Deploy",
        question: "Deploy now?",
        options: [
          { label: "Yes", description: "Ship it" },
          { label: "No", description: "Wait" },
        ],
        multiple: true,
        custom: true,
      }],
    });
  });

  it("returns null without a usable id or questions", () => {
    expect(synthesizeOpenCodeQuestionRequest({ threadId: "t", properties: {} })).toBeNull();
    expect(synthesizeOpenCodeQuestionRequest({
      threadId: "t",
      properties: { id: "que_1", questions: [] },
    })).toBeNull();
    expect(synthesizeOpenCodeQuestionRequest({
      threadId: "t",
      properties: { id: "que_1", questions: [{ header: "H" }] },
    })).toBeNull();
  });

  it("rejects oversized request identities and reply labels instead of changing them", () => {
    expect(synthesizeOpenCodeQuestionRequest({
      threadId: "thread-1",
      properties: {
        id: `que_${"x".repeat(128)}`,
        questions: [{ header: "Deploy", question: "Deploy?", options: [{ label: "Yes" }] }],
      },
    })).toBeNull();
    expect(synthesizeOpenCodeQuestionRequest({
      threadId: "thread-1",
      properties: {
        id: "que_1",
        questions: [{
          header: "Deploy",
          question: "Deploy?",
          options: [{ label: `Y${"e".repeat(100)}` }],
        }],
      },
    })).toBeNull();
  });
});
