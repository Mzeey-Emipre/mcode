import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentEventType } from "@mcode/contracts";
import type { AgentEvent } from "@mcode/contracts";
import {
  isCodexTraceEnabled,
  summarizeAgentEventsForTrace,
  summarizeCodexNotificationParams,
} from "../codex-trace.js";

describe("codex-trace", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("isCodexTraceEnabled is false when unset", () => {
    vi.stubEnv("MCODE_CODEX_TRACE", "");
    expect(isCodexTraceEnabled()).toBe(false);
  });

  it("isCodexTraceEnabled accepts 1 true yes case-insensitive", () => {
    vi.stubEnv("MCODE_CODEX_TRACE", "1");
    expect(isCodexTraceEnabled()).toBe(true);
    vi.stubEnv("MCODE_CODEX_TRACE", "TRUE");
    expect(isCodexTraceEnabled()).toBe(true);
  });

  it("summarizeCodexNotificationParams extracts collab item fields", () => {
    const s = summarizeCodexNotificationParams("item/completed", {
      item: {
        type: "collabAgentToolCall",
        id: "item-1",
        toolKind: "delegate",
      },
    });
    expect(s).toEqual({
      itemType: "collabAgentToolCall",
      itemId: "item-1",
      toolKind: "delegate",
      functionName: undefined,
    });
  });

  it("summarizeAgentEventsForTrace includes parentToolCallId when present", () => {
    const toolUse: AgentEvent = {
      type: AgentEventType.ToolUse,
      threadId: "t1",
      toolCallId: "c1",
      toolName: "Agent",
      toolInput: { a: 1 },
      parentToolCallId: "parent-9",
    };
    const rows = summarizeAgentEventsForTrace([toolUse]);
    expect(rows[0]).toMatchObject({
      type: "toolUse",
      toolName: "Agent",
      toolCallId: "c1",
      parentToolCallId: "parent-9",
    });
  });

  it("summarizes MCP startup status with bounded redacted diagnostics", () => {
    const s = summarizeCodexNotificationParams("mcpServer/startupStatus/updated", {
      threadId: "thread-1",
      name: "mcode_internal_thread_control",
      status: "failed",
      failureReason: "Bearer super-secret-credential caused startup failure",
      error: "authorization=another-secret-value",
    });

    expect(s).toMatchObject({
      threadId: "thread-1",
      name: "mcode_internal_thread_control",
      status: "failed",
      errorPreview: "authorization=[redacted]",
      failureReasonPreview: "Bearer [redacted] caused startup failure",
    });
    expect(JSON.stringify(s)).not.toContain("super-secret-credential");
    expect(JSON.stringify(s)).not.toContain("another-secret-value");
  });

  it("summarizes ready MCP startup status without diagnostics", () => {
    expect(
      summarizeCodexNotificationParams("mcpServer/startupStatus/updated", {
        name: "mcode_internal_thread_control",
        status: "ready",
      }),
    ).toEqual({
      name: "mcode_internal_thread_control",
      status: "ready",
      errorPreview: undefined,
      failureReasonPreview: undefined,
    });
  });

  it("retains a bounded diagnostic preview", () => {
    const summary = summarizeCodexNotificationParams("mcpServer/startupStatus/updated", {
      name: "mcode_internal_thread_control",
      status: "failed",
      failureReason: "x".repeat(400),
    });

    expect(String(summary.failureReasonPreview)).toHaveLength(257);
    expect(String(summary.failureReasonPreview).endsWith("…")).toBe(true);
  });
});
