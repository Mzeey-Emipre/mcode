import { LruCache } from "@/lib/lru-cache";
import {
  forgetScrollTop,
  recallScrollPosition,
} from "@/components/chat/scrollPositionMemory";
import type { ThreadRecord } from "@/stores/thread-record";
import type {
  ConversationOlderPage,
  ConversationOlderPageIdentity,
  ConversationPage,
} from "@mcode/contracts";

/**
 * Initial default thread cache capacity.
 * Overridden by the `performance.threadCacheSize` user setting at runtime.
 */
export const RECORD_CACHE_SIZE = 25;

/** Maximum messages retained across one thread's record and warm history page. */
export const RECORD_MESSAGE_CACHE_SIZE = 100;

/**
 * Conversation-owned state retained for an inactive thread.
 *
 * This is intentionally not a `Pick<ThreadRecord, ...>`: adding a field to
 * `ThreadRecord` cannot silently make it part of the cache contract.
 */
export interface ConversationCacheState {
  messages: ThreadRecord["messages"];
  oldestLoadedSequence: ThreadRecord["oldestLoadedSequence"];
  newestLoadedSequence: ThreadRecord["newestLoadedSequence"];
  hasMoreMessages: ThreadRecord["hasMoreMessages"];
  hasNewerMessages: ThreadRecord["hasNewerMessages"];
  persistedToolCallCounts: ThreadRecord["persistedToolCallCounts"];
  persistedFilesChanged: ThreadRecord["persistedFilesChanged"];
  latestTurnWithChanges: ThreadRecord["latestTurnWithChanges"];
  serverMessageIds: ThreadRecord["serverMessageIds"];
  narrativeByMessage: ThreadRecord["narrativeByMessage"];
  answeredPlanMessageIds: ThreadRecord["answeredPlanMessageIds"];
  assistantResponseKeys: ThreadRecord["assistantResponseKeys"];
  /** Auxiliary hydration freshness retained with the inactive conversation. */
  lastHydratedAt?: ThreadRecord["lastHydratedAt"];
  /** Latest settled snapshot projection. Never populated from a live turn. */
  settledFileEffectSummary: ThreadRecord["fileEffectSummary"] | null;
}

/** Build the explicit conversation cache contract from a resident thread record. */
export function projectConversationCacheState(record: ThreadRecord): ConversationCacheState {
  return {
    messages: record.messages,
    oldestLoadedSequence: record.oldestLoadedSequence,
    newestLoadedSequence: record.newestLoadedSequence,
    hasMoreMessages: record.hasMoreMessages,
    hasNewerMessages: record.hasNewerMessages,
    persistedToolCallCounts: record.persistedToolCallCounts,
    persistedFilesChanged: record.persistedFilesChanged,
    latestTurnWithChanges: record.latestTurnWithChanges,
    serverMessageIds: record.serverMessageIds,
    narrativeByMessage: record.narrativeByMessage,
    answeredPlanMessageIds: record.answeredPlanMessageIds,
    assistantResponseKeys: record.assistantResponseKeys,
    lastHydratedAt: record.lastHydratedAt,
    settledFileEffectSummary: record.fileEffectTurnId.length === 0
      ? record.fileEffectSummary
      : null,
  };
}

/**
 * Module-scoped LRU cache of evicted {@link ConversationCacheState}s.
 * The hydrator owns this cache: an active-thread switch evicts records into
 * here so the next visit restores synchronously without an RPC round-trip.
 */
const cache = new LruCache<string, ConversationCacheState>(RECORD_CACHE_SIZE);

interface PrefetchedHistoryPage {
  before: number;
  page: ConversationOlderPage | ConversationPage;
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

function boundRecord(threadId: string, record: ConversationCacheState): ConversationCacheState {
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
    newestLoadedSequence: messages.at(-1)?.sequence ?? record.newestLoadedSequence,
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

function boundHistoryPage(
  page: ConversationOlderPage | ConversationPage,
  limit: number,
): ConversationOlderPage | ConversationPage | undefined {
  if (limit <= 0) return undefined;
  const droppedMessages = page.messages.length > limit;
  const messages = droppedMessages ? page.messages.slice(-limit) : page.messages;
  const retainedMessageIds = new Set(messages.map((message) => message.id));
  const boundedPage = {
    ...page,
    messages,
    hasMore: page.hasMore || droppedMessages,
    answeredPlanMessageIds: page.answeredPlanMessageIds?.filter((messageId) =>
      retainedMessageIds.has(messageId),
    ),
    narrativeByMessage: filterMessageMetadata(page.narrativeByMessage, retainedMessageIds),
  };
  if (!("identity" in page)) return boundedPage;
  return {
    ...boundedPage,
    nextCursor: boundedPage.hasMore
      ? { version: 1, beforeSequence: messages[0].sequence }
      : null,
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
export function getCachedRecord(threadId: string): ConversationCacheState | undefined {
  return cache.get(threadId);
}

/** Check if a thread has a cached record without promoting LRU recency. */
export function hasCachedRecord(threadId: string): boolean {
  return cache.has(threadId);
}

/** Store a record for the given thread, evicting the LRU entry if at capacity. */
export function cacheRecord(threadId: string, record: ConversationCacheState): void {
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
  page: ConversationOlderPage | ConversationPage,
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
  identity: ConversationOlderPageIdentity,
): ConversationOlderPage | undefined {
  const entry = prefetchedHistoryCache.get(identity.threadId);
  if (
    entry?.before !== identity.cursor.beforeSequence
    || ("identity" in entry.page && (
      entry.page.identity.threadId !== identity.threadId
      || entry.page.identity.cursor.beforeSequence !== identity.cursor.beforeSequence
      || entry.page.identity.direction !== identity.direction
      || entry.page.identity.generation !== identity.generation
      || entry.page.identity.conversationRevision !== identity.conversationRevision
    ))
  ) return undefined;
  prefetchedHistoryCache.delete(identity.threadId);
  return {
    ...entry.page,
    identity,
    nextCursor: entry.page.hasMore && entry.page.messages.length > 0
      ? { version: 1, beforeSequence: entry.page.messages[0].sequence }
      : null,
  };
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
