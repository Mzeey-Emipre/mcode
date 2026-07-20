import { LruCache } from "@/lib/lru-cache";
import {
  forgetScrollTop,
  recallScrollPosition,
} from "@/components/chat/scrollPositionMemory";
import type { ThreadRecord } from "@/stores/thread-record";
import type { ConversationPage } from "@mcode/contracts";

/**
 * Initial default thread cache capacity.
 * Overridden by the `performance.threadCacheSize` user setting at runtime.
 */
export const RECORD_CACHE_SIZE = 15;

/** Maximum messages retained across one thread's record and warm history page. */
export const RECORD_MESSAGE_CACHE_SIZE = 100;

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

function filterMessageMetadata<T>(
  metadata: Record<string, T>,
  retainedMessageIds: Set<string>,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(metadata).filter(([messageId]) => retainedMessageIds.has(messageId)),
  );
}

function boundRecord(threadId: string, record: ThreadRecord): ThreadRecord {
  if (record.messages.length <= RECORD_MESSAGE_CACHE_SIZE) return record;

  const messages = record.messages.slice(-RECORD_MESSAGE_CACHE_SIZE);
  const retainedMessageIds = new Set(messages.map((message) => message.id));
  const rememberedPosition = recallScrollPosition(threadId);
  if (
    rememberedPosition?.anchorMessageId
    && !retainedMessageIds.has(rememberedPosition.anchorMessageId)
  ) {
    forgetScrollTop(threadId);
  }

  return {
    ...record,
    messages,
    oldestLoadedSequence: messages[0]?.sequence ?? record.oldestLoadedSequence,
    hasMoreMessages: true,
    persistedToolCallCounts: filterMessageMetadata(
      record.persistedToolCallCounts,
      retainedMessageIds,
    ),
    persistedFilesChanged: filterMessageMetadata(
      record.persistedFilesChanged,
      retainedMessageIds,
    ),
    serverMessageIds: filterMessageMetadata(record.serverMessageIds, retainedMessageIds),
    narrativeByMessage: filterMessageMetadata(record.narrativeByMessage, retainedMessageIds),
    answeredPlanMessageIds: new Set(
      [...record.answeredPlanMessageIds].filter((messageId) => retainedMessageIds.has(messageId)),
    ),
    assistantResponseKeys: filterMessageMetadata(
      record.assistantResponseKeys,
      retainedMessageIds,
    ),
    latestTurnWithChanges:
      record.latestTurnWithChanges && retainedMessageIds.has(record.latestTurnWithChanges)
        ? record.latestTurnWithChanges
        : null,
  };
}

function boundHistoryPage(page: ConversationPage, limit: number): ConversationPage | undefined {
  if (limit <= 0) return undefined;
  const droppedMessages = page.messages.length > limit;
  const messages = droppedMessages ? page.messages.slice(-limit) : page.messages;
  const retainedMessageIds = new Set(messages.map((message) => message.id));
  return {
    messages,
    hasMore: page.hasMore || droppedMessages,
    answeredPlanMessageIds: page.answeredPlanMessageIds?.filter((messageId) =>
      retainedMessageIds.has(messageId),
    ),
    narrativeByMessage: filterMessageMetadata(page.narrativeByMessage, retainedMessageIds),
  };
}

function trimPrefetchedHistory(threadId: string, recordMessageCount: number): void {
  const prefetched = prefetchedHistoryCache.get(threadId);
  if (!prefetched) return;
  const page = boundHistoryPage(
    prefetched.page,
    RECORD_MESSAGE_CACHE_SIZE - recordMessageCount,
  );
  if (!page) {
    prefetchedHistoryCache.delete(threadId);
    return;
  }
  prefetchedHistoryCache.set(threadId, { ...prefetched, page });
}

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
  const boundedRecord = boundRecord(threadId, record);
  const evicted = cache.set(threadId, boundedRecord);
  trimPrefetchedHistory(threadId, boundedRecord.messages.length);
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
  const recordMessageCount = cache.get(threadId)?.messages.length ?? 0;
  const boundedPage = boundHistoryPage(page, RECORD_MESSAGE_CACHE_SIZE - recordMessageCount);
  if (!boundedPage) {
    prefetchedHistoryCache.delete(threadId);
    return;
  }
  prefetchedHistoryCache.set(threadId, { before, page: boundedPage });
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
