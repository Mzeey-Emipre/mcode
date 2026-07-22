import type { AgentEvent } from "@mcode/contracts";
import {
  resetThreadStoreForTests,
  getTestActiveMessages,
} from "@/stores/thread-store-test-utils";
import {
  patchThreadRecord,
  type ThreadRecord,
} from "@/stores/thread-record";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useThreadStore, MESSAGE_FETCH_SIZE } from "@/stores/threadStore";
import { getThreadRecord } from "@/stores/thread-record";
import { clearRecordCache, getCachedRecord } from "@/lib/thread-hydrator/record-cache";
import { mockTransport, createMockMessage } from "./mocks/transport";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

const fakeMessages = [
  createMockMessage({
    id: "m1",
    thread_id: "t1",
    content: "hello",
  }),
];

/**
 * Reset thread store and message cache to a clean state for tests.
 * Sets up mocked transport and properly-typed initial state.
 * Clears all ThreadState fields to prevent state leakage between tests.
 */
function resetThreadStoreTestState() {
  clearRecordCache();
  vi.clearAllMocks();
  (mockTransport.getMessages as ReturnType<typeof vi.fn>).mockResolvedValue({ messages: fakeMessages, hasMore: false });
  (mockTransport.loadConversationPage as ReturnType<typeof vi.fn>).mockResolvedValue({
    messages: fakeMessages,
    hasMore: false,
    narrativeByMessage: {},
  });
  resetThreadStoreForTests({
    currentThreadId: null,
    runningThreadIds: new Set<string>(),
    records: new Map<string, ThreadRecord>(),
  });
}

describe("loadMessages cache integration", () => {
  beforeEach(() => {
    resetThreadStoreTestState();
  });

  it("calls conversation.page on first load (cache miss) and populates cache", async () => {
    await useThreadStore.getState().loadMessages("t1");

    expect(mockTransport.loadConversationPage).toHaveBeenCalledWith("t1", MESSAGE_FETCH_SIZE);
    expect(mockTransport.getMessages).not.toHaveBeenCalled();
    expect(getTestActiveMessages()).toEqual(fakeMessages);
    expect(getCachedRecord("t1")).toBeDefined();
    expect(getCachedRecord("t1")?.messages).toEqual(fakeMessages);
  });

  it("on cache hit, does not call conversation.page and renders from cache", async () => {
    // First load primes the cache
    await useThreadStore.getState().loadMessages("t1");
    expect(mockTransport.loadConversationPage).toHaveBeenCalledTimes(1);

    // Switch away
    useThreadStore.setState((s) => ({
      currentThreadId: "t2",
      records: patchThreadRecord(s.records, "t2", { messages: [] }),
    }));

    // Switch back -- should hit cache
    await useThreadStore.getState().loadMessages("t1");
    expect(mockTransport.loadConversationPage).toHaveBeenCalledTimes(1); // unchanged
    expect(getTestActiveMessages()).toEqual(fakeMessages);
    expect(useThreadStore.getState().currentThreadId).toBe("t1");
  });

  it("does NOT clear toolCallRecordCache on cache hit", async () => {
    await useThreadStore.getState().loadMessages("t1");
    useThreadStore.getState().cacheToolCallRecords("t1:m1", [
      { id: "tc1", name: "Read", args: {}, result: "ok", at_ms: 0 } as never,
    ]);
    useThreadStore.setState((s) => ({
      currentThreadId: "t2",
      records: patchThreadRecord(s.records, "t2", { messages: [] }),
    }));

    await useThreadStore.getState().loadMessages("t1");
    expect(useThreadStore.getState().getCachedToolCallRecords("t1:m1")).not.toBeNull();
  });

  it("never sets messages to [] when serving from cache (no blank flash)", async () => {
    await useThreadStore.getState().loadMessages("t1");
    useThreadStore.setState((s) => ({
      currentThreadId: "t2",
      records: patchThreadRecord(s.records, "t2", { messages: [] }),
    }));

    const snapshots: typeof fakeMessages[] = [];
    const unsub = useThreadStore.subscribe((s) => {
      const id = s.currentThreadId;
      snapshots.push(id ? getThreadRecord(s.records, id).messages : []);
    });

    await useThreadStore.getState().loadMessages("t1");
    unsub();

    // Verify state updates were observed (not just an empty array)
    expect(snapshots.length).toBeGreaterThan(0);
    // Every observed messages array should be non-empty for thread t1.
    expect(snapshots.every((m) => m.length > 0)).toBe(true);
  });
});

describe("loadMessages cache eviction", () => {
  beforeEach(() => {
    resetThreadStoreTestState();
  });

  it("evicts when handleAgentEvent fires for the thread", async () => {
    await useThreadStore.getState().loadMessages("t1");
    expect(getCachedRecord("t1")).toBeDefined();

    useThreadStore.getState().handleAgentEvent({ type: "message", threadId: "t1", content: "x" } as AgentEvent);
    expect(getCachedRecord("t1")).toBeUndefined();
  });

  it("evicts when handleTurnPersisted fires", async () => {
    await useThreadStore.getState().loadMessages("t1");
    expect(getCachedRecord("t1")).toBeDefined();

    useThreadStore.getState().handleTurnPersisted({
      threadId: "t1",
      messageId: "m1",
      toolCallCount: 0,
      filesChanged: [],
    });
    expect(getCachedRecord("t1")).toBeUndefined();
  });

  it("evicts on clearThreadState", async () => {
    await useThreadStore.getState().loadMessages("t1");
    expect(getCachedRecord("t1")).toBeDefined();

    useThreadStore.getState().clearThreadState("t1");
    expect(getCachedRecord("t1")).toBeUndefined();
  });

  it("evicts all listed threads on clearThreadStateMany", async () => {
    await useThreadStore.getState().loadMessages("t1");
    await useThreadStore.getState().loadMessages("t2");
    expect(getCachedRecord("t1")).toBeDefined();
    expect(getCachedRecord("t2")).toBeDefined();

    useThreadStore.getState().clearThreadStateMany(["t1", "t2"]);
    expect(getCachedRecord("t1")).toBeUndefined();
    expect(getCachedRecord("t2")).toBeUndefined();
  });
});
