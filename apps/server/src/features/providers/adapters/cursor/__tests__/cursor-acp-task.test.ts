import { describe, expect, it } from "vitest";
import { AgentEventType } from "@mcode/contracts";
import {
  createCursorAcpTurnState,
  mapCursorAcpSessionNotification,
} from "../cursor-acp-event-mapper.js";
import {
  cursorTaskExtToAgentEvents,
  cursorTaskToolCallStartedToAgentEvents,
  isCursorTaskAcpTool,
  taskDescriptionFromAcpTitle,
} from "../cursor-acp-task.js";

/** Shapes observed in live capture (2026-05-20, agent acp). */
const CAPTURED_TASK_TOOL_CALL = {
  sessionUpdate: "tool_call" as const,
  kind: "other" as const,
  rawInput: { _toolName: "task" },
  status: "pending" as const,
  title: "Task: Subagent task",
  toolCallId: "tool_c1b1b251-a54e-421e-ae5f-44a2aa94abc",
};

const CAPTURED_TASK_EXT = {
  toolCallId: "tool_c1b1b251-a54e-421e-ae5f-44a2aa94abc",
  description: "Read cursor-subagent-detection.ts",
  prompt: "Read-only task. Find and read cursor-subagent-detection.ts.",
  subagentType: { custom: { unspecified: {} } },
  model: "composer-2.5-fast",
  agentId: "8efdb8f5-559f-4fcd-9d90-e36f22a47192",
  durationMs: 7456,
};

describe("cursor-acp-task", () => {
  const threadId = "t1";

  it("detects Task subagent tool_call markers from live ACP", () => {
    expect(isCursorTaskAcpTool({ _toolName: "task" }, "Task: Subagent task")).toBe(true);
    expect(isCursorTaskAcpTool({ _toolName: "updateTodos" }, "Update TODOs")).toBe(false);
  });

  it("derives provisional description from Task tool_call title", () => {
    expect(taskDescriptionFromAcpTitle("Task: Subagent task")).toBe("Subagent task");
    expect(taskDescriptionFromAcpTitle("")).toBe("Subagent task");
  });

  it("emits provisional Agent ToolUse when Task tool_call starts", () => {
    const state = createCursorAcpTurnState();
    const events = cursorTaskToolCallStartedToAgentEvents(
      threadId,
      CAPTURED_TASK_TOOL_CALL.toolCallId,
      CAPTURED_TASK_TOOL_CALL.title,
      state,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: AgentEventType.ToolUse,
      toolName: "Agent",
      toolInput: { description: "Subagent task" },
    });
  });

  it("maps cursor/task ext to Agent ToolUse with description and prompt", () => {
    const state = createCursorAcpTurnState();
    const events = cursorTaskExtToAgentEvents(threadId, CAPTURED_TASK_EXT, state);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: AgentEventType.ToolUse,
      toolName: "Agent",
      toolCallId: CAPTURED_TASK_EXT.toolCallId,
      toolInput: {
        description: CAPTURED_TASK_EXT.description,
        prompt: CAPTURED_TASK_EXT.prompt,
        model: CAPTURED_TASK_EXT.model,
        agentId: CAPTURED_TASK_EXT.agentId,
      },
    });
  });

  it("replays captured ACP order: tool_call, completed update, then cursor/task ext", () => {
    const state = createCursorAcpTurnState();
    const sessionId = "s";

    const started = mapCursorAcpSessionNotification(
      { sessionId, update: CAPTURED_TASK_TOOL_CALL },
      threadId,
      state,
    );
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      type: AgentEventType.ToolUse,
      toolName: "Agent",
      toolCallId: CAPTURED_TASK_TOOL_CALL.toolCallId,
    });

    const completed = mapCursorAcpSessionNotification(
      {
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          status: "completed",
          toolCallId: CAPTURED_TASK_TOOL_CALL.toolCallId,
          rawOutput: { durationMs: 7456, isBackground: false },
        },
      },
      threadId,
      state,
    );
    expect(completed).toEqual([]);

    const fromExt = cursorTaskExtToAgentEvents(threadId, CAPTURED_TASK_EXT, state);
    expect(fromExt).toHaveLength(2);
    expect(fromExt[0].type).toBe(AgentEventType.ToolUse);
    expect(fromExt[1].type).toBe(AgentEventType.ToolResult);
    expect((fromExt[0] as { toolName: string }).toolName).toBe("Agent");
  });
});
