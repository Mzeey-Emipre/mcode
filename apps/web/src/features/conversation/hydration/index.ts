export {
  ThreadHydrator,
  createThreadHydrator,
  registerThreadHydrator,
  getThreadHydrator,
  __resetThreadHydratorForTests,
  MESSAGE_FETCH_SIZE,
  HISTORY_PREFETCH_SIZE,
  HYDRATION_TTL_MS,
  ACTIVE_HYDRATION_MAX_DELAY_MS,
  BACKGROUND_PREFETCH_LIMIT,
} from "./thread-hydrator";
export { SnapshotBuilder, snapshotBuilder } from "./snapshot-builder";
export type { SnapshotBuilderInput, FileChangeFields, ThreadRecordPatch } from "./snapshot-builder";
export {
  cacheRecord,
  cachePrefetchedHistoryPage,
  evictCachedRecord,
  getCachedRecord,
  hasCachedRecord,
  hasPrefetchedHistoryPage,
  takePrefetchedHistoryPage,
  projectConversationCacheState,
  clearRecordCache,
  RECORD_CACHE_SIZE,
  RECORD_MESSAGE_CACHE_SIZE,
} from "./record-cache";
export type { ConversationCacheState } from "./record-cache";
export { AuxiliaryHydrator } from "./auxiliary-hydrator";
export type { AuxiliaryHydratorOptions, AuxiliaryHydratorDeps } from "./auxiliary-hydrator";
export { scheduleDeferredWork } from "./deferred-work";
export type { DeferredWorkHandle, DeferredWorkOptions } from "./deferred-work";
export type {
  HydrateMode,
  ThreadHydratorOptions,
  ThreadHydratorTransport,
  ThreadHydratorDeps,
  ThreadHydratorState,
  ThreadHydratorWriteState,
  PaginatedMessages,
  NarrativeBatchResult,
  HydratorWorkspaceThread,
} from "./types";
