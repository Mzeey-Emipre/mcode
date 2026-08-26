import { describe, expect, it } from "vitest";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { AgentEventType } from "@mcode/contracts";
import {
  sanitizeCursorTraceValue,
  shouldEmitCursorSessionTrace,
  summarizeEmittedAgentEventsForTrace,
} from "../cursor-acp-session-trace.js";

describe("cursor-acp-session-trace", () => {
  it("truncates oversized strings inside nested objects", () => {
    const long = "z".repeat(5_000);
    const sanitized = sanitizeCursorTraceValue({
      nested: long,
      short: "ok",
    }) as Record<string, unknown>;

    expect(typeof sanitized.nested).toBe("string");
    const sn = sanitized.nested as string;
    expect(sn.length).toBeLessThan(4_500);
    expect(sn).toContain("5000 chars total");
    expect(sanitized.short).toBe("ok");
  });

  it("summarizes AgentEvent payloads without dumping large tool outputs", () => {
    const rows = summarizeEmittedAgentEventsForTrace([
      {
        type: AgentEventType.ToolUse,
        threadId: "t1",
        toolCallId: "c1",
        toolName: "Read",
        toolInput: { path: "/tmp/x.ts" },
      },
      {
        type: AgentEventType.ToolResult,
        threadId: "t1",
        toolCallId: "c1",
        output: "hello".repeat(1000),
        isError: false,
      },
    ]);

    expect(rows[0]).toMatchObject({
      type: "toolUse",
      toolCallId: "c1",
      toolName: "Read",
      toolInputKeys: ["path"],
    });
    expect(rows[1]).toMatchObject({
      type: "toolResult",
      outputChars: 5000,
    });
  });

  it("drops chatty streaming chunks but keeps idle tool envelopes", () => {
    expect(
      shouldEmitCursorSessionTrace(
        { sessionId: "s", update: { sessionUpdate: "agent_message_chunk" } as never },
        0,
      ),
    ).toBe(false);

    expect(
      shouldEmitCursorSessionTrace(
        {
          sessionId: "s",
          update: { sessionUpdate: "tool_call" } as SessionNotification["update"],
        },
        0,
      ),
    ).toBe(true);

    expect(
      shouldEmitCursorSessionTrace(
        {
          sessionId: "s",
          update: { sessionUpdate: "available_commands_update" } as SessionNotification["update"],
        },
        0,
      ),
    ).toBe(false);

    expect(
      shouldEmitCursorSessionTrace(
        {
          sessionId: "s",
          update: { sessionUpdate: "available_commands_update" } as SessionNotification["update"],
        },
        1,
      ),
    ).toBe(true);
  });
});
