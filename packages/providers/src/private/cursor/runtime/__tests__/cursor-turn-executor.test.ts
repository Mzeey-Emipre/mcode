import type { SessionNotification } from "@agentclientprotocol/sdk";
import { AgentEventType, getDefaultSettings } from "@mcode/contracts";
import type { AgentEvent } from "@mcode/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  createCursorAcpTurnState,
  mapCursorAcpSessionNotification,
  type CursorAcpTurnState,
} from "../../acp/cursor-acp-event-mapper.js";
import type { CursorCanonicalEventRouting } from "../../cursor-canonical-event-publisher.js";
import type { CursorSessionState } from "../../cursor-session-state.js";
import { CursorTurnExecutor } from "../cursor-turn-executor.js";

const ROUTING: CursorCanonicalEventRouting = {
  threadId: "thread-1",
  turnId: "turn-1",
  executionId: "execution-1",
  deliveryAttempt: 1,
};

function sessionUpdate(update: Record<string, unknown>): SessionNotification {
  return { sessionId: "cursor-session-1", update } as SessionNotification;
}

describe("CursorTurnExecutor", () => {
  it("uses a fresh state on a replacement connection after a transient retry", async () => {
    const settings = getDefaultSettings();
    settings.provider.cursor.retryTransientFailuresOnce = true;
    const published: AgentEvent[] = [];
    const routeBindings: Array<{ state: CursorAcpTurnState; routing: CursorCanonicalEventRouting }> = [];
    const openingState = createCursorAcpTurnState();
    const failedPrompt = vi.fn(async () => {
      const state = entry.activeTurnState!;
      mapCursorAcpSessionNotification(sessionUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "failed partial" },
      }), entry.threadId, state).forEach((event) => published.push(event));
      mapCursorAcpSessionNotification(sessionUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "attempt-one-tool",
        title: "Read File",
        kind: "read",
        rawInput: { path: "first.txt" },
      }), entry.threadId, state).forEach((event) => published.push(event));
      throw new Error("[canceled] http/2 stream closed with error code CANCEL (0x8)");
    });
    const replacementPrompt = vi.fn(async () => {
      const state = replacement.activeTurnState!;
      mapCursorAcpSessionNotification(sessionUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "second response" },
      }), replacement.threadId, state).forEach((event) => published.push(event));
      return { stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
    });
    const entry = {
      threadId: ROUTING.threadId,
      cwd: process.cwd(),
      acpSessionId: "cursor-session-1",
      activeTurnState: openingState,
      replayTurnState: null,
      cursorPromptOrdinal: 0,
      stickyHeavyInstructionsSent: false,
      mcodeRuntimeInstructions: "",
      mcodeRuntimeInstructionsSent: false,
      pendingUserStopAbort: false,
      stderrTailLines: [],
      acpRuntime: { prompt: failedPrompt },
    } as unknown as CursorSessionState;
    const replacement = {
      ...entry,
      activeTurnState: null,
      acpRuntime: { prompt: replacementPrompt },
    } as unknown as CursorSessionState;
    const executor = new CursorTurnExecutor({
      settings: { get: () => settings },
      skills: { list: () => [] },
      publishEvent: (_entry, event) => published.push(event),
      bindTurnRouting: (boundEntry, routing) => {
        routeBindings.push({ state: boundEntry.activeTurnState!, routing });
      },
      openLogicalSession: vi.fn(async () => true),
      applyModel: vi.fn(async () => undefined),
      replaceAfterTransientFailure: vi.fn(async () => replacement),
    });

    await executor.run(entry, {
      message: "continue",
      model: "cursor-model",
      resume: false,
      turnId: ROUTING.turnId,
      turnExecutionId: ROUTING.executionId,
      deliveryAttempt: ROUTING.deliveryAttempt,
    });

    expect(failedPrompt).toHaveBeenCalledOnce();
    expect(replacementPrompt).toHaveBeenCalledOnce();
    expect(routeBindings.map(({ routing }) => routing)).toEqual([ROUTING, ROUTING]);
    expect(routeBindings[0]?.state).toBe(openingState);
    expect(routeBindings[1]?.state).not.toBe(routeBindings[0]?.state);
    expect(routeBindings[0]?.state.accumulator.assistantText).toBe("failed partial");
    expect(routeBindings[0]?.state.accumulator.pendingToolCalls).toEqual(new Set(["attempt-one-tool"]));
    expect(routeBindings[1]?.state.accumulator).toMatchObject({
      assistantText: "second response",
      assistantFinalText: "",
      hasFiredToolThisTurn: false,
    });
    expect(routeBindings[1]?.state.accumulator.pendingToolCalls).toEqual(new Set());
    expect(routeBindings[1]?.state.toolNameByCallId).toEqual(new Map());
    expect(published).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: AgentEventType.TextDelta, delta: "failed partial" }),
      expect.objectContaining({ type: AgentEventType.ToolUse, toolCallId: "attempt-one-tool" }),
      expect.objectContaining({ type: AgentEventType.TextDelta, delta: "second response" }),
    ]));
    expect(published).toContainEqual(expect.objectContaining({
      type: AgentEventType.Message,
      content: "second response",
      turnExecutionId: ROUTING.executionId,
    }));
    expect(published).not.toContainEqual(expect.objectContaining({
      type: AgentEventType.Message,
      content: expect.stringContaining("failed partial"),
    }));
  });

  it("does not retry when no logical Cursor session can be recovered", async () => {
    const settings = getDefaultSettings();
    settings.provider.cursor.retryTransientFailuresOnce = true;
    const published: AgentEvent[] = [];
    const prompt = vi.fn(async () => {
      throw new Error("[canceled] http/2 stream closed with error code CANCEL (0x8)");
    });
    const entry = {
      threadId: ROUTING.threadId,
      cwd: process.cwd(),
      acpSessionId: "",
      activeTurnState: null,
      replayTurnState: null,
      cursorPromptOrdinal: 0,
      stickyHeavyInstructionsSent: false,
      mcodeRuntimeInstructions: "",
      mcodeRuntimeInstructionsSent: false,
      pendingUserStopAbort: false,
      stderrTailLines: [],
      child: { pid: null, exitCode: null, signalCode: null },
      acpRuntime: { prompt },
    } as unknown as CursorSessionState;
    const replaceAfterTransientFailure = vi.fn(async () => undefined);
    const executor = new CursorTurnExecutor({
      settings: { get: () => settings },
      skills: { list: () => [] },
      publishEvent: (_entry, event) => published.push(event),
      bindTurnRouting: () => undefined,
      openLogicalSession: vi.fn(async () => true),
      applyModel: vi.fn(async () => undefined),
      replaceAfterTransientFailure,
    });

    await executor.run(entry, {
      message: "first prompt",
      model: "cursor-model",
      resume: false,
      turnId: ROUTING.turnId,
      turnExecutionId: ROUTING.executionId,
      deliveryAttempt: ROUTING.deliveryAttempt,
    });

    expect(prompt).toHaveBeenCalledOnce();
    expect(replaceAfterTransientFailure).toHaveBeenCalledOnce();
    expect(published).toContainEqual(expect.objectContaining({ type: AgentEventType.Error }));
  });
});
