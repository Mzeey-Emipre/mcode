import type { AgentEvent } from "@mcode/contracts";
import {
  activateTestConversation,
  resetThreadStoreForTests,
  getTestActiveMessages,
} from "@/stores/thread-store-test-utils";
import {
  createEmptyThreadRecord,
  patchThreadRecord,
  type ThreadRecord,
} from "@/stores/thread-record";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useThreadStore, MESSAGE_FETCH_SIZE } from "@/stores/threadStore";
import { getThreadRecord } from "@/stores/thread-record";
import { clearRecordCache, getCachedRecord } from "@/features/conversation/hydration/record-cache";
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
await activateTestConversation("t1");

    expect(mockTransport.loadConversationPage).toHaveBeenCalledWith("t1", MESSAGE_FETCH_SIZE);
    expect(mockTransport.getMessages).not.toHaveBeenCalled();
    expect(getTestActiveMessages()).toEqual(fakeMessages);
    expect(getCachedRecord("t1")).toBeDefined();
    expect(getCachedRecord("t1")?.messages).toEqual(fakeMessages);
  });

  it("on cache hit, does not call conversation.page and renders from cache", async () => {
    // First load primes the cache
    await activateTestConversation("t1");
    expect(mockTransport.loadConversationPage).toHaveBeenCalledTimes(1);

    // Switch away
    useThreadStore.setState((s) => ({
      currentThreadId: "t2",
      records: patchThreadRecord(s.records, "t2", { messages: [] }),
    }));

    // Switch back -- should hit cache
    await activateTestConversation("t1");
    expect(mockTransport.loadConversationPage).toHaveBeenCalledTimes(1); // unchanged
    expect(getTestActiveMessages()).toEqual(fakeMessages);
    expect(useThreadStore.getState().currentThreadId).toBe("t1");
  });

  it("appends an optimistic user message after a restored high-sequence cache tail", async () => {
    const cachedTail = [
      createMockMessage({ id: "m99", thread_id: "t1", sequence: 99 }),
      createMockMessage({ id: "m100", thread_id: "t1", sequence: 100 }),
    ];
    (mockTransport.loadConversationPage as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: cachedTail,
      hasMore: true,
      narrativeByMessage: {},
    });

    await activateTestConversation("t1");
    useThreadStore.setState((s) => ({
      currentThreadId: "t2",
      records: patchThreadRecord(s.records, "t2", { messages: [] }),
    }));
    await activateTestConversation("t1");

    await useThreadStore.getState().sendMessage("t1", "new user message");

    const messages = getTestActiveMessages();
    expect(messages.map((message) => message.sequence)).toEqual([99, 100, 101]);
    expect(messages.at(-1)?.content).toBe("new user message");
  });

  it("starts optimistic messages at sequence one for an empty record", async () => {
    useThreadStore.setState((s) => ({
      currentThreadId: "t1",
      records: patchThreadRecord(s.records, "t1", { messages: [] }),
    }));

    await useThreadStore.getState().sendMessage("t1", "first user message");

    expect(getTestActiveMessages().at(-1)?.sequence).toBe(1);
  });

  it("sends the optimistic user message ID to the agent transport", async () => {
    const threadId = "t1";
    resetThreadStoreForTests({
      currentThreadId: threadId,
      records: new Map<string, ThreadRecord>([
        [threadId, createEmptyThreadRecord()],
      ]),
    });

    await useThreadStore.getState().sendMessage(threadId, "follow-up");

    const optimisticMessage = getTestActiveMessages().at(-1);
    const sendPayload = vi.mocked(mockTransport.sendMessage).mock.calls.at(-1)?.[0];
    expect(optimisticMessage?.role).toBe("user");
    expect(sendPayload?.messageId).toBe(optimisticMessage?.id);
  });

  it("does NOT clear toolCallRecordCache on cache hit", async () => {
    await activateTestConversation("t1");
    useThreadStore.getState().cacheToolCallRecords("t1:m1", [
      { id: "tc1", name: "Read", args: {}, result: "ok", at_ms: 0 } as never,
    ]);
    useThreadStore.setState((s) => ({
      currentThreadId: "t2",
      records: patchThreadRecord(s.records, "t2", { messages: [] }),
    }));

    await activateTestConversation("t1");
    expect(useThreadStore.getState().getCachedToolCallRecords("t1:m1")).not.toBeNull();
  });

  it("never sets messages to [] when serving from cache (no blank flash)", async () => {
    await activateTestConversation("t1");
    useThreadStore.setState((s) => ({
      currentThreadId: "t2",
      records: patchThreadRecord(s.records, "t2", { messages: [] }),
    }));

    const snapshots: typeof fakeMessages[] = [];
    const unsub = useThreadStore.subscribe((s) => {
      const id = s.currentThreadId;
      snapshots.push(id ? getThreadRecord(s.records, id).messages : []);
    });

    await activateTestConversation("t1");
    unsub();

    // Verify state updates were observed (not just an empty array)
    expect(snapshots.length).toBeGreaterThan(0);
    // Every observed messages array should be non-empty for thread t1.
    expect(snapshots.every((m) => m.length > 0)).toBe(true);
  });
});

describe("loadMessages cache synchronization", () => {
  beforeEach(() => {
    resetThreadStoreTestState();
  });

  it("synchronizes a live message into the cache", async () => {
    await activateTestConversation("t1");
    expect(getCachedRecord("t1")).toBeDefined();

    useThreadStore.getState().handleAgentEvent({ type: "message", threadId: "t1", content: "x", tokens: null } satisfies AgentEvent);
    expect(getCachedRecord("t1")?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "m1", content: "hello" }),
      expect.objectContaining({ role: "assistant", content: "x" }),
    ]));
  });

  it("evicts when handleTurnPersisted fires", async () => {
    await activateTestConversation("t1");
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
    await activateTestConversation("t1");
    expect(getCachedRecord("t1")).toBeDefined();

    useThreadStore.getState().clearThreadState("t1");
    expect(getCachedRecord("t1")).toBeUndefined();
  });

  it("evicts all listed threads on clearThreadStateMany", async () => {
    await activateTestConversation("t1");
    await activateTestConversation("t2");
    expect(getCachedRecord("t1")).toBeDefined();
    expect(getCachedRecord("t2")).toBeDefined();

    useThreadStore.getState().clearThreadStateMany(["t1", "t2"]);
    expect(getCachedRecord("t1")).toBeUndefined();
    expect(getCachedRecord("t2")).toBeUndefined();
  });
});
