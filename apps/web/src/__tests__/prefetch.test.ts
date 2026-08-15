import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getCachedRecord,
  cacheRecord as cacheConversationRecord,
  clearRecordCache,
  projectConversationCacheState,
} from "@/features/conversation/hydration/record-cache";
import { createEmptyThreadRecord, type ThreadRecord } from "@/stores/thread-record";
import { mockTransport, createMockMessage } from "./mocks/transport";

vi.mock("@/transport", () => ({
  getTransport: () => mockTransport,
}));

function makeRecord(id: string): ThreadRecord {
  return {
    ...createEmptyThreadRecord(),
    messages: [
      createMockMessage({
        id: `${id}-msg-1`,
        thread_id: id,
        sequence: 1,
      }),
    ],
    oldestLoadedSequence: 1,
  };
}

function cacheRecord(threadId: string, record: ThreadRecord): void {
  cacheConversationRecord(threadId, projectConversationCacheState(record));
}

describe("prefetch", () => {
  let schedulePrefetch: typeof import("@/features/conversation/hydration/prefetch-scheduler").schedulePrefetch;
  let cancelPrefetch: typeof import("@/features/conversation/hydration/prefetch-scheduler").cancelPrefetch;
  let prefetchOnPointerDown: typeof import("@/features/conversation/hydration/prefetch-scheduler").prefetchOnPointerDown;
  let isPrefetchPending: typeof import("@/features/conversation/hydration/prefetch-scheduler").isPrefetchPending;
  let resetPrefetch: typeof import("@/features/conversation/hydration/prefetch-scheduler").__resetPrefetchForTests;

  beforeEach(async () => {
    vi.useFakeTimers();
    clearRecordCache();
    vi.mocked(mockTransport.getMessages).mockReset();
    vi.mocked(mockTransport.loadConversationPage).mockReset();
    vi.mocked(mockTransport.loadConversationPage).mockResolvedValue({
      messages: [
        createMockMessage({ id: "m1", thread_id: "t1", sequence: 1 }),
      ],
      hasMore: false,
      narrativeByMessage: {},
    });

    // Ensure threadStore registers the hydrator before prefetch runs.
    await import("@/stores/threadStore");

    // Dynamic import to get fresh module state after mocks are set up
    const mod = await import("@/features/conversation/hydration/prefetch-scheduler");
    schedulePrefetch = mod.schedulePrefetch;
    cancelPrefetch = mod.cancelPrefetch;
    prefetchOnPointerDown = mod.prefetchOnPointerDown;
    isPrefetchPending = mod.isPrefetchPending;
    resetPrefetch = mod.__resetPrefetchForTests;
  });

  afterEach(() => {
    resetPrefetch();
    vi.useRealTimers();
  });

  it("fires prefetch after 50ms debounce", async () => {
    schedulePrefetch("t1");

    // Not yet fired
    expect(mockTransport.loadConversationPage).not.toHaveBeenCalled();

    // Advance past debounce
    vi.advanceTimersByTime(50);
    expect(mockTransport.loadConversationPage).toHaveBeenCalledWith("t1", 2);
    expect(mockTransport.getMessages).not.toHaveBeenCalled();

    // Let the async prefetch settle
    await vi.runAllTimersAsync();
    expect(getCachedRecord("t1")).toBeDefined();
  });

  it("cancel stops a pending prefetch", () => {
    schedulePrefetch("t1");
    cancelPrefetch();

    vi.advanceTimersByTime(100);
    expect(mockTransport.loadConversationPage).not.toHaveBeenCalled();
  });

  it("skips threads that are already cached", () => {
    cacheRecord("t1", makeRecord("t1"));

    schedulePrefetch("t1");
    vi.advanceTimersByTime(50);

    expect(mockTransport.loadConversationPage).not.toHaveBeenCalled();
  });

  it("prevents duplicate in-flight requests", async () => {
    // First prefetch: resolved after a tick
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resolveFirst!: (v: any) => void;
    vi.mocked(mockTransport.loadConversationPage).mockImplementationOnce(
      () => new Promise((r) => { resolveFirst = r; }),
    );

    schedulePrefetch("t1");
    vi.advanceTimersByTime(50);
    expect(mockTransport.loadConversationPage).toHaveBeenCalledTimes(1);

    // Schedule a second prefetch for the same thread while the first is in flight
    schedulePrefetch("t1");
    vi.advanceTimersByTime(50);
    // Should not fire a second RPC
    expect(mockTransport.loadConversationPage).toHaveBeenCalledTimes(1);

    // Resolve the first to clean up
    resolveFirst({
      messages: [createMockMessage({ id: "m1", thread_id: "t1", sequence: 1 })],
      hasMore: false,
      narrativeByMessage: {},
    });
    await vi.runAllTimersAsync();
  });

  it("does not throw on failed prefetch", async () => {
    vi.mocked(mockTransport.loadConversationPage).mockRejectedValueOnce(
      new Error("network error"),
    );

    schedulePrefetch("t1");
    vi.advanceTimersByTime(50);

    // Should not throw; the error is swallowed
    await vi.runAllTimersAsync();

    // Cache should remain empty
    expect(getCachedRecord("t1")).toBeUndefined();
  });

  it("prefetches immediately on pointer-down and cancels pending hover work", () => {
    schedulePrefetch("t1");
    vi.advanceTimersByTime(25);

    prefetchOnPointerDown("t1");

    expect(mockTransport.loadConversationPage).toHaveBeenCalledTimes(1);
    expect(mockTransport.loadConversationPage).toHaveBeenCalledWith("t1", 2);

    vi.advanceTimersByTime(100);
    expect(mockTransport.loadConversationPage).toHaveBeenCalledTimes(1);
  });

  it("reports pointer-down prefetch work until it settles", async () => {
    let resolvePage!: (value: {
      messages: ReturnType<typeof createMockMessage>[];
      hasMore: boolean;
      narrativeByMessage: Record<string, never>;
    }) => void;
    vi.mocked(mockTransport.loadConversationPage).mockImplementationOnce(
      () => new Promise((resolve) => { resolvePage = resolve; }),
    );

    prefetchOnPointerDown("t1");
    expect(isPrefetchPending("t1")).toBe(true);

    resolvePage({ messages: [], hasMore: false, narrativeByMessage: {} });
    await vi.runAllTimersAsync();
    expect(isPrefetchPending("t1")).toBe(false);
  });

  it("debounces rapid successive calls", () => {
    schedulePrefetch("t1");
    vi.advanceTimersByTime(20);
    schedulePrefetch("t2");
    vi.advanceTimersByTime(20);
    schedulePrefetch("t3");

    // Only the last one should fire after full debounce
    vi.advanceTimersByTime(50);
    expect(mockTransport.loadConversationPage).toHaveBeenCalledTimes(1);
    expect(mockTransport.loadConversationPage).toHaveBeenCalledWith("t3", 2);
  });

  it("keeps rapid unique pointer prefetches within two shared slots", async () => {
    const resolvers = new Map<string, (value: {
      messages: ReturnType<typeof createMockMessage>[];
      hasMore: boolean;
      narrativeByMessage: Record<string, never>;
    }) => void>();
    vi.mocked(mockTransport.loadConversationPage).mockImplementation(
      (threadId) =>
        new Promise((resolve) => {
          resolvers.set(threadId, resolve);
        }),
    );

    prefetchOnPointerDown("t1");
    prefetchOnPointerDown("t2");
    prefetchOnPointerDown("t3");

    expect(mockTransport.loadConversationPage).toHaveBeenCalledTimes(2);

    const page = (threadId: string) => ({
      messages: [
        createMockMessage({
          id: `${threadId}-message`,
          thread_id: threadId,
          sequence: 1,
        }),
      ],
      hasMore: false,
      narrativeByMessage: {},
    });
    resolvers.get("t1")?.(page("t1"));
    await vi.runAllTimersAsync();
    expect(mockTransport.loadConversationPage).toHaveBeenCalledTimes(3);

    resolvers.get("t2")?.(page("t2"));
    resolvers.get("t3")?.(page("t3"));
    await vi.runAllTimersAsync();
  });
});
