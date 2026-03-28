import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useThreadStore } from "@/stores/threadStore";
import { mockTransport } from "./mocks/transport";

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
});
