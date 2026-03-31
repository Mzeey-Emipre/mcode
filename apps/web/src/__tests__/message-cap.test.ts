import { describe, it, expect, beforeEach, vi } from "vitest";
import { useThreadStore } from "@/stores/threadStore";
import { mockTransport } from "./mocks/transport";

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
