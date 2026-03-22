import { describe, it, expect, beforeEach, vi } from "vitest";
import { useThreadStore } from "@/stores/threadStore";
import { mockTransport } from "./mocks/transport";

vi.mock("@/transport", () => ({
  getTransport: () => mockTransport,
}));

describe("Streaming Behavior", () => {
  beforeEach(() => {
    useThreadStore.setState({
      messages: [],
      runningThreadIds: new Set(),
      loading: false,
      error: null,
      streamingByThread: {},
      currentThreadId: null,
    });
  });

  it("when an agent streams text, the correct thread shows the content", () => {
    const threadId = "thread-1";
    const { handleAgentEvent } = useThreadStore.getState();

    handleAgentEvent(threadId, {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hello " },
    });
    handleAgentEvent(threadId, {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "world" },
    });

    expect(useThreadStore.getState().streamingByThread[threadId]).toBe(
      "Hello world",
    );
  });

  it("when two agents stream simultaneously, their outputs stay separate", () => {
    const { handleAgentEvent } = useThreadStore.getState();

    handleAgentEvent("thread-a", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Alpha" },
    });
    handleAgentEvent("thread-b", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Beta" },
    });

    const state = useThreadStore.getState();
    expect(state.streamingByThread["thread-a"]).toBe("Alpha");
    expect(state.streamingByThread["thread-b"]).toBe("Beta");
  });

  it("when the agent finishes, streaming content becomes a committed message", () => {
    const threadId = "thread-1";
    // Set this thread as current so the message gets committed to the messages array
    useThreadStore.setState({ currentThreadId: threadId });
    const { handleAgentEvent } = useThreadStore.getState();

    // Stream some content
    handleAgentEvent(threadId, {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Completed response" },
    });

    // Result event commits the message
    handleAgentEvent(threadId, {
      type: "result",
      result: { cost_usd: 0.01, tokens_used: 100, is_error: false },
    });

    const state = useThreadStore.getState();
    expect(state.streamingByThread[threadId]).toBeUndefined();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].content).toBe("Completed response");
    expect(state.messages[0].role).toBe("assistant");
    expect(state.messages[0].cost_usd).toBe(0.01);
  });

  it("when the user switches threads mid-stream, they see the right thread's content", () => {
    const { handleAgentEvent } = useThreadStore.getState();

    // Stream on thread-1
    handleAgentEvent("thread-1", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Thread 1 content" },
    });

    // Switch to thread-2
    useThreadStore.setState({ currentThreadId: "thread-2" });

    // Stream on thread-2
    handleAgentEvent("thread-2", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Thread 2 content" },
    });

    const state = useThreadStore.getState();
    // Each thread has its own content
    expect(state.streamingByThread["thread-1"]).toBe("Thread 1 content");
    expect(state.streamingByThread["thread-2"]).toBe("Thread 2 content");
  });

  it("when agent_finished fires, running state and streaming are cleared", () => {
    const threadId = "thread-1";
    useThreadStore.setState({
      runningThreadIds: new Set([threadId]),
      streamingByThread: { [threadId]: "partial content" },
    });

    useThreadStore.getState().handleAgentEvent(threadId, {
      type: "agent_finished",
    });

    const state = useThreadStore.getState();
    expect(state.runningThreadIds.has(threadId)).toBe(false);
    expect(state.streamingByThread[threadId]).toBeUndefined();
  });

  it("when result fires for a non-current thread, message is not added to the list", () => {
    useThreadStore.setState({
      currentThreadId: "thread-other",
      streamingByThread: { "thread-1": "background response" },
    });

    useThreadStore.getState().handleAgentEvent("thread-1", {
      type: "result",
      result: { cost_usd: 0.005, tokens_used: 50, is_error: false },
    });

    const state = useThreadStore.getState();
    // Streaming content is cleared even for non-current thread
    expect(state.streamingByThread["thread-1"]).toBeUndefined();
    // But message is NOT added since it's not the current thread
    expect(state.messages).toHaveLength(0);
  });
});
