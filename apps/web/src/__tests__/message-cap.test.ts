import { describe, it, expect, beforeEach, vi } from "vitest";
import { useThreadStore, MESSAGE_WINDOW_SIZE, TOOL_CALL_CACHE_SIZE } from "@/stores/threadStore";
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
    for (let i = 0; i < TOOL_CALL_CACHE_SIZE + 1; i++) {
      cacheToolCallRecords(`key-${i}`, []);
    }

    // First entry should have been evicted
    expect(getCachedToolCallRecords("key-0")).toBeNull();
    // Last entry should still be present
    expect(getCachedToolCallRecords(`key-${TOOL_CALL_CACHE_SIZE}`)).toEqual([]);
  });

  it("get refreshes LRU order so accessed entry is not evicted", () => {
    const { cacheToolCallRecords, getCachedToolCallRecords } =
      useThreadStore.getState();

    // Fill to capacity
    for (let i = 0; i < TOOL_CALL_CACHE_SIZE; i++) {
      cacheToolCallRecords(`key-${i}`, []);
    }

    // Access the first entry to refresh it
    getCachedToolCallRecords("key-0");

    // Add one more to trigger eviction
    cacheToolCallRecords(`key-${TOOL_CALL_CACHE_SIZE}`, []);

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
    const msgs = Array.from({ length: MESSAGE_WINDOW_SIZE }, (_, i) => ({
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
      id: `msg-${MESSAGE_WINDOW_SIZE}`,
      thread_id: "thread-1",
      role: "assistant",
      content: "New message",
      tool_calls: null,
      files_changed: null,
      cost_usd: null,
      tokens_used: null,
      timestamp: new Date().toISOString(),
      sequence: MESSAGE_WINDOW_SIZE + 1,
      attachments: null,
    });

    const state = useThreadStore.getState();
    expect(state.messages.length).toBe(MESSAGE_WINDOW_SIZE);
    expect(state.messages[0].id).toBe("msg-1");
    expect(state.messages[state.messages.length - 1].id).toBe(`msg-${MESSAGE_WINDOW_SIZE}`);
  });

  it("sets hasOlderMessages to true when messages are evicted", () => {
    const msgs = Array.from({ length: MESSAGE_WINDOW_SIZE }, (_, i) => ({
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
      sequence: MESSAGE_WINDOW_SIZE + 1,
      attachments: null,
    });

    expect(useThreadStore.getState().hasOlderMessages).toBe(true);
  });

  it("session.message event respects the message cap", () => {
    vi.useFakeTimers();
    const msgs = Array.from({ length: MESSAGE_WINDOW_SIZE }, (_, i) => ({
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

    expect(useThreadStore.getState().messages.length).toBe(MESSAGE_WINDOW_SIZE);
    expect(useThreadStore.getState().hasOlderMessages).toBe(true);
    vi.useRealTimers();
  });
});

describe("loadOlderMessages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useThreadStore.setState({
      messages: [],
      runningThreadIds: new Set(),
      loading: false,
      loadingOlder: false,
      error: null,
      currentThreadId: "thread-1",
      streamingByThread: {},
      toolCallsByThread: {},
      persistedToolCallCounts: {},
      serverMessageIds: {},
      hasOlderMessages: true,
      toolCallRecordCache: new LruCache(200),
    });
  });

  it("prepends older messages fetched from the server", async () => {
    // Current in-memory messages start at sequence 51
    const currentMsgs = Array.from({ length: 50 }, (_, i) => ({
      id: `msg-${i + 50}`,
      thread_id: "thread-1",
      role: "user" as const,
      content: `Message ${i + 50}`,
      tool_calls: null,
      files_changed: null,
      cost_usd: null,
      tokens_used: null,
      timestamp: new Date().toISOString(),
      sequence: i + 51,
      attachments: null,
    }));
    useThreadStore.setState({ messages: currentMsgs });

    // Server returns 50 older messages (sequences 1-50)
    const olderMsgs = Array.from({ length: 50 }, (_, i) => ({
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
    vi.mocked(mockTransport.getMessages).mockResolvedValueOnce(olderMsgs);

    await useThreadStore.getState().loadOlderMessages();

    const state = useThreadStore.getState();
    expect(state.messages.length).toBe(100);
    expect(state.messages[0].sequence).toBe(1);
    expect(state.messages[99].sequence).toBe(100);
  });

  it("sets hasOlderMessages to false when server returns fewer than limit", async () => {
    const currentMsgs = [{
      id: "msg-10",
      thread_id: "thread-1",
      role: "user" as const,
      content: "Message 10",
      tool_calls: null,
      files_changed: null,
      cost_usd: null,
      tokens_used: null,
      timestamp: new Date().toISOString(),
      sequence: 10,
      attachments: null,
    }];
    useThreadStore.setState({ messages: currentMsgs });

    const olderMsgs = Array.from({ length: 5 }, (_, i) => ({
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
    vi.mocked(mockTransport.getMessages).mockResolvedValueOnce(olderMsgs);

    await useThreadStore.getState().loadOlderMessages();

    expect(useThreadStore.getState().hasOlderMessages).toBe(false);
  });

  it("does nothing when hasOlderMessages is false", async () => {
    useThreadStore.setState({ hasOlderMessages: false });
    await useThreadStore.getState().loadOlderMessages();
    expect(mockTransport.getMessages).not.toHaveBeenCalled();
  });

  it("does nothing when already loading older messages", async () => {
    useThreadStore.setState({ loadingOlder: true });
    await useThreadStore.getState().loadOlderMessages();
    expect(mockTransport.getMessages).not.toHaveBeenCalled();
  });
});
