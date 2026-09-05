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
import {
  ACTIVE_CONVERSATION_MESSAGE_BYTES,
  ACTIVE_CONVERSATION_BYTES,
  CONVERSATION_NARRATIVE_BYTES,
  CRITICAL_ACTIVE_CONVERSATION_MESSAGE_BYTES,
  INACTIVE_CONVERSATION_BYTES,
  PREFETCHED_CONVERSATION_BYTES,
  measureConversationValue,
  selectConversationNarrative,
  selectConversationWindow,
} from "./conversation-memory-policy";

/** Automatic byte budgets for each conversation residency class. */
export const CONVERSATION_MEMORY_BUDGETS = {
  activeBytes: ACTIVE_CONVERSATION_BYTES,
  inactiveBytes: INACTIVE_CONVERSATION_BYTES,
  prefetchedBytes: PREFETCHED_CONVERSATION_BYTES,
  narrativeBytes: CONVERSATION_NARRATIVE_BYTES,
} as const;

/**
 * Secondary entry-count ceiling. Byte budgets are the primary eviction policy.
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
  sessionNotices: ThreadRecord["sessionNotices"];
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
    sessionNotices: record.sessionNotices,
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
const recordByteSizes = new Map<string, number>();
const recordNarrativeByteSizes = new Map<string, number>();
const prefetchByteSizes = new Map<string, number>();
const prefetchNarrativeByteSizes = new Map<string, number>();
const transientTextByteSizes = new Map<string, number>();
let activeConversationId: string | null = null;

function measureRecord(record: ConversationCacheState): number {
  return measureConversationValue({
    ...record,
    answeredPlanMessageIds: [...record.answeredPlanMessageIds],
  });
}

function measurePage(entry: PrefetchedHistoryPage): number {
  return measureConversationValue(entry);
}

function pruneNarrative(
  narrativeByMessage: ConversationCacheState["narrativeByMessage"],
  messages: readonly ConversationCacheState["messages"][number][],
  maxBytes = CONVERSATION_NARRATIVE_BYTES,
): ConversationCacheState["narrativeByMessage"] {
  return selectConversationNarrative(narrativeByMessage, messages, {
    maxBytes,
  });
}

function filterMessageMetadata<T>(
  metadata: Record<string, T>,
  retainedMessageIds: Set<string>,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(metadata).filter(([messageId]) => retainedMessageIds.has(messageId)),
  );
}

function boundRecord(
  threadId: string,
  record: ConversationCacheState,
  maxBytes = activeConversationId === threadId
    ? ACTIVE_CONVERSATION_MESSAGE_BYTES
    : ACTIVE_CONVERSATION_MESSAGE_BYTES / 2,
): ConversationCacheState {
  const rememberedPosition = recallScrollPosition(threadId);
  const isActive = activeConversationId === threadId;
  const preference = rememberedPosition?.anchorMessageId ? "older" : "newer";
  let messageBudget = maxBytes;

  while (true) {
    const window = boundedMessageWindow(record, rememberedPosition?.anchorMessageId, messageBudget, preference);
    const messages = window.messages;
    const withoutNarrative = recordWithoutNarrative(record, messages, window);
    const { narrativeBudget, transientTextBytes } = activeNarrativeBudget(threadId, withoutNarrative, isActive);
    const boundedRecord = boundedRecordWithNarrative(record, withoutNarrative, narrativeBudget);
    const overflow = isActive
      ? measureRecord(boundedRecord) + transientTextBytes - ACTIVE_CONVERSATION_BYTES
      : 0;
    if (overflow <= 0 || messages.length <= 1) return boundedRecord;
    messageBudget = Math.max(0, messageBudget - overflow - 1);
  }
}

function evictOldestPrefetch(): string | undefined {
  const threadId = prefetchedHistoryCache.keys()[0];
  if (threadId) {
    prefetchedHistoryCache.delete(threadId);
    prefetchByteSizes.delete(threadId);
    prefetchNarrativeByteSizes.delete(threadId);
  }
  return threadId;
}

function inactiveEntries(): Array<[string, ConversationCacheState]> {
  return cache.entries().filter(([threadId]) => threadId !== activeConversationId);
}

function evictOldestInactive(): string | undefined {
  const threadId = inactiveEntries()[0]?.[0];
  if (!threadId) return undefined;
  cache.delete(threadId);
  prefetchedHistoryCache.delete(threadId);
  recordByteSizes.delete(threadId);
  recordNarrativeByteSizes.delete(threadId);
  prefetchByteSizes.delete(threadId);
  prefetchNarrativeByteSizes.delete(threadId);
  forgetScrollTop(threadId);
  return threadId;
}

function enforceNarrativeByteBudget(): void {
  for (const [threadId, entry] of prefetchedHistoryCache.entries()) {
    if (getConversationCacheUsage().narrativeBytes <= CONVERSATION_NARRATIVE_BYTES) return;
    if ((prefetchNarrativeByteSizes.get(threadId) ?? 0) === 0) continue;
    const withoutNarrative = {
      ...entry,
      page: { ...entry.page, narrativeByMessage: {} },
    };
    prefetchedHistoryCache.set(threadId, withoutNarrative);
    prefetchByteSizes.set(threadId, measurePage(withoutNarrative));
    prefetchNarrativeByteSizes.set(threadId, 0);
  }
  for (const [threadId, record] of inactiveEntries()) {
    if (getConversationCacheUsage().narrativeBytes <= CONVERSATION_NARRATIVE_BYTES) return;
    if ((recordNarrativeByteSizes.get(threadId) ?? 0) === 0) continue;
    const withoutNarrative = { ...record, narrativeByMessage: {} };
    cache.set(threadId, withoutNarrative);
    recordByteSizes.set(threadId, measureRecord(withoutNarrative));
    recordNarrativeByteSizes.set(threadId, 0);
  }
}

function enforceAutomaticByteBudgets(): void {
  while (getConversationCacheUsage().prefetchedBytes > PREFETCHED_CONVERSATION_BYTES) {
    if (!evictOldestPrefetch()) break;
  }
  while (getConversationCacheUsage().inactiveBytes > INACTIVE_CONVERSATION_BYTES) {
    if (!evictOldestInactive()) break;
  }
  enforceNarrativeByteBudget();
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
    prefetchByteSizes.delete(threadId);
    prefetchNarrativeByteSizes.delete(threadId);
    return;
  }
  const entry = { ...prefetched, page };
  prefetchedHistoryCache.set(threadId, entry);
  prefetchByteSizes.set(threadId, measurePage(entry));
  prefetchNarrativeByteSizes.set(
    threadId,
    measureConversationValue(page.narrativeByMessage),
  );
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
  recordByteSizes.set(threadId, measureRecord(boundedRecord));
  recordNarrativeByteSizes.set(
    threadId,
    measureConversationValue(boundedRecord.narrativeByMessage),
  );
  trimPrefetchedHistory(threadId, boundedRecord.messages.length);
  if (evicted) {
    recordByteSizes.delete(evicted);
    recordNarrativeByteSizes.delete(evicted);
    prefetchByteSizes.delete(evicted);
    prefetchNarrativeByteSizes.delete(evicted);
    forgetScrollTop(evicted);
    prefetchedHistoryCache.delete(evicted);
  }
  enforceAutomaticByteBudgets();
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
    prefetchByteSizes.delete(threadId);
    prefetchNarrativeByteSizes.delete(threadId);
    return;
  }
  prefetchedHistoryCache.set(threadId, { before, page: boundedPage });
  prefetchByteSizes.set(threadId, measurePage({ before, page: boundedPage }));
  prefetchNarrativeByteSizes.set(
    threadId,
    measureConversationValue(boundedPage.narrativeByMessage),
  );
  enforceAutomaticByteBudgets();
}

/** Check whether the requested older-history cursor is already warm. */
export function hasPrefetchedHistoryPage(threadId: string, before: number): boolean {
  const entry = prefetchedHistoryCache.get(threadId);
  return entry?.before === before;
}

function boundedMessageWindow(
  record: ConversationCacheState,
  anchorMessageId: string | undefined,
  messageBudget: number,
  preference: "older" | "newer",
) {
  return selectConversationWindow(record.messages, {
    anchorMessageId,
    maxBytes: messageBudget,
    maxMessages: RECORD_MESSAGE_CACHE_SIZE,
    preference,
  });
}

function trimMetadataForWindow<T>(metadata: Record<string, T>, retainedMessageIds: Set<string>, windowWasTrimmed: boolean): Record<string, T> {
  return windowWasTrimmed ? filterMessageMetadata(metadata, retainedMessageIds) : metadata;
}

function windowMessageBounds(record: ConversationCacheState, messages: ConversationCacheState["messages"], window: ReturnType<typeof boundedMessageWindow>) {
  const windowWasTrimmed = window.evictedOlder || window.evictedNewer;
  return {
    oldestLoadedSequence: windowWasTrimmed ? messages[0]?.sequence ?? record.oldestLoadedSequence : record.oldestLoadedSequence,
    newestLoadedSequence: windowWasTrimmed ? messages.at(-1)?.sequence ?? record.newestLoadedSequence : record.newestLoadedSequence,
    hasMoreMessages: record.hasMoreMessages || window.evictedOlder,
    hasNewerMessages: record.hasNewerMessages || window.evictedNewer,
    windowWasTrimmed,
  };
}

function windowMetadata(record: ConversationCacheState, retainedMessageIds: Set<string>, windowWasTrimmed: boolean): Pick<ConversationCacheState, "persistedToolCallCounts" | "persistedFilesChanged" | "serverMessageIds" | "answeredPlanMessageIds" | "assistantResponseKeys" | "latestTurnWithChanges"> {
  const latestTurnWithChanges = record.latestTurnWithChanges;
  return {
    persistedToolCallCounts: trimMetadataForWindow(record.persistedToolCallCounts, retainedMessageIds, windowWasTrimmed),
    persistedFilesChanged: trimMetadataForWindow(record.persistedFilesChanged, retainedMessageIds, windowWasTrimmed),
    serverMessageIds: trimMetadataForWindow(record.serverMessageIds, retainedMessageIds, windowWasTrimmed),
    answeredPlanMessageIds: windowWasTrimmed ? new Set([...record.answeredPlanMessageIds].filter((messageId) => retainedMessageIds.has(messageId))) : record.answeredPlanMessageIds,
    assistantResponseKeys: trimMetadataForWindow(record.assistantResponseKeys, retainedMessageIds, windowWasTrimmed),
    latestTurnWithChanges: !windowWasTrimmed || (latestTurnWithChanges && retainedMessageIds.has(latestTurnWithChanges)) ? latestTurnWithChanges : null,
  };
}

function recordWithoutNarrative(record: ConversationCacheState, messages: ConversationCacheState["messages"], window: ReturnType<typeof boundedMessageWindow>): ConversationCacheState {
  const retainedMessageIds = new Set(messages.map((message) => message.id));
  const { windowWasTrimmed, ...bounds } = windowMessageBounds(record, messages, window);
  return {
    ...record,
    messages,
    narrativeByMessage: {},
    ...bounds,
    ...windowMetadata(record, retainedMessageIds, windowWasTrimmed),
  };
}

function activeNarrativeBudget(threadId: string, record: ConversationCacheState, isActive: boolean): { narrativeBudget: number; transientTextBytes: number } {
  const transientTextBytes = isActive ? transientTextByteSizes.get(threadId) ?? 0 : 0;
  const narrativeBudget = isActive
    ? Math.min(CONVERSATION_NARRATIVE_BYTES, Math.max(0, ACTIVE_CONVERSATION_BYTES - transientTextBytes - measureRecord(record)))
    : CONVERSATION_NARRATIVE_BYTES;
  return { narrativeBudget, transientTextBytes };
}

function boundedRecordWithNarrative(
  sourceRecord: ConversationCacheState,
  boundedRecord: ConversationCacheState,
  narrativeBudget: number,
): ConversationCacheState {
  const retainedMessageIds = new Set(boundedRecord.messages.map((message) => message.id));
  return {
    ...boundedRecord,
    narrativeByMessage: pruneNarrative(
      filterMessageMetadata(sourceRecord.narrativeByMessage, retainedMessageIds),
      boundedRecord.messages,
      narrativeBudget,
    ),
  };
}

function prefetchedPageMatchesIdentity(
  entry: PrefetchedHistoryPage,
  identity: ConversationOlderPageIdentity,
): boolean {
  if (entry.before !== identity.cursor.beforeSequence) return false;
  if (!("identity" in entry.page)) return true;
  const pageIdentity = entry.page.identity;
  return pageIdentity.threadId === identity.threadId
    && pageIdentity.cursor.beforeSequence === identity.cursor.beforeSequence
    && pageIdentity.direction === identity.direction
    && pageIdentity.generation === identity.generation
    && pageIdentity.conversationRevision === identity.conversationRevision;
}

function consumedPrefetchedPage(
  page: ConversationOlderPage | ConversationPage,
  identity: ConversationOlderPageIdentity,
): ConversationOlderPage {
  return {
    ...page,
    identity,
    nextCursor: page.hasMore && page.messages.length > 0
      ? { version: 1, beforeSequence: page.messages[0].sequence }
      : null,
  };
}

/** Consume the warm older-history page for the requested cursor. */
export function takePrefetchedHistoryPage(
  identity: ConversationOlderPageIdentity,
): ConversationOlderPage | undefined {
  const entry = prefetchedHistoryCache.get(identity.threadId);
  if (!entry || !prefetchedPageMatchesIdentity(entry, identity)) return undefined;
  prefetchedHistoryCache.delete(identity.threadId);
  prefetchByteSizes.delete(identity.threadId);
  prefetchNarrativeByteSizes.delete(identity.threadId);
  return consumedPrefetchedPage(entry.page, identity);
}

/** Remove a single thread's cached record. No-op when absent. */
export function evictCachedRecord(threadId: string): void {
  cache.delete(threadId);
  prefetchedHistoryCache.delete(threadId);
  recordByteSizes.delete(threadId);
  recordNarrativeByteSizes.delete(threadId);
  prefetchByteSizes.delete(threadId);
  prefetchNarrativeByteSizes.delete(threadId);
}

/** Drop all cached records. Used in tests and on workspace deletion. */
export function clearRecordCache(): void {
  cache.clear();
  prefetchedHistoryCache.clear();
  recordByteSizes.clear();
  recordNarrativeByteSizes.clear();
  prefetchByteSizes.clear();
  prefetchNarrativeByteSizes.clear();
  transientTextByteSizes.clear();
  activeConversationId = null;
}

/** Mark the selected conversation so automatic pressure protects its visible window. */
export function setActiveConversation(threadId: string | null): void {
  activeConversationId = threadId;
  if (threadId) {
    const record = cache.get(threadId);
    const residentBytes = recordByteSizes.get(threadId) ?? 0;
    const transientBytes = transientTextByteSizes.get(threadId) ?? 0;
    if (record && residentBytes + transientBytes > ACTIVE_CONVERSATION_BYTES) {
      const boundedRecord = boundRecord(threadId, record);
      cache.set(threadId, boundedRecord);
      recordByteSizes.set(threadId, measureRecord(boundedRecord));
      recordNarrativeByteSizes.set(
        threadId,
        measureConversationValue(boundedRecord.narrativeByMessage),
      );
    }
  }
  enforceAutomaticByteBudgets();
}

/** Account for live assistant text without retaining a second copy in the record cache. */
export function setConversationTransientTextBytes(threadId: string, bytes: number): void {
  const boundedBytes = Number.isFinite(bytes) ? Math.max(0, Math.floor(bytes)) : 0;
  if (boundedBytes === 0) transientTextByteSizes.delete(threadId);
  else transientTextByteSizes.set(threadId, boundedBytes);

  if (activeConversationId !== threadId) return;
  const record = cache.get(threadId);
  if (!record) return;
  if ((recordByteSizes.get(threadId) ?? 0) + boundedBytes <= ACTIVE_CONVERSATION_BYTES) return;
  const boundedRecord = boundRecord(threadId, record);
  cache.set(threadId, boundedRecord);
  recordByteSizes.set(threadId, measureRecord(boundedRecord));
  recordNarrativeByteSizes.set(
    threadId,
    measureConversationValue(boundedRecord.narrativeByMessage),
  );
}

/** Current encoded residency totals by cache class. */
export function getConversationCacheUsage(): {
  activeBytes: number;
  inactiveBytes: number;
  prefetchedBytes: number;
  narrativeBytes: number;
} {
  let activeBytes = 0;
  let inactiveBytes = 0;
  for (const [threadId] of cache.entries()) {
    const bytes = recordByteSizes.get(threadId) ?? 0;
    if (threadId === activeConversationId) activeBytes += bytes;
    else inactiveBytes += bytes;
  }
  const prefetchedBytes = [...prefetchByteSizes.values()].reduce((total, bytes) => total + bytes, 0);
  const narrativeBytes = [...recordNarrativeByteSizes.values(), ...prefetchNarrativeByteSizes.values()]
    .reduce((total, bytes) => total + bytes, 0);
  activeBytes += activeConversationId
    ? transientTextByteSizes.get(activeConversationId) ?? 0
    : 0;
  return { activeBytes, inactiveBytes, prefetchedBytes, narrativeBytes };
}

/** Apply warning or critical pressure in least-value-first order. */
export function applyConversationMemoryPressure(level: "warning" | "critical"): {
  evictionOrder: Array<"prefetched" | "inactive" | "active">;
  activeTrimmed: boolean;
} {
  const evictionOrder: Array<"prefetched" | "inactive" | "active"> = [];
  while (evictOldestPrefetch()) evictionOrder.push("prefetched");
  const inactiveTarget = level === "critical" ? 0 : INACTIVE_CONVERSATION_BYTES / 2;
  while (getConversationCacheUsage().inactiveBytes > inactiveTarget) {
    if (!evictOldestInactive()) break;
    evictionOrder.push("inactive");
  }
  let activeTrimmed = false;
  if (level === "critical" && activeConversationId) {
    const active = cache.get(activeConversationId);
    if (active) {
      const bounded = boundRecord(
        activeConversationId,
        active,
        CRITICAL_ACTIVE_CONVERSATION_MESSAGE_BYTES,
      );
      activeTrimmed = bounded.messages.length < active.messages.length;
      cache.set(activeConversationId, bounded);
      recordByteSizes.set(activeConversationId, measureRecord(bounded));
      recordNarrativeByteSizes.set(
        activeConversationId,
        measureConversationValue(bounded.narrativeByMessage),
      );
      if (activeTrimmed) evictionOrder.push("active");
    }
  }
  return { evictionOrder, activeTrimmed };
}
