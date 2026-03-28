import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useThreadStore } from "@/stores/threadStore";
import { mockTransport } from "./mocks/transport";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

describe("Tool Call Matching", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useThreadStore.setState({
      messages: [],
      runningThreadIds: new Set(),
      loading: false,
      error: null,
      streamingByThread: {},
      toolCallsByThread: {},
      agentStartTimes: {},
      currentThreadId: "thread-1",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("tool result with matching ID completes the correct tool call", () => {
    // Set up two pending tool calls
    useThreadStore.setState({
      toolCallsByThread: {
        "thread-1": [
          { id: "tc1", toolName: "Read", toolInput: {}, output: null, isError: false, isComplete: false },
          { id: "tc2", toolName: "Write", toolInput: {}, output: null, isError: false, isComplete: false },
        ],
      },
    });

    useThreadStore.getState().handleAgentEvent("thread-1", {
      method: "session.toolResult",
      params: { toolCallId: "tc2", output: "done", isError: false },
    });
    vi.runAllTimers();

    const calls = useThreadStore.getState().toolCallsByThread["thread-1"];
    expect(calls[0].isComplete).toBe(false); // tc1 untouched
    expect(calls[1].isComplete).toBe(true);
    expect(calls[1].output).toBe("done");
  });

  it("tool result with non-matching ID falls back to first incomplete", () => {
    useThreadStore.setState({
      toolCallsByThread: {
        "thread-1": [
          { id: "tc1", toolName: "Read", toolInput: {}, output: null, isError: false, isComplete: false },
          { id: "tc2", toolName: "Write", toolInput: {}, output: null, isError: false, isComplete: false },
        ],
      },
    });

    useThreadStore.getState().handleAgentEvent("thread-1", {
      method: "session.toolResult",
      params: { toolCallId: "unknown-id", output: "result", isError: false },
    });
    vi.runAllTimers();

    const calls = useThreadStore.getState().toolCallsByThread["thread-1"];
    expect(calls[0].isComplete).toBe(true);
    expect(calls[0].output).toBe("result");
    // Second incomplete call should be untouched
    expect(calls[1].isComplete).toBe(false);
    expect(calls[1].output).toBeNull();
  });

  it("multiple concurrent tool calls resolve independently by ID", () => {
    useThreadStore.setState({
      toolCallsByThread: {
        "thread-1": [
          { id: "tc1", toolName: "Read", toolInput: {}, output: null, isError: false, isComplete: false },
          { id: "tc2", toolName: "Write", toolInput: {}, output: null, isError: false, isComplete: false },
          { id: "tc3", toolName: "Bash", toolInput: {}, output: null, isError: false, isComplete: false },
        ],
      },
    });

    // Resolve out of order
    useThreadStore.getState().handleAgentEvent("thread-1", {
      method: "session.toolResult",
      params: { toolCallId: "tc3", output: "third", isError: false },
    });
    useThreadStore.getState().handleAgentEvent("thread-1", {
      method: "session.toolResult",
      params: { toolCallId: "tc1", output: "first", isError: false },
    });
    vi.runAllTimers();

    const calls = useThreadStore.getState().toolCallsByThread["thread-1"];
    expect(calls[0].output).toBe("first");
    expect(calls[1].isComplete).toBe(false);
    expect(calls[2].output).toBe("third");
  });

  it("all tool calls already complete: fallback does nothing", () => {
    useThreadStore.setState({
      toolCallsByThread: {
        "thread-1": [
          { id: "tc1", toolName: "Read", toolInput: {}, output: "done", isError: false, isComplete: true },
        ],
      },
    });

    useThreadStore.getState().handleAgentEvent("thread-1", {
      method: "session.toolResult",
      params: { toolCallId: "unknown", output: "extra", isError: false },
    });
    vi.runAllTimers();

    const calls = useThreadStore.getState().toolCallsByThread["thread-1"];
    // Original output preserved
    expect(calls[0].output).toBe("done");
  });

  it("out-of-order results don't overwrite completed calls", () => {
    useThreadStore.setState({
      toolCallsByThread: {
        "thread-1": [
          { id: "tc1", toolName: "Read", toolInput: {}, output: "first-result", isError: false, isComplete: true },
          { id: "tc2", toolName: "Write", toolInput: {}, output: null, isError: false, isComplete: false },
        ],
      },
    });

    useThreadStore.getState().handleAgentEvent("thread-1", {
      method: "session.toolResult",
      params: { toolCallId: "tc2", output: "second-result", isError: false },
    });
    vi.runAllTimers();

    const calls = useThreadStore.getState().toolCallsByThread["thread-1"];
    expect(calls[0].output).toBe("first-result"); // preserved
    expect(calls[1].output).toBe("second-result"); // newly completed
  });
});
