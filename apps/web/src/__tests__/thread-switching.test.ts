import {
  activateTestConversation,
  resetThreadStoreForTests,
  getTestActiveMessages,
  getTestActiveLoading,
  getTestThreadStreaming,
  getTestThreadToolCalls,
  readActiveThreadField,
  readThreadField,
} from "@/stores/thread-store-test-utils";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useThreadStore } from "@/stores/threadStore";
import type { Message } from "@/transport/types";
import { mockTransport, createMockMessage } from "./mocks/transport";
import { clearRecordCache } from "@/features/conversation/hydration/record-cache";
import { createEmptyThreadRecord, patchThreadRecord, type ThreadRecord } from "@/stores/thread-record";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

/** Verifies thread isolation: switching threads must not leak messages across views. */
describe("Thread Switching", () => {
  beforeEach(() => {
    clearRecordCache();
    resetThreadStoreForTests({
      currentThreadId: null,
      runningThreadIds: new Set(),
    });
    vi.clearAllMocks();
  });

  it("keeps outgoing messages out of the target while switching to a non-running thread", async () => {
    // Arrange: Thread A has messages loaded
    const threadAMsg = createMockMessage({
      id: "a-1",
      thread_id: "thread-a",
      content: "Thread A message",
    });
    resetThreadStoreForTests({
      currentThreadId: "thread-a",
      records: new Map<string, ThreadRecord>([
        [
          "thread-a",
          {
            ...createEmptyThreadRecord(),
            messages: [threadAMsg],
            persistedToolCallCounts: { "a-1": 2 },
          },
        ],
      ]),
    });

    // Use a deferred promise so we can inspect state mid-flight
    let resolveGetMessages!: (result: { messages: Message[]; hasMore: boolean }) => void;
    (mockTransport.getMessages as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveGetMessages = resolve;
      }),
    );

    // Act: switch to Thread B (don't await yet)
const loadPromise = activateTestConversation("thread-b");

    // Assert: target record owns the surface; outgoing messages never leak.
    const midState = useThreadStore.getState();
    expect(midState.currentThreadId).toBe("thread-b");
    expect(getTestActiveMessages()).toEqual([]);
    expect(readActiveThreadField((r) => r.persistedToolCallCounts) ?? {}).toEqual({});
    expect(getTestActiveLoading()).toBe(true);

    // Resolve the fetch and let loadMessages complete
    const threadBMsg = createMockMessage({
      id: "b-1",
      thread_id: "thread-b",
      content: "Thread B message",
    });
    resolveGetMessages({ messages: [threadBMsg], hasMore: false });
    await loadPromise;

    // Final state has Thread B's messages
    expect(getTestActiveMessages()).toEqual([threadBMsg]);
    expect(getTestActiveLoading()).toBe(false);
  });

  it("keeps outgoing messages out of the target while switching to a running thread", async () => {
    // Arrange: Thread A has messages, Thread B has a running agent
    const threadAMsg = createMockMessage({
      id: "a-1",
      thread_id: "thread-a",
      content: "Thread A message",
    });
    resetThreadStoreForTests({
      currentThreadId: "thread-a",
      runningThreadIds: new Set(["thread-b"]),
      records: new Map<string, ThreadRecord>([
        [
          "thread-a",
          {
            ...createEmptyThreadRecord(),
            messages: [threadAMsg],
            persistedToolCallCounts: { "a-1": 1 },
          },
        ],
      ]),
    });

    let resolveGetMessages!: (result: { messages: Message[]; hasMore: boolean }) => void;
    (mockTransport.getMessages as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveGetMessages = resolve;
      }),
    );

    // Act: switch to running Thread B
    const loadPromise = activateTestConversation("thread-b");

    // Assert: target record owns the surface; outgoing messages never leak.
    const midState = useThreadStore.getState();
    expect(midState.currentThreadId).toBe("thread-b");
    expect(getTestActiveMessages()).toEqual([]);
    expect(readActiveThreadField((r) => r.persistedToolCallCounts) ?? {}).toEqual({});
    expect(getTestActiveLoading()).toBe(true);

    resolveGetMessages({ messages: [], hasMore: false });
    await loadPromise;
  });

  it("preserves per-thread keyed maps for background threads on switch", async () => {
    // Arrange: Thread A is running with streaming data
    resetThreadStoreForTests({
      currentThreadId: "thread-a",
      runningThreadIds: new Set(["thread-a"]),
      records: new Map<string, ThreadRecord>([
        [
          "thread-a",
          {
            ...createEmptyThreadRecord(),
            runtimePhase: "running",
            turnExecutionId: "exec-thread-a",
            messages: [
              createMockMessage({ id: "a-1", thread_id: "thread-a", content: "hi" }),
            ],
            streaming: "partial response...",
            toolCalls: [
              { id: "tc-1", toolName: "bash", toolInput: {}, output: null, isError: false, isComplete: false },
            ],
            serverMessageIds: { "local-1": "server-1" },
          },
        ],
      ]),
    });

    (mockTransport.getMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ messages: [], hasMore: false });

    // Act: switch to Thread B
    await activateTestConversation("thread-b");

    // Assert: Thread A's per-thread data is intact
    const state = useThreadStore.getState();
    expect(getTestThreadStreaming("thread-a")).toBe("partial response...");
    expect(getTestThreadToolCalls("thread-a")).toHaveLength(1);
    expect(state.runningThreadIds.has("thread-a")).toBe(true);
    expect(readThreadField("thread-a", (r) => r.serverMessageIds)).toEqual({ "local-1": "server-1" });
  });

  it("sendMessage for a background thread does not inject into the active thread", async () => {
    // Arrange: user is viewing Thread B
    const threadBMsg = createMockMessage({
      id: "b-1",
      thread_id: "thread-b",
      content: "Thread B message",
    });
    useThreadStore.setState((s) => ({
      currentThreadId: "thread-b",
      records: patchThreadRecord(s.records, "thread-b", { messages: [threadBMsg] }),
    }));

    // Act: sendMessage fires for Thread A (e.g. dequeue timer)
    await useThreadStore.getState().sendMessage(
      "thread-a",
      "queued message for thread A",
    );

    // Assert: Thread B's messages are unchanged — no Thread A content injected
    expect(getTestActiveMessages()).toEqual([threadBMsg]);
  });

  it("switching back to a thread loads its messages from the database", async () => {
    // Arrange: start on Thread A
    const threadAMsgs = [
      createMockMessage({ id: "a-1", thread_id: "thread-a", content: "first" }),
    ];
    (mockTransport.getMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ messages: threadAMsgs, hasMore: false });
    await activateTestConversation("thread-a");
    expect(getTestActiveMessages()).toEqual(threadAMsgs);

    // Act: switch to Thread B
    (mockTransport.getMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ messages: [], hasMore: false });
    await activateTestConversation("thread-b");
    expect(getTestActiveMessages()).toEqual([]);

    // Simulate: background agent adds a message to Thread A (push event would evict cache)
    clearRecordCache();

    // Act: switch back to Thread A (DB now has an extra message from background agent)
    const updatedThreadAMsgs = [
      createMockMessage({ id: "a-1", thread_id: "thread-a", content: "first" }),
      createMockMessage({ id: "a-2", thread_id: "thread-a", content: "agent replied while away" }),
    ];
    (mockTransport.getMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ messages: updatedThreadAMsgs, hasMore: false });
    await activateTestConversation("thread-a");

    // Assert: all messages shown, including those that arrived while viewing Thread B
    const state = useThreadStore.getState();
    expect(getTestActiveMessages()).toEqual(updatedThreadAMsgs);
    expect(state.currentThreadId).toBe("thread-a");
  });
});
