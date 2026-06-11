import {
  resetThreadStoreForTests,
  getTestActiveMessages,
  getTestThreadToolCalls,
  getTestThreadError,
  getTestThreadLastFallback,
} from "@/stores/thread-store-test-utils";
import { createEmptyThreadRecord, type ThreadRecord } from "@/stores/thread-record";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { countActiveSubagentCalls, useThreadStore } from "@/stores/threadStore";
import { mockTransport, createMockThread } from "./mocks/transport";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useToastStore } from "@/stores/toastStore";
import { useTaskStore } from "@/stores/taskStore";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

describe("handleAgentEvent branches", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useWorkspaceStore.setState({
      activeThreadId: "thread-1",
      threads: [createMockThread({ id: "thread-1" })],
    });
    useTaskStore.setState({ tasksByThread: {} });
    resetThreadStoreForTests({
      currentThreadId: "thread-1",
      runningThreadIds: new Set(["thread-1"]),
      records: new Map<string, ThreadRecord>([
        [
          "thread-1",
          {
            ...createEmptyThreadRecord(),
            messages: [],
            loading: false,
            agentStartTime: new Date("2026-01-01T00:00:00Z").getTime(),
          },
        ],
      ]),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("session.error clears thread running state and sets error", () => {
    useThreadStore.getState().handleAgentEvent("thread-1", {
      method: "session.error",
      params: { error: "Out of tokens" },
    });

    const state = useThreadStore.getState();
    expect(state.runningThreadIds.has("thread-1")).toBe(false);
    expect(getTestThreadError("thread-1")).toBe("Out of tokens");
  });

  it("session.system sdk_session_invalidated appends a reset hairline message", () => {
    useThreadStore.getState().handleAgentEvent("thread-1", {
      method: "session.system",
      params: { subtype: "sdk_session_invalidated" },
    });

    const messages = getTestActiveMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toBe(
      "Session reset. Earlier context cleared. Send again to continue.",
    );
  });

  it("session.system with an unknown subtype appends no message", () => {
    useThreadStore.getState().handleAgentEvent("thread-1", {
      method: "session.system",
      params: { subtype: "some_other_subtype" },
    });

    expect(getTestActiveMessages()).toHaveLength(0);
  });

  it("session.turnComplete without streaming content clears state only", () => {
    useThreadStore.getState().handleAgentEvent("thread-1", {
      method: "session.turnComplete",
      params: { sessionId: "mcode-thread-1", reason: "end_turn", costUsd: null, totalTokensIn: 0, totalTokensOut: 0 },
    });
    vi.runAllTimers();

    const state = useThreadStore.getState();
    expect(getTestActiveMessages()).toHaveLength(0);
    expect(state.runningThreadIds.has("thread-1")).toBe(false);
  });

  it("session.toolUse adds tool call to toolCallsByThread", () => {
    useThreadStore.getState().handleAgentEvent("thread-1", {
      method: "session.toolUse",
      params: { toolCallId: "tc1", toolName: "Read", toolInput: { path: "/foo" } },
    });
    vi.runAllTimers();

    const calls = getTestThreadToolCalls("thread-1");
    expect(calls).toHaveLength(1);
    expect(calls[0].toolName).toBe("Read");
    expect(calls[0].id).toBe("tc1");
    expect(calls[0].toolInput).toEqual({ path: "/foo" });
    expect(calls[0].isComplete).toBe(false);
  });

  it("session.toolUse ignores duplicate toolCallId (defense in depth)", () => {
    useThreadStore.getState().handleAgentEvent("thread-1", {
      method: "session.toolUse",
      params: { toolCallId: "dup", toolName: "Read", toolInput: { path: "/a" } },
    });
    useThreadStore.getState().handleAgentEvent("thread-1", {
      method: "session.toolUse",
      params: { toolCallId: "dup", toolName: "Read", toolInput: { path: "/b" } },
    });
    vi.runAllTimers();

    const calls = getTestThreadToolCalls("thread-1");
    expect(calls).toHaveLength(1);
    expect(calls[0].toolInput).toEqual({ path: "/a" });
  });

  it("session.toolUse merges enriched Agent toolInput for duplicate toolCallId", () => {
    useThreadStore.getState().handleAgentEvent("thread-1", {
      method: "session.toolUse",
      params: {
        toolCallId: "agent-1",
        toolName: "Agent",
        toolInput: { description: "Subagent task" },
      },
    });
    useThreadStore.getState().handleAgentEvent("thread-1", {
      method: "session.toolUse",
      params: {
        toolCallId: "agent-1",
        toolName: "Agent",
        toolInput: {
          description: "Read detection file",
          prompt: "Read cursor-subagent-detection.ts",
          model: "composer-2.5-fast",
        },
      },
    });
    vi.runAllTimers();

    const calls = getTestThreadToolCalls("thread-1");
    expect(calls).toHaveLength(1);
    expect(calls[0].toolInput).toMatchObject({
      description: "Read detection file",
      prompt: "Read cursor-subagent-detection.ts",
      model: "composer-2.5-fast",
    });
    expect(calls[0].isComplete).toBe(false);
  });

  it("session.toolUse updates tasks when duplicate TodoWrite enriches sparse input", () => {
    useThreadStore.getState().handleAgentEvent("thread-1", {
      method: "session.toolUse",
      params: {
        toolCallId: "todo-1",
        toolName: "TodoWrite",
        toolInput: {},
      },
    });
    useThreadStore.getState().handleAgentEvent("thread-1", {
      method: "session.toolUse",
      params: {
        toolCallId: "todo-1",
        toolName: "TodoWrite",
        toolInput: {
          todos: [
            { id: "a", content: "Run mapper tests", status: "in_progress" },
          ],
        },
      },
    });

    const calls = getTestThreadToolCalls("thread-1");
    expect(calls).toHaveLength(1);
    expect(calls[0].toolInput).toEqual({
      todos: [
        { id: "a", content: "Run mapper tests", status: "in_progress" },
      ],
    });
    expect(useTaskStore.getState().tasksByThread["thread-1"]).toEqual([
      {
        id: "a",
        content: "Run mapper tests",
        status: "in_progress",
        group: "Tasks",
      },
    ]);
  });

  it("toolResult fallback does not mark an Agent call complete when it has active children", () => {
    resetThreadStoreForTests({
      records: new Map<string, ThreadRecord>([
        [
          "thread-1",
          {
            ...createEmptyThreadRecord(),
            toolCalls: [
              // Parent Agent call — should NOT be matched by fallback
              { id: "agent-1", toolName: "Agent", toolInput: {}, output: null, isError: false, isComplete: false },
              // Child call with no ID match — this result is for this child
              { id: "child-1", toolName: "Read", toolInput: {}, output: null, isError: false, isComplete: false, parentToolCallId: "agent-1" },
            ],
          },
        ],
      ]),
    });

    useThreadStore.getState().handleAgentEvent("thread-1", {
      method: "session.toolResult",
      params: { toolCallId: "no-match", output: "file contents", isError: false },
    });

    const calls = getTestThreadToolCalls("thread-1");
    const agentCall = calls.find((c) => c.id === "agent-1");
    // The Agent call must NOT be marked complete
    expect(agentCall?.isComplete).toBe(false);
    // Derived count stays at 1 while the Agent row stays incomplete
    expect(countActiveSubagentCalls(getTestThreadToolCalls("thread-1"))).toBe(
      1,
    );
    // The child call MUST be marked complete — fallback resolves to it, not the Agent
    const childCall = calls.find((c) => c.id === "child-1");
    expect(childCall?.isComplete).toBe(true);
    expect(childCall?.output).toBe("file contents");
  });
});

describe("session.modelFallback", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    const thread = createMockThread({ id: "thread-1", model: "claude-opus-4-6" });
    useWorkspaceStore.setState({
      threads: [thread],
      activeWorkspaceId: thread.workspace_id,
      activeThreadId: "thread-1",
      workspaces: [],
    });
    resetThreadStoreForTests({
      currentThreadId: "thread-1",
      runningThreadIds: new Set(["thread-1"]),
      records: new Map<string, ThreadRecord>([
        [
          "thread-1",
          {
            ...createEmptyThreadRecord(),
            messages: [],
            loading: false,
            agentStartTime: Date.now(),
          },
        ],
      ]),
    });
    useToastStore.setState({ toasts: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores transient fallback info without mutating thread.model", () => {
    useThreadStore.getState().handleAgentEvent("thread-1", {
      method: "session.modelFallback",
      params: {
        requestedModel: "claude-opus-4-6",
        actualModel: "claude-sonnet-4-6",
      },
    });

    // thread.model must NOT be changed
    const thread = useWorkspaceStore.getState().threads.find((t) => t.id === "thread-1");
    expect(thread?.model).toBe("claude-opus-4-6");

    // Fallback stored transiently
    const fallback = getTestThreadLastFallback("thread-1");
    expect(fallback).toEqual({
      requestedModel: "claude-opus-4-6",
      actualModel: "claude-sonnet-4-6",
    });
  });

  it("shows an info toast on fallback", () => {
    useThreadStore.getState().handleAgentEvent("thread-1", {
      method: "session.modelFallback",
      params: {
        requestedModel: "claude-opus-4-6",
        actualModel: "claude-sonnet-4-6",
      },
    });

    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].level).toBe("info");
    expect(toasts[0].title).toContain("Sonnet");
  });

  it("normalizes dated SDK variant in transient fallback info", () => {
    useThreadStore.getState().handleAgentEvent("thread-1", {
      method: "session.modelFallback",
      params: {
        requestedModel: "claude-opus-4-6",
        actualModel: "claude-haiku-4-5-20251001",
      },
    });

    // thread.model unchanged
    const thread = useWorkspaceStore.getState().threads.find((t) => t.id === "thread-1");
    expect(thread?.model).toBe("claude-opus-4-6");

    // Fallback normalized
    const fallback = getTestThreadLastFallback("thread-1");
    expect(fallback?.actualModel).toBe("claude-haiku-4-5");
  });

  it("shows human-readable label in toast for dated SDK variant", () => {
    useThreadStore.getState().handleAgentEvent("thread-1", {
      method: "session.modelFallback",
      params: {
        requestedModel: "claude-opus-4-6",
        actualModel: "claude-haiku-4-5-20251001",
      },
    });

    const toasts = useToastStore.getState().toasts;
    expect(toasts[0].title).toContain("Haiku");
    expect(toasts[0].title).not.toContain("20251001");
  });

  it("does not show toast for unknown model IDs (uses raw ID)", () => {
    useThreadStore.getState().handleAgentEvent("thread-1", {
      method: "session.modelFallback",
      params: {
        requestedModel: "claude-unknown-model",
        actualModel: "claude-another-unknown",
      },
    });

    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].title).toContain("claude-another-unknown");
  });
});

describe("subagent count via markPriorToolCallsComplete", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetThreadStoreForTests({
      currentThreadId: "thread-1",
      runningThreadIds: new Set(["thread-1"]),
      records: new Map<string, ThreadRecord>([
        [
          "thread-1",
          {
            ...createEmptyThreadRecord(),
            messages: [],
            toolCalls: [
              { id: "agent-1", toolName: "Agent", toolInput: {}, output: null, isError: false, isComplete: false },
            ],
          },
        ],
      ]),
    });
  });

  afterEach(() => { vi.useRealTimers(); });

  it("does NOT complete an in-flight Agent call when a peer top-level toolUse arrives", () => {
    // A subagent's child tool calls keep arriving on the same thread after a
    // peer top-level event. Completing the parent Agent here would zero the
    // subagent counter and hide the live LiveAgentGroup mid-run.
    useThreadStore.getState().handleAgentEvent("thread-1", {
      method: "session.toolUse",
      params: { toolCallId: "tc2", toolName: "Read", toolInput: {} },
    });
    vi.runAllTimers();

    const calls = getTestThreadToolCalls("thread-1");
    expect(calls.find((c) => c.id === "agent-1")?.isComplete).toBe(false);

    expect(countActiveSubagentCalls(getTestThreadToolCalls("thread-1"))).toBe(
      1,
    );
  });

  it("leaves multiple in-flight Agent calls untouched while sweeping non-Agent peers", () => {
    resetThreadStoreForTests({
      records: new Map<string, ThreadRecord>([
        [
          "thread-1",
          {
            ...createEmptyThreadRecord(),
            toolCalls: [
              { id: "agent-1", toolName: "Agent", toolInput: {}, output: null, isError: false, isComplete: false },
              { id: "agent-2", toolName: "Agent", toolInput: {}, output: null, isError: false, isComplete: false },
              { id: "read-1", toolName: "Read", toolInput: {}, output: null, isError: false, isComplete: false },
            ],
          },
        ],
      ]),
    });

    useThreadStore.getState().handleAgentEvent("thread-1", {
      method: "session.toolUse",
      params: { toolCallId: "tc3", toolName: "Bash", toolInput: {} },
    });
    vi.runAllTimers();

    const calls = getTestThreadToolCalls("thread-1");
    // Both Agent calls remain live
    expect(calls.find((c) => c.id === "agent-1")?.isComplete).toBe(false);
    expect(calls.find((c) => c.id === "agent-2")?.isComplete).toBe(false);
    // The non-Agent peer is swept as expected
    expect(calls.find((c) => c.id === "read-1")?.isComplete).toBe(true);
    expect(countActiveSubagentCalls(getTestThreadToolCalls("thread-1"))).toBe(
      2,
    );
  });
});
