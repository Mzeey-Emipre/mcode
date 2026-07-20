import { LruCache } from "@/lib/lru-cache";
import { forgetScrollTop } from "@/components/chat/scrollPositionMemory";
import type { ThreadRecord } from "@/stores/thread-record";
import type { ConversationPage } from "@mcode/contracts";

/**
 * Initial default thread cache capacity.
 * Overridden by the `performance.threadCacheSize` user setting at runtime.
 */
export const RECORD_CACHE_SIZE = 15;

/**
 * Module-scoped LRU cache of evicted {@link ThreadRecord}s.
 * The hydrator owns this cache: an active-thread switch evicts records into
 * here so the next visit restores synchronously without an RPC round-trip.
 */
const cache = new LruCache<string, ThreadRecord>(RECORD_CACHE_SIZE);

interface PrefetchedHistoryPage {
  before: number;
  page: ConversationPage;
}

const prefetchedHistoryCache = new LruCache<string, PrefetchedHistoryPage>(RECORD_CACHE_SIZE);

/** Read the cached record for a thread, refreshing LRU recency on hit. */
export function getCachedRecord(threadId: string): ThreadRecord | undefined {
  return cache.get(threadId);
}

/** Check if a thread has a cached record without promoting LRU recency. */
export function hasCachedRecord(threadId: string): boolean {
  return cache.has(threadId);
}

/** Store a record for the given thread, evicting the LRU entry if at capacity. */
export function cacheRecord(threadId: string, record: ThreadRecord): void {
  const evicted = cache.set(threadId, record);
  if (evicted) {
    forgetScrollTop(evicted);
    prefetchedHistoryCache.delete(evicted);
  }
}

/** Cache one older-history page without attaching its messages to live React state. */
export function cachePrefetchedHistoryPage(
  threadId: string,
  before: number,
  page: ConversationPage,
): void {
  prefetchedHistoryCache.set(threadId, { before, page });
}

/** Check whether the requested older-history cursor is already warm. */
export function hasPrefetchedHistoryPage(threadId: string, before: number): boolean {
  const entry = prefetchedHistoryCache.get(threadId);
  return entry?.before === before;
}

/** Consume the warm older-history page for the requested cursor. */
export function takePrefetchedHistoryPage(
  threadId: string,
  before: number,
): ConversationPage | undefined {
  const entry = prefetchedHistoryCache.get(threadId);
  if (entry?.before !== before) return undefined;
  prefetchedHistoryCache.delete(threadId);
  return entry.page;
}

/** Remove a single thread's cached record. No-op when absent. */
export function evictCachedRecord(threadId: string): void {
  cache.delete(threadId);
  prefetchedHistoryCache.delete(threadId);
}

/** Drop all cached records. Used in tests and on workspace deletion. */
export function clearRecordCache(): void {
  cache.clear();
  prefetchedHistoryCache.clear();
}

/**
 * Change the record-cache capacity at runtime. Clamped to a minimum of 1.
 * When shrinking, evicts the least-recently-used threads until size <= capacity
 * and forgets each evicted thread's scroll position to keep scroll memory
 * consistent with cache contents.
 */
export function resizeRecordCache(capacity: number): void {
  const evicted = cache.resize(capacity);
  prefetchedHistoryCache.resize(capacity);
  for (const threadId of evicted) {
    forgetScrollTop(threadId);
    prefetchedHistoryCache.delete(threadId);
  }
}
