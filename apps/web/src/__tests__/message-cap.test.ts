import { describe, it, expect, beforeEach, vi } from "vitest";
import { useThreadStore } from "@/stores/threadStore";
import { mockTransport } from "./mocks/transport";
import { LruCache } from "@/lib/lru-cache";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

describe("toolCallRecordCache LRU", () => {
  beforeEach(() => {
    useThreadStore.setState({
      messages: [],
      runningThreadIds: new Set(),
      loading: false,
      error: null,
      currentThreadId: null,
      streamingByThread: {},
      toolCallsByThread: {},
      toolCallRecordCache: new LruCache(200),
    });
  });

  it("evicts oldest cache entry when LRU capacity is exceeded", () => {
    const { cacheToolCallRecords, getCachedToolCallRecords } =
      useThreadStore.getState();

    // Fill cache beyond capacity (TOOL_CALL_CACHE_SIZE = 200)
    for (let i = 0; i < 201; i++) {
      cacheToolCallRecords(`key-${i}`, []);
    }

    // First entry should have been evicted
    expect(getCachedToolCallRecords("key-0")).toBeNull();
    // Last entry should still be present
    expect(getCachedToolCallRecords("key-200")).toEqual([]);
  });

  it("get refreshes LRU order so accessed entry is not evicted", () => {
    const { cacheToolCallRecords, getCachedToolCallRecords } =
      useThreadStore.getState();

    // Fill to capacity
    for (let i = 0; i < 200; i++) {
      cacheToolCallRecords(`key-${i}`, []);
    }

    // Access the first entry to refresh it
    getCachedToolCallRecords("key-0");

    // Add one more to trigger eviction
    cacheToolCallRecords("key-200", []);

    // key-0 was refreshed, so key-1 should be evicted instead
    expect(getCachedToolCallRecords("key-0")).toEqual([]);
    expect(getCachedToolCallRecords("key-1")).toBeNull();
  });
});

describe("message sliding window", () => {
  beforeEach(() => {
    useThreadStore.setState({
      messages: [],
      runningThreadIds: new Set(),
      loading: false,
      error: null,
      currentThreadId: "thread-1",
      streamingByThread: {},
      toolCallsByThread: {},
      persistedToolCallCounts: {},
      serverMessageIds: {},
      toolCallRecordCache: new LruCache(200),
    });
  });

  it("caps messages at MESSAGE_WINDOW_SIZE when addMessage exceeds limit", () => {
    const msgs = Array.from({ length: 200 }, (_, i) => ({
      id: `msg-${i}`,
      thread_id: "thread-1",
      role: "user" as const,
      content: `Message ${i}`,
      tool_calls: null,
      files_changed: null,
      cost_usd: null,
      tokens_used: null,
      timestamp: new Date().toISOString(),
      sequence: i + 1,
      attachments: null,
    }));
    useThreadStore.setState({ messages: msgs });

    useThreadStore.getState().addMessage({
      id: "msg-200",
      thread_id: "thread-1",
      role: "assistant",
      content: "New message",
      tool_calls: null,
      files_changed: null,
      cost_usd: null,
      tokens_used: null,
      timestamp: new Date().toISOString(),
      sequence: 201,
      attachments: null,
    });

    const state = useThreadStore.getState();
    expect(state.messages.length).toBe(200);
    expect(state.messages[0].id).toBe("msg-1");
    expect(state.messages[state.messages.length - 1].id).toBe("msg-200");
  });

  it("sets hasOlderMessages to true when messages are evicted", () => {
    const msgs = Array.from({ length: 200 }, (_, i) => ({
      id: `msg-${i}`,
      thread_id: "thread-1",
      role: "user" as const,
      content: `Message ${i}`,
      tool_calls: null,
      files_changed: null,
      cost_usd: null,
      tokens_used: null,
      timestamp: new Date().toISOString(),
      sequence: i + 1,
      attachments: null,
    }));
    useThreadStore.setState({ messages: msgs, hasOlderMessages: false });

    useThreadStore.getState().addMessage({
      id: "msg-overflow",
      thread_id: "thread-1",
      role: "assistant",
      content: "Overflow",
      tool_calls: null,
      files_changed: null,
      cost_usd: null,
      tokens_used: null,
      timestamp: new Date().toISOString(),
      sequence: 201,
      attachments: null,
    });

    expect(useThreadStore.getState().hasOlderMessages).toBe(true);
  });

  it("session.message event respects the message cap", () => {
    vi.useFakeTimers();
    const msgs = Array.from({ length: 200 }, (_, i) => ({
      id: `msg-${i}`,
      thread_id: "thread-1",
      role: "user" as const,
      content: `Message ${i}`,
      tool_calls: null,
      files_changed: null,
      cost_usd: null,
      tokens_used: null,
      timestamp: new Date().toISOString(),
      sequence: i + 1,
      attachments: null,
    }));
    useThreadStore.setState({ messages: msgs });

    useThreadStore.getState().handleAgentEvent("thread-1", {
      method: "session.message",
      params: { content: "Agent reply" },
    });
    vi.runAllTimers();

    expect(useThreadStore.getState().messages.length).toBe(200);
    expect(useThreadStore.getState().hasOlderMessages).toBe(true);
    vi.useRealTimers();
  });
});
