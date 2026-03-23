import { describe, it, expect, beforeEach, vi } from "vitest";
import { useThreadStore } from "@/stores/threadStore";
import { mockTransport } from "./mocks/transport";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

describe("handleAgentEvent branches", () => {
  beforeEach(() => {
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

  it("bridge.crashed clears all running threads and sets error", () => {
    useThreadStore.setState({
      runningThreadIds: new Set(["thread-1", "thread-2"]),
    });

    useThreadStore.getState().handleAgentEvent("thread-1", {
      method: "bridge.crashed",
      params: {},
    });

    const state = useThreadStore.getState();
    expect(state.runningThreadIds.size).toBe(0);
    expect(state.error).toContain("bridge crashed");
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

  it("session.delta appends text to streamingByThread", () => {
    useThreadStore.getState().handleAgentEvent("thread-1", {
      method: "session.delta",
      params: { text: "Hello " },
    });
    useThreadStore.getState().handleAgentEvent("thread-1", {
      method: "session.delta",
      params: { text: "world" },
    });

    expect(useThreadStore.getState().streamingByThread["thread-1"]).toBe("Hello world");
  });

  it("session.turnComplete with streaming content commits message", () => {
    useThreadStore.setState({
      streamingByThread: { "thread-1": "Completed response" },
    });

    useThreadStore.getState().handleAgentEvent("thread-1", {
      method: "session.turnComplete",
      params: { sessionId: "mcode-thread-1", reason: "end_turn", costUsd: 0.01, totalTokensIn: 50, totalTokensOut: 100 },
    });

    const state = useThreadStore.getState();
    expect(state.streamingByThread["thread-1"]).toBeUndefined();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].content).toBe("Completed response");
    expect(state.messages[0].role).toBe("assistant");
    expect(state.messages[0].cost_usd).toBe(0.01);
    expect(state.messages[0].tokens_used).toBe(150);
    expect(state.runningThreadIds.has("thread-1")).toBe(false);
  });

  it("session.turnComplete without streaming content clears state only", () => {
    useThreadStore.getState().handleAgentEvent("thread-1", {
      method: "session.turnComplete",
      params: { sessionId: "mcode-thread-1", reason: "end_turn", costUsd: null, totalTokensIn: 0, totalTokensOut: 0 },
    });

    const state = useThreadStore.getState();
    expect(state.messages).toHaveLength(0);
    expect(state.runningThreadIds.has("thread-1")).toBe(false);
  });

  it("session.toolUse adds tool call to toolCallsByThread", () => {
    useThreadStore.getState().handleAgentEvent("thread-1", {
      method: "session.toolUse",
      params: { toolCallId: "tc1", toolName: "Read", toolInput: { path: "/foo" } },
    });

    const calls = useThreadStore.getState().toolCallsByThread["thread-1"];
    expect(calls).toHaveLength(1);
    expect(calls[0].toolName).toBe("Read");
    expect(calls[0].id).toBe("tc1");
    expect(calls[0].toolInput).toEqual({ path: "/foo" });
    expect(calls[0].isComplete).toBe(false);
  });
});
