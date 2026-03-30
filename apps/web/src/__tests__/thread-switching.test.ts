import { describe, it, expect, beforeEach, vi } from "vitest";
import { useThreadStore } from "@/stores/threadStore";
import { mockTransport, createMockMessage } from "./mocks/transport";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

describe("Thread Switching", () => {
  beforeEach(() => {
    useThreadStore.setState({
      messages: [],
      runningThreadIds: new Set(),
      loading: false,
      error: null,
      streamingByThread: {},
      toolCallsByThread: {},
      currentThreadId: null,
      persistedToolCallCounts: {},
      serverMessageIds: {},
      toolCallRecordCache: {},
      currentTurnMessageIdByThread: {},
      agentStartTimes: {},
      settingsByThread: {},
      activeSubagentsByThread: {},
    });
    vi.clearAllMocks();
  });

  it("clears stale messages immediately when switching to a non-running thread", async () => {
    // Arrange: Thread A has messages loaded
    const threadAMsg = createMockMessage({
      id: "a-1",
      thread_id: "thread-a",
      content: "Thread A message",
    });
    useThreadStore.setState({
      currentThreadId: "thread-a",
      messages: [threadAMsg],
      persistedToolCallCounts: { "a-1": 2 },
    });

    // Use a deferred promise so we can inspect state mid-flight
    let resolveGetMessages!: (msgs: any[]) => void;
    (mockTransport.getMessages as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveGetMessages = resolve;
      }),
    );

    // Act: switch to Thread B (don't await yet)
    const loadPromise = useThreadStore.getState().loadMessages("thread-b");

    // Assert: messages cleared synchronously BEFORE fetch resolves
    const midState = useThreadStore.getState();
    expect(midState.currentThreadId).toBe("thread-b");
    expect(midState.messages).toEqual([]);
    expect(midState.persistedToolCallCounts).toEqual({});
    expect(midState.loading).toBe(true);

    // Resolve the fetch and let loadMessages complete
    const threadBMsg = createMockMessage({
      id: "b-1",
      thread_id: "thread-b",
      content: "Thread B message",
    });
    resolveGetMessages([threadBMsg]);
    await loadPromise;

    // Final state has Thread B's messages
    const finalState = useThreadStore.getState();
    expect(finalState.messages).toEqual([threadBMsg]);
    expect(finalState.loading).toBe(false);
  });

  it("clears stale messages immediately when switching to a running thread", async () => {
    // Arrange: Thread A has messages, Thread B has a running agent
    const threadAMsg = createMockMessage({
      id: "a-1",
      thread_id: "thread-a",
      content: "Thread A message",
    });
    useThreadStore.setState({
      currentThreadId: "thread-a",
      messages: [threadAMsg],
      persistedToolCallCounts: { "a-1": 1 },
      runningThreadIds: new Set(["thread-b"]),
    });

    let resolveGetMessages!: (msgs: any[]) => void;
    (mockTransport.getMessages as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveGetMessages = resolve;
      }),
    );

    // Act: switch to running Thread B
    const loadPromise = useThreadStore.getState().loadMessages("thread-b");

    // Assert: messages cleared even for a running thread
    const midState = useThreadStore.getState();
    expect(midState.currentThreadId).toBe("thread-b");
    expect(midState.messages).toEqual([]);
    expect(midState.persistedToolCallCounts).toEqual({});
    expect(midState.loading).toBe(true);

    resolveGetMessages([]);
    await loadPromise;
  });

  it("preserves per-thread keyed maps for background threads on switch", async () => {
    // Arrange: Thread A is running with streaming data
    useThreadStore.setState({
      currentThreadId: "thread-a",
      messages: [
        createMockMessage({ id: "a-1", thread_id: "thread-a", content: "hi" }),
      ],
      runningThreadIds: new Set(["thread-a"]),
      streamingByThread: { "thread-a": "partial response..." },
      toolCallsByThread: { "thread-a": [{ id: "tc-1", name: "bash", status: "running" }] },
      serverMessageIds: { "local-1": "server-1" },
    });

    (mockTransport.getMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

    // Act: switch to Thread B
    await useThreadStore.getState().loadMessages("thread-b");

    // Assert: Thread A's per-thread data is intact
    const state = useThreadStore.getState();
    expect(state.streamingByThread["thread-a"]).toBe("partial response...");
    expect(state.toolCallsByThread["thread-a"]).toHaveLength(1);
    expect(state.runningThreadIds.has("thread-a")).toBe(true);
  });

  it("sendMessage for a background thread does not inject into the active thread", async () => {
    // Arrange: user is viewing Thread B
    const threadBMsg = createMockMessage({
      id: "b-1",
      thread_id: "thread-b",
      content: "Thread B message",
    });
    useThreadStore.setState({
      currentThreadId: "thread-b",
      messages: [threadBMsg],
    });

    // Act: sendMessage fires for Thread A (e.g. dequeue timer)
    await useThreadStore.getState().sendMessage(
      "thread-a",
      "queued message for thread A",
    );

    // Assert: Thread B's messages are unchanged — no Thread A content injected
    const state = useThreadStore.getState();
    expect(state.messages).toEqual([threadBMsg]);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].thread_id).toBe("thread-b");
  });

  it("switching back to a thread loads its messages from the database", async () => {
    // Arrange: start on Thread A
    const threadAMsgs = [
      createMockMessage({ id: "a-1", thread_id: "thread-a", content: "first" }),
    ];
    (mockTransport.getMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce(threadAMsgs);
    await useThreadStore.getState().loadMessages("thread-a");
    expect(useThreadStore.getState().messages).toEqual(threadAMsgs);

    // Act: switch to Thread B
    (mockTransport.getMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    await useThreadStore.getState().loadMessages("thread-b");
    expect(useThreadStore.getState().messages).toEqual([]);

    // Act: switch back to Thread A (DB now has an extra message from background agent)
    const updatedThreadAMsgs = [
      createMockMessage({ id: "a-1", thread_id: "thread-a", content: "first" }),
      createMockMessage({ id: "a-2", thread_id: "thread-a", content: "agent replied while away" }),
    ];
    (mockTransport.getMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce(updatedThreadAMsgs);
    await useThreadStore.getState().loadMessages("thread-a");

    // Assert: all messages shown, including those that arrived while viewing Thread B
    const state = useThreadStore.getState();
    expect(state.messages).toEqual(updatedThreadAMsgs);
    expect(state.messages).toHaveLength(2);
    expect(state.currentThreadId).toBe("thread-a");
  });
});
