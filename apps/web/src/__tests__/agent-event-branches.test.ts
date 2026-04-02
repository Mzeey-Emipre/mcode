import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useThreadStore } from "@/stores/threadStore";
import { mockTransport, createMockThread } from "./mocks/transport";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useToastStore } from "@/stores/toastStore";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

describe("handleAgentEvent branches", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useThreadStore.setState({
      messages: [],
      runningThreadIds: new Set(["thread-1"]),
      loading: false,
      error: null,
      streamingByThread: {},
      toolCallsByThread: {},
      agentStartTimes: { "thread-1": new Date("2026-01-01T00:00:00Z").getTime() },
      currentThreadId: "thread-1",
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
    expect(state.error).toBe("Out of tokens");
  });

  it("session.turnComplete without streaming content clears state only", () => {
    useThreadStore.getState().handleAgentEvent("thread-1", {
      method: "session.turnComplete",
      params: { sessionId: "mcode-thread-1", reason: "end_turn", costUsd: null, totalTokensIn: 0, totalTokensOut: 0 },
    });
    vi.runAllTimers();

    const state = useThreadStore.getState();
    expect(state.messages).toHaveLength(0);
    expect(state.runningThreadIds.has("thread-1")).toBe(false);
  });

  it("session.toolUse adds tool call to toolCallsByThread", () => {
    useThreadStore.getState().handleAgentEvent("thread-1", {
      method: "session.toolUse",
      params: { toolCallId: "tc1", toolName: "Read", toolInput: { path: "/foo" } },
    });
    vi.runAllTimers();

    const calls = useThreadStore.getState().toolCallsByThread["thread-1"];
    expect(calls).toHaveLength(1);
    expect(calls[0].toolName).toBe("Read");
    expect(calls[0].id).toBe("tc1");
    expect(calls[0].toolInput).toEqual({ path: "/foo" });
    expect(calls[0].isComplete).toBe(false);
  });

  it("toolResult fallback does not mark an Agent call complete when it has active children", () => {
    useThreadStore.setState({
      toolCallsByThread: {
        "thread-1": [
          // Parent Agent call — should NOT be matched by fallback
          { id: "agent-1", toolName: "Agent", toolInput: {}, output: null, isError: false, isComplete: false },
          // Child call with no ID match — this result is for this child
          { id: "child-1", toolName: "Read", toolInput: {}, output: null, isError: false, isComplete: false, parentToolCallId: "agent-1" },
        ],
      },
      activeSubagentsByThread: { "thread-1": 1 },
    });

    useThreadStore.getState().handleAgentEvent("thread-1", {
      method: "session.toolResult",
      params: { toolCallId: "no-match", output: "file contents", isError: false },
    });

    const calls = useThreadStore.getState().toolCallsByThread["thread-1"];
    const agentCall = calls.find((c) => c.id === "agent-1");
    // The Agent call must NOT be marked complete
    expect(agentCall?.isComplete).toBe(false);
    // The active subagent count must NOT be decremented
    expect(useThreadStore.getState().activeSubagentsByThread["thread-1"]).toBe(1);
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
      activeThreadId: null,
      workspaces: [],
    });
    useThreadStore.setState({
      messages: [],
      runningThreadIds: new Set(["thread-1"]),
      loading: false,
      error: null,
      streamingByThread: {},
      toolCallsByThread: {},
      agentStartTimes: { "thread-1": Date.now() },
      currentThreadId: "thread-1",
    });
    useToastStore.setState({ toasts: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("updates thread model in workspaceStore to actualModel", () => {
    useThreadStore.getState().handleAgentEvent("thread-1", {
      method: "session.modelFallback",
      params: {
        requestedModel: "claude-opus-4-6",
        actualModel: "claude-sonnet-4-6",
      },
    });

    const thread = useWorkspaceStore.getState().threads.find((t) => t.id === "thread-1");
    expect(thread?.model).toBe("claude-sonnet-4-6");
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
