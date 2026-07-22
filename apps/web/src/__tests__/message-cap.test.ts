import type { AgentEvent } from "@mcode/contracts";
import {
  resetThreadStoreForTests,
  getTestActiveMessages,
  getTestThreadHasMoreMessages,
  getTestThreadIsLoadingMore,
} from "@/stores/thread-store-test-utils";
import { createEmptyThreadRecord, patchThreadRecord, type ThreadRecord } from "@/stores/thread-record";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useThreadStore, MESSAGE_WINDOW_SIZE, TOOL_CALL_CACHE_SIZE } from "@/stores/threadStore";
import { mockTransport } from "./mocks/transport";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

describe("toolCallRecordCache LRU", () => {
  beforeEach(() => {
    resetThreadStoreForTests();
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
    resetThreadStoreForTests({
      currentThreadId: "thread-1",
      records: new Map<string, ThreadRecord>([
        ["thread-1", { ...createEmptyThreadRecord() }],
      ]),
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
    useThreadStore.setState((s) => ({
      records: s.currentThreadId
        ? patchThreadRecord(s.records, s.currentThreadId, { messages: msgs })
        : s.records,
    }));

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

    expect(getTestActiveMessages().length).toBe(MESSAGE_WINDOW_SIZE);
    expect(getTestActiveMessages()[0].id).toBe("msg-1");
    expect(getTestActiveMessages()[getTestActiveMessages().length - 1].id).toBe(`msg-${MESSAGE_WINDOW_SIZE}`);
  });

  it("sets hasMoreMessages to true when messages are evicted", () => {
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
    useThreadStore.setState((s) => ({
      currentThreadId: "thread-1",
      records: patchThreadRecord(s.records, "thread-1", { messages: msgs, hasMoreMessages: false }),
    }));

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

    expect(getTestThreadHasMoreMessages("thread-1")).toBe(true);
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
    useThreadStore.setState((s) => ({
      records: s.currentThreadId
        ? patchThreadRecord(s.records, s.currentThreadId, { messages: msgs })
        : s.records,
    }));

    useThreadStore.getState().handleAgentEvent({ type: "message", threadId: "thread-1", content: "Agent reply" } as AgentEvent);
    vi.runAllTimers();

    expect(getTestActiveMessages().length).toBe(MESSAGE_WINDOW_SIZE);
    expect(getTestThreadHasMoreMessages("thread-1")).toBe(true);
    vi.useRealTimers();
  });
});

describe("loadOlderMessages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetThreadStoreForTests({
      currentThreadId: "thread-1",
      records: new Map<string, ThreadRecord>([
        ["thread-1", { ...createEmptyThreadRecord(), hasMoreMessages: true, oldestLoadedSequence: 51 }],
      ]),
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
    useThreadStore.setState((s) => ({
      currentThreadId: "thread-1",
      records: patchThreadRecord(s.records, "thread-1", { messages: currentMsgs }),
    }));

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
    vi.mocked(mockTransport.getMessages).mockResolvedValueOnce({ messages: olderMsgs, hasMore: true });

    await useThreadStore.getState().loadOlderMessages("thread-1");

    expect(getTestActiveMessages().length).toBe(100);
    expect(getTestActiveMessages()[0].sequence).toBe(1);
    expect(getTestActiveMessages()[99].sequence).toBe(100);
  });

  it("sets hasMoreMessages to false when server reports no more", async () => {
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
    useThreadStore.setState((s) => ({
      currentThreadId: "thread-1",
      records: patchThreadRecord(s.records, "thread-1", { messages: currentMsgs, oldestLoadedSequence: 10 }),
    }));

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
    vi.mocked(mockTransport.getMessages).mockResolvedValueOnce({ messages: olderMsgs, hasMore: false });

    await useThreadStore.getState().loadOlderMessages("thread-1");

    expect(getTestThreadHasMoreMessages("thread-1")).toBe(false);
  });

  it("does nothing when hasMoreMessages is false", async () => {
    resetThreadStoreForTests({
      records: new Map<string, ThreadRecord>([
        ["thread-1", { ...createEmptyThreadRecord(), hasMoreMessages: false }],
      ]),
    });
    await useThreadStore.getState().loadOlderMessages("thread-1");
    expect(mockTransport.getMessages).not.toHaveBeenCalled();
  });

  it("does nothing when already loading older messages", async () => {
    resetThreadStoreForTests({
      records: new Map<string, ThreadRecord>([
        ["thread-1", { ...createEmptyThreadRecord(), isLoadingMore: true }],
      ]),
    });
    await useThreadStore.getState().loadOlderMessages("thread-1");
    expect(mockTransport.getMessages).not.toHaveBeenCalled();
  });

  it("ignores results when thread switches during pagination", async () => {
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
    useThreadStore.setState((s) => ({
      currentThreadId: "thread-1",
      records: patchThreadRecord(s.records, "thread-1", { messages: currentMsgs }),
    }));

    let resolveGetMessages!: (value: unknown) => void;
    (mockTransport.getMessages as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      new Promise((resolve) => { resolveGetMessages = resolve; }),
    );

    const promise = useThreadStore.getState().loadOlderMessages("thread-1");

    // Switch thread before the fetch resolves
    useThreadStore.setState((s) => ({
      currentThreadId: "thread-2",
      records: patchThreadRecord(s.records, "thread-2", { messages: [] }),
    }));

    resolveGetMessages({
      messages: Array.from({ length: 50 }, (_, i) => ({
        id: `older-${i}`,
        thread_id: "thread-1",
        role: "user",
        content: `Older ${i}`,
        tool_calls: null,
        files_changed: null,
        cost_usd: null,
        tokens_used: null,
        timestamp: new Date().toISOString(),
        sequence: i + 1,
        attachments: null,
      })),
      hasMore: true,
    });
    await promise;

    const state = useThreadStore.getState();
    expect(state.currentThreadId).toBe("thread-2");
    expect(getTestActiveMessages()).toEqual([]);
    expect(getTestThreadIsLoadingMore("thread-1")).toBe(false);
  });

  it("repeated prepends accumulate messages correctly", async () => {
    // Start with 50 messages (seq 51-100)
    const initial = Array.from({ length: 50 }, (_, i) => ({
      id: `msg-${i}`,
      thread_id: "thread-1",
      role: "user" as const,
      content: `Message ${i}`,
      tool_calls: null,
      files_changed: null,
      cost_usd: null,
      tokens_used: null,
      timestamp: new Date().toISOString(),
      sequence: 51 + i,
      attachments: null,
    }));
    useThreadStore.setState((s) => ({
      currentThreadId: "thread-1",
      records: patchThreadRecord(s.records, "thread-1", { messages: initial, oldestLoadedSequence: 51 }),
    }));

    // First pagination: 50 older messages (seq 1-50)
    const batch1 = Array.from({ length: 50 }, (_, i) => ({
      id: `batch1-${i}`,
      thread_id: "thread-1",
      role: "user" as const,
      content: `Batch1 ${i}`,
      tool_calls: null,
      files_changed: null,
      cost_usd: null,
      tokens_used: null,
      timestamp: new Date().toISOString(),
      sequence: 1 + i,
      attachments: null,
    }));
    vi.mocked(mockTransport.getMessages).mockResolvedValueOnce({ messages: batch1, hasMore: false });
    await useThreadStore.getState().loadOlderMessages("thread-1");

    // All 100 messages present (50 prepended + 50 original)
    expect(getTestActiveMessages().length).toBe(100);
    expect(getTestActiveMessages()[0].sequence).toBe(1);
    expect(getTestActiveMessages()[99].sequence).toBe(100);
    // No more to load
    expect(getTestThreadHasMoreMessages("thread-1")).toBe(false);
  });
});
