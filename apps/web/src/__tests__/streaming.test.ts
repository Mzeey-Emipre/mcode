import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useThreadStore } from "@/stores/threadStore";
import { mockTransport } from "./mocks/transport";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

describe("Agent Message Flow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useThreadStore.setState({
      messages: [],
      runningThreadIds: new Set(),
      loading: false,
      error: null,
      streamingByThread: {},
      currentThreadId: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("session.message adds an assistant message to the current thread", () => {
    const threadId = "thread-1";
    useThreadStore.setState({ currentThreadId: threadId });
    const { handleAgentEvent } = useThreadStore.getState();

    handleAgentEvent(threadId, {
      method: "session.message",
      params: { content: "Hello world", tokens: 42 },
    });
    vi.runAllTimers();

    const state = useThreadStore.getState();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].content).toBe("Hello world");
    expect(state.messages[0].role).toBe("assistant");
    expect(state.messages[0].tokens_used).toBe(42);
  });

  it("session.message only appends when threadId matches currentThreadId", () => {
    useThreadStore.setState({ currentThreadId: "thread-a" });
    const { handleAgentEvent } = useThreadStore.getState();

    // Message for current thread is added
    handleAgentEvent("thread-a", {
      method: "session.message",
      params: { content: "Alpha" },
    });
    vi.runAllTimers();
    expect(useThreadStore.getState().messages).toHaveLength(1);

    // Message for a different thread is NOT added to the visible list
    handleAgentEvent("thread-b", {
      method: "session.message",
      params: { content: "Beta" },
    });
    vi.runAllTimers();
    expect(useThreadStore.getState().messages).toHaveLength(1);
    expect(useThreadStore.getState().messages[0].content).toBe("Alpha");
  });

  it("when session.ended fires, running state and streaming are cleared", () => {
    const threadId = "thread-1";
    useThreadStore.setState({
      runningThreadIds: new Set([threadId]),
      streamingByThread: { [threadId]: "partial content" },
    });

    useThreadStore.getState().handleAgentEvent(threadId, {
      method: "session.ended",
    });
    vi.runAllTimers();

    const state = useThreadStore.getState();
    expect(state.runningThreadIds.has(threadId)).toBe(false);
    expect(state.streamingByThread[threadId]).toBeUndefined();
  });

  it("turnComplete without streaming content clears running state", () => {
    const threadId = "thread-1";
    useThreadStore.setState({
      runningThreadIds: new Set([threadId]),
      currentThreadId: threadId,
    });

    useThreadStore.getState().handleAgentEvent(threadId, {
      method: "session.turnComplete",
      params: { costUsd: 0.01, tokensIn: 50, tokensOut: 50 },
    });
    vi.runAllTimers();

    const state = useThreadStore.getState();
    expect(state.runningThreadIds.has(threadId)).toBe(false);
  });

  it("when turnComplete fires for a non-current thread, message is not added to the list", () => {
    useThreadStore.setState({
      currentThreadId: "thread-other",
      streamingByThread: { "thread-1": "background response" },
    });

    useThreadStore.getState().handleAgentEvent("thread-1", {
      method: "session.turnComplete",
      costUsd: 0.005,
      tokensIn: 25,
      tokensOut: 25,
    });
    vi.runAllTimers();

    const state = useThreadStore.getState();
    // Streaming content is cleared even for non-current thread
    expect(state.streamingByThread["thread-1"]).toBeUndefined();
    // But message is NOT added since it's not the current thread
    expect(state.messages).toHaveLength(0);
  });
});

describe("duplicate message prevention", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useThreadStore.setState({
      messages: [],
      runningThreadIds: new Set(["thread-1"]),
      loading: false,
      error: null,
      streamingByThread: { "thread-1": "Hello world" },
      streamingPreviewByThread: { "thread-1": "Hello world" },
      toolCallsByThread: {},
      agentStartTimes: { "thread-1": Date.now() },
      activeSubagentsByThread: {},
      currentThreadId: "thread-1",
    });
  });

  afterEach(() => { vi.useRealTimers(); });

  it("session.message clears streamingByThread so turnComplete does not duplicate", () => {
    const { handleAgentEvent } = useThreadStore.getState();

    // session.message arrives with the final content
    handleAgentEvent("thread-1", {
      method: "session.message",
      params: { content: "Hello world", tokens: 10 },
    });
    vi.runAllTimers();

    // Both streaming fields must be cleared
    expect(useThreadStore.getState().streamingByThread["thread-1"]).toBeUndefined();
    expect(useThreadStore.getState().streamingPreviewByThread["thread-1"]).toBeUndefined();

    // Now turnComplete fires — should NOT create a second message
    handleAgentEvent("thread-1", {
      method: "session.turnComplete",
      params: { costUsd: 0.01, tokensIn: 50, tokensOut: 50 },
    });
    vi.runAllTimers();

    const messages = useThreadStore.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("Hello world");
  });
});

describe("session.textDelta", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useThreadStore.setState({
      messages: [],
      runningThreadIds: new Set(["thread-1"]),
      loading: false,
      error: null,
      streamingByThread: {},
      toolCallsByThread: {},
      agentStartTimes: {},
      currentThreadId: "thread-1",
    });
  });

  afterEach(() => { vi.useRealTimers(); });

  it("appends delta to streamingByThread", () => {
    const { handleAgentEvent } = useThreadStore.getState();
    handleAgentEvent("thread-1", { method: "session.textDelta", params: { delta: "Hello" } });
    handleAgentEvent("thread-1", { method: "session.textDelta", params: { delta: " world" } });

    expect(useThreadStore.getState().streamingByThread["thread-1"]).toBe("Hello world");
  });

  it("stores full text in streamingByThread and truncated preview in streamingPreviewByThread", () => {
    const longText = "x".repeat(250);
    useThreadStore.setState({ streamingByThread: { "thread-1": longText } });
    const { handleAgentEvent } = useThreadStore.getState();

    handleAgentEvent("thread-1", { method: "session.textDelta", params: { delta: "end" } });

    const state = useThreadStore.getState();
    // Full buffer is preserved
    expect(state.streamingByThread["thread-1"]).toBe(longText + "end");
    expect(state.streamingByThread["thread-1"].length).toBe(253);
    // Preview is truncated to last 200 chars
    const preview = state.streamingPreviewByThread["thread-1"];
    expect(preview.length).toBe(200);
    expect(preview.endsWith("end")).toBe(true);
  });

  it("marks prior tool calls complete on first textDelta", () => {
    useThreadStore.setState({
      toolCallsByThread: {
        "thread-1": [
          { id: "tc-1", toolName: "Read", toolInput: {}, output: null, isError: false, isComplete: false },
        ],
      },
    });
    const { handleAgentEvent } = useThreadStore.getState();
    handleAgentEvent("thread-1", { method: "session.textDelta", params: { delta: "Hi" } });

    const calls = useThreadStore.getState().toolCallsByThread["thread-1"];
    expect(calls[0].isComplete).toBe(true);
  });

  it("does not affect other threads", () => {
    const { handleAgentEvent } = useThreadStore.getState();
    handleAgentEvent("thread-1", { method: "session.textDelta", params: { delta: "ping" } });

    expect(useThreadStore.getState().streamingByThread["thread-2"]).toBeUndefined();
  });
});

describe("session.toolProgress", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useThreadStore.setState({
      messages: [],
      runningThreadIds: new Set(["thread-1"]),
      loading: false,
      error: null,
      streamingByThread: {},
      toolCallsByThread: {
        "thread-1": [
          { id: "tc1", toolName: "Bash", toolInput: {}, output: null, isError: false, isComplete: false },
        ],
      },
      agentStartTimes: {},
      currentThreadId: "thread-1",
    });
  });

  afterEach(() => { vi.useRealTimers(); });

  it("updates elapsedSeconds on the matching tool call", () => {
    const { handleAgentEvent } = useThreadStore.getState();
    handleAgentEvent("thread-1", {
      method: "session.toolProgress",
      params: { toolCallId: "tc1", toolName: "Bash", elapsedSeconds: 5 },
    });

    const calls = useThreadStore.getState().toolCallsByThread["thread-1"];
    expect(calls[0].elapsedSeconds).toBe(5);
  });

  it("ignores toolProgress for unknown toolCallId", () => {
    const { handleAgentEvent } = useThreadStore.getState();
    handleAgentEvent("thread-1", {
      method: "session.toolProgress",
      params: { toolCallId: "unknown", toolName: "Bash", elapsedSeconds: 3 },
    });

    const calls = useThreadStore.getState().toolCallsByThread["thread-1"];
    expect(calls[0].elapsedSeconds).toBeUndefined();
  });
});
