import type { AgentEvent } from "@mcode/contracts";
import { resetThreadStoreForTests } from "@/stores/thread-store-test-utils";
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getCachedRecord,
  cacheRecord as cacheConversationRecord,
  cachePrefetchedHistoryPage,
  takePrefetchedHistoryPage,
  evictCachedRecord,
  clearRecordCache,
  RECORD_CACHE_SIZE,
  RECORD_MESSAGE_CACHE_SIZE,
  CONVERSATION_MEMORY_BUDGETS,
  applyConversationMemoryPressure,
  getConversationCacheUsage,
  projectConversationCacheState,
  setActiveConversation,
  setConversationTransientTextBytes,
} from "@/features/conversation/hydration/record-cache";
import { createEmptyThreadRecord, type ThreadRecord } from "@/stores/thread-record";
import {
  rememberScrollTop,
  recallScrollPosition,
  recallScrollTop,
  clearScrollMemory,
} from "@/components/chat/scrollPositionMemory";
import { LruCache } from "@/lib/lru-cache";
import { useThreadStore } from "@/stores/threadStore";
import { mockTransport } from "./mocks/transport";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

function makeRecord(id: string): ThreadRecord {
  return {
    ...createEmptyThreadRecord(),
    messages: [
      {
        id: `${id}-msg-1`,
        thread_id: id,
        role: "user",
        content: "hi",
        tool_calls: null,
        files_changed: null,
        cost_usd: null,
        tokens_used: null,
        timestamp: new Date().toISOString(),
        sequence: 1,
        attachments: null,
      },
    ],
    oldestLoadedSequence: 1,
  };
}

function cacheRecord(threadId: string, record: ThreadRecord): void {
  cacheConversationRecord(threadId, projectConversationCacheState(record));
}

describe("recordCache", () => {
  beforeEach(() => {
    clearRecordCache();
    clearScrollMemory();
    setActiveConversation(null);
  });

  it("returns undefined for a thread that was never cached", () => {
    expect(getCachedRecord("missing")).toBeUndefined();
  });

  it("caches and retrieves a record by threadId", () => {
    const rec = makeRecord("t1");
    cacheRecord("t1", rec);
    expect(getCachedRecord("t1")).toEqual(projectConversationCacheState(rec));
  });

  it("stores only explicitly projected conversation fields", () => {
    const rec = {
      ...makeRecord("t1"),
      loading: true,
      streaming: "live response",
      currentTurnMessageId: "turn-1",
    };

    cacheRecord("t1", rec);

    const cached = getCachedRecord("t1");
    expect(cached).not.toHaveProperty("loading");
    expect(cached).not.toHaveProperty("streaming");
    expect(cached).not.toHaveProperty("currentTurnMessageId");
    expect(cached).not.toHaveProperty("goal");
  });

  it("evicts a single thread without affecting others", () => {
    cacheRecord("t1", makeRecord("t1"));
    cacheRecord("t2", makeRecord("t2"));
    evictCachedRecord("t1");
    expect(getCachedRecord("t1")).toBeUndefined();
    expect(getCachedRecord("t2")).toBeDefined();
  });

  it("respects the LRU capacity", () => {
    for (let i = 0; i < RECORD_CACHE_SIZE + 3; i++) {
      cacheRecord(`t${i}`, makeRecord(`t${i}`));
    }
    expect(getCachedRecord("t0")).toBeUndefined();
    expect(getCachedRecord("t1")).toBeUndefined();
    expect(getCachedRecord("t2")).toBeUndefined();
    expect(getCachedRecord(`t${RECORD_CACHE_SIZE + 2}`)).toBeDefined();
  });

  it("refreshes LRU recency on get", () => {
    for (let i = 0; i < RECORD_CACHE_SIZE; i++) {
      cacheRecord(`t${i}`, makeRecord(`t${i}`));
    }
    void getCachedRecord("t0");
    cacheRecord("new", makeRecord("new"));
    expect(getCachedRecord("t0")).toBeDefined();
    expect(getCachedRecord("t1")).toBeUndefined();
  });

  it("clearRecordCache removes everything", () => {
    cacheRecord("t1", makeRecord("t1"));
    clearRecordCache();
    expect(getCachedRecord("t1")).toBeUndefined();
  });

  it("caps cached messages and prunes message-keyed metadata", () => {
    const messages = Array.from({ length: RECORD_MESSAGE_CACHE_SIZE + 20 }, (_, index) => ({
      ...makeRecord("bounded").messages[0],
      id: `message-${index + 1}`,
      sequence: index + 1,
    }));
    const metadata = Object.fromEntries(messages.map((message) => [message.id, 1]));
    const files = Object.fromEntries(messages.map((message) => [message.id, [`${message.id}.ts`]]));
    const responses = Object.fromEntries(messages.map((message) => [message.id, `response-${message.id}`]));

    cacheRecord("bounded", {
      ...createEmptyThreadRecord(),
      messages,
      oldestLoadedSequence: 1,
      hasMoreMessages: false,
      persistedToolCallCounts: metadata,
      persistedFilesChanged: files,
      serverMessageIds: responses,
      assistantResponseKeys: responses,
      narrativeByMessage: Object.fromEntries(messages.map((message) => [message.id, {
        tools: [], thoughts: [], hooks: [],
      }])),
      answeredPlanMessageIds: new Set(messages.map((message) => message.id)),
      latestTurnWithChanges: "message-1",
    });

    const cached = getCachedRecord("bounded");
    expect(cached?.messages).toHaveLength(RECORD_MESSAGE_CACHE_SIZE);
    expect(cached?.messages[0].id).toBe("message-21");
    expect(cached?.oldestLoadedSequence).toBe(21);
    expect(cached?.hasMoreMessages).toBe(true);
    expect(cached?.persistedToolCallCounts["message-1"]).toBeUndefined();
    expect(cached?.persistedToolCallCounts["message-21"]).toBe(1);
    expect(cached?.persistedFilesChanged["message-1"]).toBeUndefined();
    expect(cached?.serverMessageIds["message-1"]).toBeUndefined();
    expect(cached?.assistantResponseKeys["message-1"]).toBeUndefined();
    expect(cached?.narrativeByMessage["message-1"]).toBeUndefined();
    expect(cached?.answeredPlanMessageIds.has("message-1")).toBe(false);
    expect(cached?.latestTurnWithChanges).toBeNull();
  });

  it("keeps a remembered anchor when the message cap trims around it", () => {
    const messages = Array.from({ length: RECORD_MESSAGE_CACHE_SIZE + 1 }, (_, index) => ({
      ...makeRecord("anchor").messages[0],
      id: `anchor-${index + 1}`,
      sequence: index + 1,
    }));
    rememberScrollTop("anchor", 200, false, { messageId: "anchor-1", top: 30 });

    cacheRecord("anchor", {
      ...createEmptyThreadRecord(),
      messages,
      oldestLoadedSequence: 1,
    });

    expect(recallScrollPosition("anchor")?.anchorMessageId).toBe("anchor-1");
    expect(getCachedRecord("anchor")?.messages[0]?.id).toBe("anchor-1");
  });

  it("keeps a remembered anchor that remains inside the message cap", () => {
    const messages = Array.from({ length: RECORD_MESSAGE_CACHE_SIZE + 1 }, (_, index) => ({
      ...makeRecord("anchor").messages[0],
      id: `anchor-${index + 1}`,
      sequence: index + 1,
    }));
    rememberScrollTop("anchor", 200, false, { messageId: "anchor-2", top: 30 });

    cacheRecord("anchor", {
      ...createEmptyThreadRecord(),
      messages,
      oldestLoadedSequence: 1,
    });

    expect(recallScrollPosition("anchor")?.anchorMessageId).toBe("anchor-2");
  });

  it("bounds a record and its prefetched history to one message budget", () => {
    const cachedMessages = Array.from({ length: 40 }, (_, index) => ({
      ...makeRecord("warm").messages[0],
      id: `cached-${index + 61}`,
      sequence: index + 61,
    }));
    const historyMessages = Array.from({ length: 100 }, (_, index) => ({
      ...makeRecord("warm").messages[0],
      id: `history-${index + 1}`,
      sequence: index + 1,
    }));
    cacheRecord("warm", {
      ...createEmptyThreadRecord(),
      messages: cachedMessages,
      oldestLoadedSequence: 61,
    });
    cachePrefetchedHistoryPage("warm", 61, {
      messages: historyMessages,
      hasMore: false,
      answeredPlanMessageIds: historyMessages.map((message) => message.id),
      narrativeByMessage: Object.fromEntries(historyMessages.map((message) => [message.id, {
        tools: [], thoughts: [], hooks: [],
      }])),
    });

    const prefetched = takePrefetchedHistoryPage({
      threadId: "warm",
      cursor: { version: 1, beforeSequence: 61 },
      direction: "older",
      generation: 2,
      conversationRevision: 3,
    });
    expect(prefetched?.messages).toHaveLength(RECORD_MESSAGE_CACHE_SIZE - cachedMessages.length);
    expect(prefetched?.messages[0].id).toBe("history-41");
    expect(prefetched?.hasMore).toBe(true);
    expect(prefetched?.answeredPlanMessageIds?.[0]).toBe("history-41");
    expect(prefetched?.narrativeByMessage["history-1"]).toBeUndefined();
  });

  it("keeps inactive and prefetched residency inside separate byte budgets", () => {
    const content = "x".repeat(1_000_000);
    for (let index = 0; index < 30; index++) {
      const threadId = `inactive-${index}`;
      cacheRecord(threadId, {
        ...makeRecord(threadId),
        messages: [{ ...makeRecord(threadId).messages[0], content }],
      });
      cachePrefetchedHistoryPage(threadId, 2, {
        messages: [{ ...makeRecord(threadId).messages[0], id: `${threadId}-prefetch`, content }],
        hasMore: false,
        narrativeByMessage: {},
      });
    }

    const usage = getConversationCacheUsage();
    expect(usage.inactiveBytes).toBeLessThanOrEqual(CONVERSATION_MEMORY_BUDGETS.inactiveBytes);
    expect(usage.prefetchedBytes).toBeLessThanOrEqual(CONVERSATION_MEMORY_BUDGETS.prefetchedBytes);
  });

  it("keeps retained narrative metadata inside its own byte budget", () => {
    for (let index = 0; index < 8; index++) {
      const threadId = `narrative-${index}`;
      const record = makeRecord(threadId);
      cacheRecord(threadId, {
        ...record,
        narrativeByMessage: {
          [record.messages[0].id]: {
            tools: [{ output: "x".repeat(700_000) }],
            thoughts: [],
            hooks: [],
          } as never,
        },
      });
    }

    expect(getConversationCacheUsage().narrativeBytes).toBeLessThanOrEqual(
      CONVERSATION_MEMORY_BUDGETS.narrativeBytes,
    );
  });

  it("keeps the active cache record inside its total byte budget", () => {
    const record = makeRecord("active-budget");
    setActiveConversation("active-budget");
    cacheRecord("active-budget", {
      ...record,
      messages: Array.from({ length: 10 }, (_, index) => ({
        ...record.messages[0],
        id: `active-budget-${index}`,
        sequence: index + 1,
        content: "x".repeat(1_000_000),
      })),
      narrativeByMessage: {
        "active-budget-9": {
          tools: [{ output: "x".repeat(4_000_000) }],
          thoughts: [],
          hooks: [],
        } as never,
      },
    });

    expect(getConversationCacheUsage().activeBytes).toBeLessThanOrEqual(
      CONVERSATION_MEMORY_BUDGETS.activeBytes,
    );
  });

  it("includes live assistant text in the active byte budget", () => {
    const record = makeRecord("active-stream");
    setActiveConversation("active-stream");
    cacheRecord("active-stream", {
      ...record,
      messages: Array.from({ length: 10 }, (_, index) => ({
        ...record.messages[0],
        id: `active-stream-${index}`,
        sequence: index + 1,
        content: "x".repeat(1_000_000),
      })),
    });
    const messagesBeforeStreaming = getCachedRecord("active-stream")?.messages.length ?? 0;

    setConversationTransientTextBytes("active-stream", 6_000_000);

    expect(getConversationCacheUsage().activeBytes).toBeLessThanOrEqual(
      CONVERSATION_MEMORY_BUDGETS.activeBytes,
    );
    expect(getCachedRecord("active-stream")?.messages.length).toBeLessThan(
      messagesBeforeStreaming,
    );
  });

  it("evicts prefetched and inactive data before trimming the active conversation", () => {
    const content = "x".repeat(1_000_000);
    const activeMessages = Array.from({ length: 10 }, (_, index) => ({
      ...makeRecord("active").messages[0],
      id: `active-${index + 1}`,
      sequence: index + 1,
      content,
    }));
    setActiveConversation("active");
    rememberScrollTop("active", 400, false, { messageId: "active-5", top: 28 });
    cacheRecord("active", {
      ...createEmptyThreadRecord(),
      messages: activeMessages,
      oldestLoadedSequence: 1,
      newestLoadedSequence: 10,
    });
    cacheRecord("inactive", {
      ...makeRecord("inactive"),
      messages: [{ ...makeRecord("inactive").messages[0], content }],
    });
    cachePrefetchedHistoryPage("prefetched", 2, {
      messages: [{ ...makeRecord("prefetched").messages[0], content }],
      hasMore: false,
      narrativeByMessage: {},
    });

    const result = applyConversationMemoryPressure("critical");

    expect(result.evictionOrder.slice(0, 2)).toEqual(["prefetched", "inactive"]);
    expect(result.activeTrimmed).toBe(true);
    expect(getCachedRecord("active")?.messages.some((message) => message.id === "active-5")).toBe(true);
    expect(recallScrollPosition("active")?.anchorMessageId).toBe("active-5");
  });

  it("cleans up scroll memory when evicting via LRU capacity", () => {
    for (let i = 0; i < RECORD_CACHE_SIZE; i++) {
      cacheRecord(`t${i}`, makeRecord(`t${i}`));
      rememberScrollTop(`t${i}`, i * 100);
    }
    expect(recallScrollTop("t0")).toBe(0);
    expect(recallScrollTop(`t${RECORD_CACHE_SIZE - 1}`)).toBe(
      (RECORD_CACHE_SIZE - 1) * 100
    );

    rememberScrollTop("new", 9999);

    cacheRecord("new", makeRecord("new"));

    expect(getCachedRecord("t0")).toBeUndefined();
    expect(recallScrollTop("t0")).toBeUndefined();

    expect(getCachedRecord("t1")).toBeDefined();
    expect(recallScrollTop("t1")).toBe(100);

    expect(recallScrollTop("new")).toBe(9999);
  });

});

describe("selective cache updates in handleAgentEvent", () => {
  const THREAD_ID = "thread-evict-test";

  beforeEach(() => {
    clearRecordCache();
    resetThreadStoreForTests({
      currentThreadId: THREAD_ID,
      runningThreadIds: new Set([THREAD_ID]),
      records: new Map<string, ThreadRecord>([
        [THREAD_ID, { ...createEmptyThreadRecord(), agentStartTime: Date.now() }],
      ]),
    });
  });

  it("streaming textDelta events do NOT evict the cache", () => {
    cacheRecord(THREAD_ID, makeRecord(THREAD_ID));
    expect(getCachedRecord(THREAD_ID)).toBeDefined();

    useThreadStore.getState().handleAgentEvent({ type: "textDelta", threadId: THREAD_ID, delta: "hello " } satisfies AgentEvent);

    expect(getCachedRecord(THREAD_ID)).toBeDefined();
  });

  it("streaming toolUse events do NOT evict the cache", () => {
    cacheRecord(THREAD_ID, makeRecord(THREAD_ID));
    expect(getCachedRecord(THREAD_ID)).toBeDefined();

    useThreadStore.getState().handleAgentEvent({ type: "toolUse", threadId: THREAD_ID, toolCallId: "tool-1", toolName: "Read", toolInput: {} } satisfies AgentEvent);

    expect(getCachedRecord(THREAD_ID)).toBeDefined();
  });

  it("session.turnComplete evicts the cache", () => {
    cacheRecord(THREAD_ID, makeRecord(THREAD_ID));
    expect(getCachedRecord(THREAD_ID)).toBeDefined();

    useThreadStore.getState().handleAgentEvent({ type: "turnComplete", threadId: THREAD_ID, reason: "end_turn", costUsd: null, tokensIn: 0, tokensOut: 0 } satisfies AgentEvent);

    expect(getCachedRecord(THREAD_ID)).toBeUndefined();
  });

  it("session.message synchronizes the cache", () => {
    cacheRecord(THREAD_ID, makeRecord(THREAD_ID));
    expect(getCachedRecord(THREAD_ID)).toBeDefined();

    useThreadStore.getState().handleAgentEvent({ type: "message", threadId: THREAD_ID, content: "done", tokens: null } satisfies AgentEvent);

    expect(getCachedRecord(THREAD_ID)?.messages).toEqual([
      expect.objectContaining({ role: "assistant", content: "done" }),
    ]);
  });

  it("session.error evicts the cache", () => {
    cacheRecord(THREAD_ID, makeRecord(THREAD_ID));
    expect(getCachedRecord(THREAD_ID)).toBeDefined();

    useThreadStore.getState().handleAgentEvent({ type: "error", threadId: THREAD_ID, error: "Something broke" } satisfies AgentEvent);

    expect(getCachedRecord(THREAD_ID)).toBeUndefined();
  });

  it("session.ended evicts the cache", () => {
    cacheRecord(THREAD_ID, makeRecord(THREAD_ID));
    expect(getCachedRecord(THREAD_ID)).toBeDefined();

    useThreadStore.getState().handleAgentEvent({
      type: "ended",
      threadId: THREAD_ID,
      turnExecutionId: "exec-1",
    } satisfies AgentEvent);

    expect(getCachedRecord(THREAD_ID)).toBeUndefined();
  });

  it("many streaming events preserve the cache throughout", () => {
    cacheRecord(THREAD_ID, makeRecord(THREAD_ID));

    const { handleAgentEvent } = useThreadStore.getState();
    for (let i = 0; i < 100; i++) {
      handleAgentEvent({ type: "textDelta", threadId: THREAD_ID, delta: `token-${i} ` } satisfies AgentEvent);
    }

    expect(getCachedRecord(THREAD_ID)).toBeDefined();
  });
});

describe("LruCache.delete", () => {
  it("removes the entry and returns true when present", () => {
    const c = new LruCache<string, number>(3);
    c.set("a", 1);
    expect(c.delete("a")).toBe(true);
    expect(c.get("a")).toBeUndefined();
  });

  it("returns false when key is absent", () => {
    const c = new LruCache<string, number>(3);
    expect(c.delete("missing")).toBe(false);
  });
});
