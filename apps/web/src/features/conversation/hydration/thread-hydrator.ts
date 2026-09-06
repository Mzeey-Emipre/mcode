import {
  cachePrefetchedHistoryPage,
  cacheRecord,
  applyConversationMemoryPressure as applyCacheMemoryPressure,
  evictCachedRecord,
  getCachedRecord,
  hasCachedRecord,
  hasPrefetchedHistoryPage,
  projectConversationCacheState,
  takePrefetchedHistoryPage,
} from "./record-cache";
import type { ConversationCacheState } from "./record-cache";
import {
  createEmptyThreadRecord,
  deleteThreadRecord,
  getThreadRecord,
  patchThreadRecord,
  providerNoticeSessionId,
} from "@/stores/thread-record";
import type { ThreadRecord } from "@/stores/thread-record";
import type { GoalLookupResult } from "@mcode/contracts";
import { resolveGoalLookupGoal } from "@/lib/goal-lookup";
import type {
  HydrateMode,
  ThreadHydratorDeps,
  ThreadHydratorOptions,
  ThreadHydratorTransport,
  ThreadHydratorWriteState,
  DisplayHydrationOptions,
} from "./types";
import { SnapshotBuilder, snapshotBuilder } from "./snapshot-builder";
import { AuxiliaryHydrator } from "./auxiliary-hydrator";
import {
  CONVERSATION_OLDER_PAGE_MAX_BYTES,
  type ConversationOlderPage,
  type ConversationOlderPageIdentity,
  type ConversationPage,
  type ConversationTail,
} from "@mcode/contracts";
import { hasRememberedHistoryPosition } from "@/components/chat/scrollPositionMemory";
import {
  recordRunningFetchRequired,
  recordRunningResidentHit,
  recordThreadCommit,
} from "@/lib/thread-switch-telemetry";
import { scheduleDeferredWork } from "./deferred-work";
import type { DeferredWorkHandle } from "./deferred-work";
import { hasResidentContent } from "./resident-content";
import { readConversationRevision } from "./conversation-revision";

interface PendingHistoryPrefetch {
  expectedEpoch: number;
  expectedRevision: number;
  promise: Promise<void>;
}

/** Read the transcript revision that an active page fetch must not replace. */
function conversationRevision(record: ThreadRecord): number {
  return readConversationRevision(record);
}

function mergeMessageMetadata<T>(
  cached: Record<string, T>,
  resident: Record<string, T>,
  retainedMessageIds: Set<string>,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries({ ...cached, ...resident }).filter(([messageId]) => retainedMessageIds.has(messageId)),
  );
}

function findLatestTurnWithChanges(
  messages: ConversationCacheState["messages"],
  persistedFilesChanged: ConversationCacheState["persistedFilesChanged"],
): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message && (persistedFilesChanged[message.id]?.length ?? 0) > 0) {
      return message.id;
    }
  }
  return null;
}

function chooseSettledFileEffectSummary(
  resident: ConversationCacheState["settledFileEffectSummary"],
  cached: ConversationCacheState["settledFileEffectSummary"],
): ConversationCacheState["settledFileEffectSummary"] {
  if (!resident) return cached;
  if (!cached) return resident;
  return resident.revision >= cached.revision ? resident : cached;
}

interface FetchCommitOptions {
  skipPrepare?: boolean;
  fetchLimit?: number;
  prefetchEarlierHistory?: boolean;
}

interface FetchCommitContext {
  epoch: number;
  invalidationGeneration: number;
  conversationRevision: number;
  noticeState: NoticeCollectionSnapshot;
}

interface LoadedActiveConversation {
  page: ConversationPage;
  usedTail: boolean;
  snapshots: Promise<Awaited<ReturnType<ThreadHydratorTransport["listSnapshots"]>>>;
  goalLookup: Promise<GoalLookupResult | null>;
}

function cachedConversationIsNewer(
  resident: ConversationCacheState,
  cached: ConversationCacheState,
): boolean {
  const residentSequence = resident.messages.at(-1)?.sequence;
  const cachedSequence = cached.messages.at(-1)?.sequence;
  return residentSequence == null || (cachedSequence != null && cachedSequence > residentSequence);
}

function mergedConversationMessages(
  cached: ConversationCacheState,
  resident: ConversationCacheState,
  preferResidentAtEqualSequence: boolean,
): ConversationCacheState["messages"] {
  const messagesById = new Map(cached.messages.map((message) => [message.id, message]));
  for (const message of resident.messages) {
    if (preferResidentAtEqualSequence || !messagesById.has(message.id)) messagesById.set(message.id, message);
  }
  return [...messagesById.values()].sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
}

function mergedConversationMetadata(
  cached: ConversationCacheState,
  resident: ConversationCacheState,
  messageIds: Set<string>,
): Pick<ConversationCacheState, "persistedToolCallCounts" | "persistedFilesChanged" | "serverMessageIds" | "narrativeByMessage" | "answeredPlanMessageIds" | "assistantResponseKeys" | "settledFileEffectSummary"> {
  const persistedFilesChanged = mergeMessageMetadata(cached.persistedFilesChanged, resident.persistedFilesChanged, messageIds);
  return {
    persistedToolCallCounts: mergeMessageMetadata(cached.persistedToolCallCounts, resident.persistedToolCallCounts, messageIds),
    persistedFilesChanged,
    serverMessageIds: mergeMessageMetadata(cached.serverMessageIds, resident.serverMessageIds, messageIds),
    narrativeByMessage: mergeMessageMetadata(cached.narrativeByMessage, resident.narrativeByMessage, messageIds),
    answeredPlanMessageIds: new Set([...cached.answeredPlanMessageIds, ...resident.answeredPlanMessageIds].filter((messageId) => messageIds.has(messageId))),
    assistantResponseKeys: mergeMessageMetadata(cached.assistantResponseKeys, resident.assistantResponseKeys, messageIds),
    settledFileEffectSummary: chooseSettledFileEffectSummary(resident.settledFileEffectSummary, cached.settledFileEffectSummary),
  };
}

interface NoticeCollectionSnapshot {
  readonly sessionId: ThreadRecord["noticeSessionId"];
  readonly revision: string;
}

type NoticeCollectionState = Pick<ConversationCacheState, "sessionNotices" | "noticeSessionId">;

function noticeCollectionState(
  record: Pick<ThreadRecord, "sessionNotices" | "noticeSessionId"> | undefined,
): NoticeCollectionState {
  const sessionId = record?.noticeSessionId !== undefined
    ? record.noticeSessionId
    : providerNoticeSessionId(record?.sessionNotices ?? []);
  return { sessionNotices: record?.sessionNotices ?? [], noticeSessionId: sessionId };
}

function hasNoticeCollection(state: NoticeCollectionState): boolean {
  return state.noticeSessionId !== undefined || state.sessionNotices.length > 0;
}

function isExplicitEmptyNoticeSession(state: NoticeCollectionState): boolean {
  return state.noticeSessionId !== undefined && state.sessionNotices.length === 0;
}

function coalesceSessionNotices(
  secondary: NoticeCollectionState,
  preferred: NoticeCollectionState,
): ThreadRecord["sessionNotices"] {
  const noticesByKey = new Map<string, ThreadRecord["sessionNotices"][number]>();
  for (const notice of [...secondary.sessionNotices, ...preferred.sessionNotices]) {
    if ((notice.systemNotice?.sessionId ?? null) !== preferred.noticeSessionId) continue;
    const key = notice.systemNotice?.noticeKey ?? notice.id;
    noticesByKey.delete(key);
    noticesByKey.set(key, notice);
  }
  return [...noticesByKey.values()].slice(-20);
}

function noticeCollectionSnapshot(
  record: Pick<ThreadRecord, "sessionNotices" | "noticeSessionId"> | undefined,
): NoticeCollectionSnapshot {
  const state = noticeCollectionState(record);
  return {
    sessionId: state.noticeSessionId,
    revision: JSON.stringify([
      state.noticeSessionId === undefined ? "unknown" : state.noticeSessionId,
      state.sessionNotices.map((notice) => [notice.id, notice.content, notice.systemNotice]),
    ]),
  };
}

function hasNoticeCollectionChanged(
  current: Pick<ThreadRecord, "sessionNotices" | "noticeSessionId">,
  previous: NoticeCollectionSnapshot,
): boolean {
  const next = noticeCollectionSnapshot(current);
  return next.sessionId !== previous.sessionId || next.revision !== previous.revision;
}

function mergeSessionNotices(
  resident: Pick<ThreadRecord, "sessionNotices" | "noticeSessionId">,
  cached: Pick<ConversationCacheState, "sessionNotices" | "noticeSessionId">,
  preferResident: boolean | undefined,
): Pick<ConversationCacheState, "sessionNotices" | "noticeSessionId"> {
  const residentState = noticeCollectionState(resident);
  const cachedState = noticeCollectionState(cached);
  const preferred = preferResident === false || !hasNoticeCollection(residentState)
    ? cachedState
    : residentState;
  const secondary = preferred === residentState ? cachedState : residentState;
  if (preferred.noticeSessionId === undefined || isExplicitEmptyNoticeSession(preferred)) return preferred;
  if (preferred.noticeSessionId !== secondary.noticeSessionId) return preferred;
  return { ...preferred, sessionNotices: coalesceSessionNotices(secondary, preferred) };
}

/** Merge transcript and session diagnostics using their separate freshness evidence. */
function mergeResidentConversationCacheState(
  resident: ThreadRecord,
  cached: ConversationCacheState,
  options: { preferResidentMessages?: boolean; preferResidentNotices?: boolean } = {},
): ConversationCacheState {
  const residentCacheState = projectConversationCacheState(resident);
  const noticeState = mergeSessionNotices(resident, cached, options.preferResidentNotices);
  if (cachedConversationIsNewer(residentCacheState, cached)) return { ...cached, ...noticeState };
  const messages = mergedConversationMessages(cached, residentCacheState, options.preferResidentMessages ?? true);
  const retainedMessageIds = new Set(messages.map((message) => message.id));
  const metadata = mergedConversationMetadata(cached, residentCacheState, retainedMessageIds);

  return {
    ...cached,
    ...residentCacheState,
    messages,
    ...noticeState,
    oldestLoadedSequence: messages[0]?.sequence ?? residentCacheState.oldestLoadedSequence,
    newestLoadedSequence: messages.at(-1)?.sequence ?? residentCacheState.newestLoadedSequence,
    hasMoreMessages: cached.hasMoreMessages || residentCacheState.hasMoreMessages,
    hasNewerMessages: cached.hasNewerMessages || residentCacheState.hasNewerMessages,
    ...metadata,
    latestTurnWithChanges: findLatestTurnWithChanges(messages, metadata.persistedFilesChanged),
  };
}

/** Build a conversation page containing only the supplied messages and their metadata. */
function buildConversationPageSubset(
  page: ConversationPage,
  messages: ConversationPage["messages"],
  hasMore: boolean,
): ConversationPage {
  const messageIds = new Set(messages.map((message) => message.id));
  return {
    messages,
    sessionNotices: page.sessionNotices,
    hasMore,
    answeredPlanMessageIds: page.answeredPlanMessageIds?.filter((id) => messageIds.has(id)),
    narrativeByMessage: Object.fromEntries(
      Object.entries(page.narrativeByMessage).filter(([messageId]) => messageIds.has(messageId)),
    ),
  };
}

function normalizeTailMessages(tail: ConversationTail): ConversationPage["messages"] {
  return tail.messages.map((message) => ({
    ...message,
    tool_calls: null,
    files_changed: null,
  }));
}

function residentActiveFetchOptions(hasResidentContent: boolean): {
  skipPrepare: true;
  fetchLimit: number;
  prefetchEarlierHistory: true;
} | undefined {
  return hasResidentContent
    ? { skipPrepare: true, fetchLimit: MESSAGE_FETCH_SIZE, prefetchEarlierHistory: true }
    : undefined;
}

/** Latest messages fetched before the selected thread first paints. */
export const MESSAGE_FETCH_SIZE = 2;

/** Maximum messages retained across the tail and warmed older-history page. */
export const BACKGROUND_PREFETCH_LIMIT = 100;

/** Older messages warmed after first paint and held outside live React state. */
export const HISTORY_PREFETCH_SIZE = BACKGROUND_PREFETCH_LIMIT - MESSAGE_FETCH_SIZE;

/** Auxiliary side-effect refresh TTL (permissions, tasks, plans). */
export const HYDRATION_TTL_MS = 2000;

/** Maximum time auxiliary work may wait for an active hydration to settle. */
export const ACTIVE_HYDRATION_MAX_DELAY_MS = 500;

/**
 * Owns the full "load this thread" flow: cache lookup, RPC fetch, record
 * commit, auxiliary fanout, and narrative prefetch.
 */
export class ThreadHydrator {
  private readonly auxiliaryHydrator: AuxiliaryHydrator;
  private readonly activeHydrates = new Map<string, Promise<void>>();
  private readonly backgroundHydrates = new Map<string, Promise<void>>();
  private readonly residentHydrates = new Map<string, Promise<void>>();
  private readonly residentHydrateGenerations = new Map<string, number>();
  private readonly pendingHistoryPrefetches = new Map<string, PendingHistoryPrefetch>();
  private readonly deferredWork = new Map<string, DeferredWorkHandle>();
  private readonly invalidationGenerations = new Map<string, number>();
  private readonly activeHydrationWaiters = new Set<() => void>();

  constructor(private readonly deps: ThreadHydratorDeps) {
    this.auxiliaryHydrator = new AuxiliaryHydrator({
      getTransport: deps.getTransport,
      getState: deps.getState,
      setState: deps.setState,
      getWorkspaceThread: deps.getWorkspaceThread,
      getTasksForThread: deps.getTasksForThread,
      setTasksForThread: deps.setTasksForThread,
      addPlanForThread: deps.addPlanForThread,
      shallowEqualBy: deps.shallowEqualBy,
      coerceTaskStatus: deps.coerceTaskStatus,
    });
  }

  private transport(): ThreadHydratorTransport {
    return this.deps.getTransport();
  }

  /**
   * Load a thread's in-memory record.
   * Active mode commits to the live store; background mode writes the cache only.
   */
  async hydrate(
    threadId: string,
    mode: HydrateMode,
    opts?: ThreadHydratorOptions,
  ): Promise<void> {
    if (mode === "background") {
      await this.hydrateBackground(threadId);
      return;
    }
    await this.hydrateActive(threadId, opts);
  }

  /** Hydrate a leased transcript without changing selected workspace state. */
  async hydrateResident(threadId: string, opts: DisplayHydrationOptions): Promise<void> {
    if (!opts.isCurrent()) return;
    if (await this.awaitResidentHydration(threadId, opts)) return;
    if (this.restoreResidentContent(threadId, opts)) return;
    await this.startResidentHydration(threadId, opts);
  }

  private async awaitResidentHydration(threadId: string, opts: DisplayHydrationOptions): Promise<boolean> {
    const existing = this.residentHydrates.get(threadId);
    if (!existing) return false;
    await existing;
    if (this.residentHydrateGenerations.get(threadId) !== opts.generation && opts.isCurrent()) {
      await this.hydrateResident(threadId, opts);
    }
    return true;
  }

  private restoreResidentContent(threadId: string, opts: DisplayHydrationOptions): boolean {
    const resident = this.deps.getState().records.get(threadId);
    if (resident && hasResidentContent(resident) && !opts.force) {
      this.synchronizeConversation(threadId);
      return true;
    }
    const cached = getCachedRecord(threadId);
    if (!cached || opts.force || (cached.messages.length === 0 && cached.lastHydratedAt === undefined)) return false;
    if (!opts.isCurrent()) return true;
    this.restoreFromCache(threadId, this.compactCachedRecordForRestore(threadId, cached), {
      bumpLoadEpoch: true,
      select: false,
    });
    this.synchronizeConversation(threadId);
    return true;
  }

  private async startResidentHydration(threadId: string, opts: DisplayHydrationOptions): Promise<void> {
    const hydration = this.fetchResidentAndCommit(threadId, opts).finally(() => {
      if (this.residentHydrates.get(threadId) === hydration) {
        this.residentHydrates.delete(threadId);
        this.residentHydrateGenerations.delete(threadId);
      }
      this.pruneInvalidationGeneration(threadId);
    });
    this.residentHydrates.set(threadId, hydration);
    this.residentHydrateGenerations.set(threadId, opts.generation);
    await hydration;
  }

  /** Finalize a released display transcript and prevent late responses from restoring it. */
  releaseResident(threadId: string, generation: number, isCurrent: () => boolean): void {
    if (isCurrent()) return;
    const activeGeneration = this.residentHydrateGenerations.get(threadId);
    if (activeGeneration !== undefined && activeGeneration !== generation) return;
    this.cancelDeferredForThread(threadId);
    this.invalidationGenerations.set(
      threadId,
      (this.invalidationGenerations.get(threadId) ?? 0) + 1,
    );
    const state = this.deps.getState();
    const record = state.records.get(threadId);
    if (record) cacheRecord(threadId, projectConversationCacheState(record));
    this.deps.setState((latest: ThreadHydratorWriteState) => {
      if (latest.currentThreadId === threadId || this.deps.isDisplayConversationVisible?.(threadId)) {
        return {};
      }
      return { records: deleteThreadRecord(latest.records, threadId) };
    });
    void generation;
  }

  /** Fetch and commit one leased transcript while preserving the selected parent. */
  private async fetchResidentAndCommit(
    threadId: string,
    opts: DisplayHydrationOptions,
  ): Promise<void> {
    const stateBeforeLoad = this.deps.getState();
    const currentBeforeLoad = getThreadRecord(stateBeforeLoad.records, threadId);
    const expectedEpoch = currentBeforeLoad.loadEpoch + 1;
    const expectedInvalidationGeneration = this.invalidationGenerations.get(threadId) ?? 0;
    const hasContent = hasResidentContent(currentBeforeLoad);
    this.deps.setState((state: ThreadHydratorWriteState) => {
      if (!opts.isCurrent()) return {};
      return {
        records: patchThreadRecord(state.records, threadId, {
          ...(hasContent ? {} : { loading: true }),
          error: null,
          loadEpoch: expectedEpoch,
          settings: this.deps.getWorkspaceThreadSettings(threadId),
        }),
      };
    });

    try {
      const page = await this.transport().loadConversationPage(threadId, MESSAGE_FETCH_SIZE);
      const stateAtCommit = this.deps.getState();
      const currentAtCommit = getThreadRecord(stateAtCommit.records, threadId);
      if (
        !opts.isCurrent()
        || currentAtCommit.loadEpoch !== expectedEpoch
        || (this.invalidationGenerations.get(threadId) ?? 0) !== expectedInvalidationGeneration
      ) return;

      const patch = snapshotBuilder.build({
        messages: page.messages,
        sessionNotices: page.sessionNotices,
        hasMore: page.hasMore,
        answeredPlanMessageIds: page.answeredPlanMessageIds,
      });
      this.deps.setState((state: ThreadHydratorWriteState) => {
        if (!opts.isCurrent()) return {};
        const current = getThreadRecord(state.records, threadId);
        if (
          current.loadEpoch !== expectedEpoch
          || (this.invalidationGenerations.get(threadId) ?? 0) !== expectedInvalidationGeneration
        ) return {};
        const fetchedConversation = projectConversationCacheState({
          ...createEmptyThreadRecord(),
          ...patch,
          narrativeByMessage: page.narrativeByMessage,
        });
        const conversation = mergeResidentConversationCacheState(current, fetchedConversation, {
          preferResidentMessages: false,
          preferResidentNotices: hasNoticeCollectionChanged(current, noticeCollectionSnapshot(currentBeforeLoad)),
        });
        const { settledFileEffectSummary, ...conversationFields } = conversation;
        return {
          records: patchThreadRecord(state.records, threadId, {
            ...conversationFields,
            ...(!current.fileEffectTurnId && settledFileEffectSummary
              ? { fileEffectSummary: settledFileEffectSummary }
              : {}),
            loading: false,
            isLoadingMore: false,
            isLoadingNewer: false,
            lastHydratedAt: Date.now(),
            settings: this.deps.getWorkspaceThreadSettings(threadId),
          }),
        };
      });
      const committed = this.deps.getState().records.get(threadId);
      if (committed && opts.isCurrent()) this.synchronizeConversation(threadId);
    } catch (error) {
      if (!opts.isCurrent()) return;
      this.deps.setState((state: ThreadHydratorWriteState) => {
        const current = getThreadRecord(state.records, threadId);
        if (current.loadEpoch !== expectedEpoch) return {};
        return {
          records: patchThreadRecord(state.records, threadId, {
            error: String(error),
            loading: false,
          }),
        };
      });
    }
  }

  /** Return whether any active transcript hydration is currently in flight. */
  isActiveHydrationInFlight(): boolean {
    return this.activeHydrates.size > 0;
  }

  private notifyActiveHydrationSettled(): void {
    if (this.isActiveHydrationInFlight()) return;
    const waiters = [...this.activeHydrationWaiters];
    this.activeHydrationWaiters.clear();
    for (const waiter of waiters) waiter();
  }

  private waitForActiveHydration(maxDelayMs = ACTIVE_HYDRATION_MAX_DELAY_MS): Promise<void> {
    if (!this.isActiveHydrationInFlight()) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.activeHydrationWaiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, maxDelayMs);
      this.activeHydrationWaiters.add(finish);
    });
  }

  private cancelDeferredForThread(threadId: string): void {
    for (const [key, handle] of this.deferredWork) {
      if (key === threadId || key.startsWith(`${threadId}:`)) {
        handle.cancel();
        this.deferredWork.delete(key);
      }
    }
  }

  /** Retain an inactive resident transcript through the bounded conversation cache. */
  retainInactiveConversation(threadId: string): void {
    const state = this.deps.getState();
    if (state.currentThreadId === threadId) return;
    cacheRecord(threadId, projectConversationCacheState(getThreadRecord(state.records, threadId)));
  }

  /** Apply cache pressure and project a critically trimmed active window into live state. */
  applyMemoryPressure(level: "warning" | "critical"): void {
    const activeThreadId = this.deps.getState().currentThreadId;
    if (activeThreadId) {
      const activeRecord = getThreadRecord(this.deps.getState().records, activeThreadId);
      cacheRecord(activeThreadId, projectConversationCacheState(activeRecord));
    }
    const result = applyCacheMemoryPressure(level);
    if (!activeThreadId || !result.activeTrimmed) return;
    const bounded = getCachedRecord(activeThreadId);
    if (bounded) this.restoreFromCache(activeThreadId, bounded, { bumpLoadEpoch: false });
  }

  /** Discard a stale cached conversation before an authoritative mutation. */
  invalidateConversation(threadId: string): void {
    this.auxiliaryHydrator.invalidatePermissions(threadId);
    this.cancelDeferredForThread(threadId);
    if (
      this.activeHydrates.has(threadId)
      || this.backgroundHydrates.has(threadId)
      || this.residentHydrates.has(threadId)
    ) {
      this.invalidationGenerations.set(
        threadId,
        (this.invalidationGenerations.get(threadId) ?? 0) + 1,
      );
    }
    evictCachedRecord(threadId);
    this.deps.setState((state: ThreadHydratorWriteState) => {
      if (!state.records.has(threadId)) return {};
      return {
        records: patchThreadRecord(state.records, threadId, (record) => ({
          loading: false,
          isLoadingMore: false,
          isLoadingNewer: false,
          loadEpoch: record.loadEpoch + 1,
        })),
      };
    });
  }

  /** Invalidate permission snapshots when live request state changes. */
  invalidatePermissionSnapshots(threadId: string): void {
    this.auxiliaryHydrator.invalidatePermissions(threadId);
  }

  /** Release per-thread generation state after its resident record is deleted. */
  forgetThread(threadId: string): void {
    this.auxiliaryHydrator.forgetThread(threadId);
  }

  private pruneInvalidationGeneration(threadId: string): void {
    if (
      !this.activeHydrates.has(threadId)
      && !this.backgroundHydrates.has(threadId)
      && !this.residentHydrates.has(threadId)
    ) {
      this.invalidationGenerations.delete(threadId);
    }
  }

  /** Synchronize the current resident conversation into its bounded cache entry. */
  synchronizeConversation(threadId: string): void {
    const record = this.deps.getState().records.get(threadId);
    if (record) cacheRecord(threadId, projectConversationCacheState(record));
  }

  /** Merge delayed file metadata only when the current cache still retains those messages. */
  mergeCachedFileChanges(threadId: string, filesChanged: Record<string, string[]>): void {
    const cached = getCachedRecord(threadId);
    if (!cached) return;
    const retainedMessageIds = new Set(cached.messages.map((message) => message.id));
    const retainedChanges = Object.fromEntries(
      Object.entries(filesChanged).filter(([messageId]) => retainedMessageIds.has(messageId)),
    );
    if (Object.keys(retainedChanges).length === 0) return;
    cacheRecord(threadId, {
      ...cached,
      persistedFilesChanged: { ...cached.persistedFilesChanged, ...retainedChanges },
    });
  }

  /** Consume a warmed older-history page through the conversation cache. */
  takePrefetchedHistoryPage(
    identity: ConversationOlderPageIdentity,
  ): ConversationOlderPage | undefined {
    return takePrefetchedHistoryPage(identity);
  }

  /** Retire the selected conversation when no thread remains active. */
  deactivate(): void {
    const threadId = this.deps.getState().currentThreadId;
    if (!threadId) return;

    this.auxiliaryHydrator.invalidatePermissions(threadId);
    this.deps.flushPendingTextDeltas();
    const hadActiveHydrate = this.activeHydrates.has(threadId);
    this.deps.setState((state: ThreadHydratorWriteState) => {
      if (state.currentThreadId !== threadId) return {};
      return {
        records: patchThreadRecord(state.records, threadId, (record) => ({
          loading: false,
          isLoadingMore: false,
          isLoadingNewer: false,
          loadEpoch: record.loadEpoch + 1,
        })),
        currentThreadId: null,
      };
    });
    this.retireInactiveRecord(threadId, hadActiveHydrate);
  }

  /** Speculative cache warm on sidebar hover — no live-store mutation. */
  private async hydrateBackground(threadId: string): Promise<void> {
    if (hasCachedRecord(threadId)) return;

    const active = this.activeHydrates.get(threadId);
    if (active) {
      await active;
      return;
    }

    const inFlight = this.backgroundHydrates.get(threadId);
    if (inFlight) {
      await inFlight;
      return;
    }

    if (this.isActiveHydrationInFlight()) {
      await this.waitForActiveHydration();
      if (hasCachedRecord(threadId)) return;
      const activeAfterWait = this.activeHydrates.get(threadId);
      if (activeAfterWait) {
        await activeAfterWait;
        return;
      }
      const backgroundAfterWait = this.backgroundHydrates.get(threadId);
      if (backgroundAfterWait) {
        await backgroundAfterWait;
        return;
      }
    }

    const hydrate = this.fetchAndCacheBackground(threadId).finally(() => {
      if (this.backgroundHydrates.get(threadId) === hydrate) {
        this.backgroundHydrates.delete(threadId);
      }
      this.pruneInvalidationGeneration(threadId);
    });
    this.backgroundHydrates.set(threadId, hydrate);
    await hydrate;
  }

  /** Cache-only fetch used by sidebar hover prefetches. */
  private async fetchAndCacheBackground(threadId: string): Promise<void> {
    const noticeStateBeforeFetch = noticeCollectionSnapshot(this.deps.getState().records.get(threadId));
    try {
      const workspaceThread = this.deps.getWorkspaceThread(threadId);
      const shouldFetchSnapshots = workspaceThread?.has_file_changes !== false;

      const [pageResult, snapshots] = await Promise.all([
        this.transport().loadConversationPage(threadId, MESSAGE_FETCH_SIZE),
        shouldFetchSnapshots
          ? this.transport().listSnapshots(threadId).catch(() => [] as Awaited<ReturnType<ThreadHydratorTransport["listSnapshots"]>>)
        : Promise.resolve([] as Awaited<ReturnType<ThreadHydratorTransport["listSnapshots"]>>),
      ]);
      const tailPage = pageResult;
      const patch = snapshotBuilder.build({
        messages: tailPage.messages,
        sessionNotices: tailPage.sessionNotices,
        hasMore: tailPage.hasMore,
        answeredPlanMessageIds: tailPage.answeredPlanMessageIds,
        snapshots,
      });

      const record: ThreadRecord = {
        ...createEmptyThreadRecord(),
        ...patch,
        narrativeByMessage: tailPage.narrativeByMessage,
        settings: this.deps.getWorkspaceThreadSettings(threadId),
      };
      const cachedRecord = projectConversationCacheState(record);
      const resident = this.deps.getState().records.get(threadId);
      if (resident) {
        cacheRecord(threadId, mergeResidentConversationCacheState(resident, cachedRecord, {
          preferResidentNotices: hasNoticeCollectionChanged(resident, noticeStateBeforeFetch),
        }));
        return;
      }
      if (hasCachedRecord(threadId)) return;

      cacheRecord(threadId, cachedRecord);
    } catch {
      // Background prefetch is speculative; swallow errors silently.
    }
  }

  /** Active-thread load invoked from ChatView and workspaceStore. */
  private async hydrateActive(threadId: string, opts?: ThreadHydratorOptions): Promise<void> {
    const residentContent = this.prepareActiveThreadSelection(threadId);
    const inFlight = this.activeHydrates.get(threadId);
    if (inFlight) {
      await this.joinActiveHydration(threadId, opts, residentContent, inFlight);
      return;
    }
    if (this.restoreActiveCache(threadId, opts)) return;
    if (this.refreshRunningResident(threadId, opts, residentContent)) return;
    if (this.deps.getState().runningThreadIds.has(threadId)) recordRunningFetchRequired(threadId);
    await this.startActiveHydration(threadId, opts, residentContent);
  }

  private prepareActiveThreadSelection(threadId: string): boolean {
    const outgoingThreadId = this.deps.getState().currentThreadId;
    if (outgoingThreadId && outgoingThreadId !== threadId) {
      this.cancelDeferredForThread(outgoingThreadId);
    }
    const outgoingHydrate = outgoingThreadId
      ? this.activeHydrates.get(outgoingThreadId)
      : undefined;
    queueMicrotask(() => {
      this.deps.flushPendingTextDeltas();
    });
    // React records the outgoing viewport in a layout effect. Retiring on the
    // next frame lets that posture choose full-history or compact-tail caching.
    const retireOutgoingRecord = () => {
      if (outgoingThreadId && outgoingThreadId !== threadId) {
        this.retireInactiveRecord(outgoingThreadId, outgoingHydrate != null);
      }
    };
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(retireOutgoingRecord);
    } else {
      setTimeout(retireOutgoingRecord, 0);
    }

    const resident = this.deps.getState().records.get(threadId);
    const residentContent = resident != null && hasResidentContent(resident);
    if (residentContent && this.deps.getState().runningThreadIds.has(threadId)) {
      recordRunningResidentHit(threadId);
    }
    return residentContent;
  }

  private async joinActiveHydration(
    threadId: string,
    opts: ThreadHydratorOptions | undefined,
    residentContent: boolean,
    inFlight: Promise<void>,
  ): Promise<void> {
    this.selectInFlightLayer(threadId, residentContent);
    await inFlight;
    const state = this.deps.getState();
    const current = getThreadRecord(state.records, threadId);
    if (state.currentThreadId === threadId && current.loading && !hasCachedRecord(threadId)) {
      await this.hydrateActive(threadId, opts);
    }
  }

  private restoreActiveCache(threadId: string, opts: ThreadHydratorOptions | undefined): boolean {
    const cached = getCachedRecord(threadId);
    if (!cached || opts?.force) return false;
    const resident = this.deps.getState().records.get(threadId);
    this.restoreCachedActive(threadId, resident ? mergeResidentConversationCacheState(resident, cached) : cached, opts);
    return true;
  }

  private refreshRunningResident(threadId: string, opts: ThreadHydratorOptions | undefined, residentContent: boolean): boolean {
    if (!residentContent) return false;
    this.activateResidentLayer(threadId);
    if (!this.deps.getState().runningThreadIds.has(threadId) || opts?.force) return false;
    const expectedEpoch = getThreadRecord(this.deps.getState().records, threadId).loadEpoch;
    this.synchronizeConversation(threadId);
    void this.refreshThreadGoal(threadId, expectedEpoch);
    this.scheduleAuxiliaryHydration(threadId, expectedEpoch, {
      freshnessTtlMs: HYDRATION_TTL_MS,
      force: opts?.force ?? false,
      commitFileChangesToStore: true,
      expectedLoadEpoch: expectedEpoch,
    });
    return true;
  }

  private async startActiveHydration(threadId: string, opts: ThreadHydratorOptions | undefined, residentContent: boolean): Promise<void> {
    const hydrate = this.fetchActiveReusingBackground(threadId, opts, residentContent).finally(() => {
      if (this.activeHydrates.get(threadId) === hydrate) {
        this.activeHydrates.delete(threadId);
        this.discardInactiveLoadingRecord(threadId);
        this.notifyActiveHydrationSettled();
      }
      this.pruneInvalidationGeneration(threadId);
    });
    this.activeHydrates.set(threadId, hydrate);
    await hydrate;
  }

  /** Move an inactive transcript under the bounded LRU and compact tail readers. */
  private retireInactiveRecord(threadId: string, hadActiveHydrate: boolean): void {
    const state = this.deps.getState();
    if (state.currentThreadId === threadId) return;
    if (this.deps.isDisplayConversationVisible?.(threadId)) return;
    const resident = state.records.get(threadId);
    if (!resident) return;
    if (
      !hasResidentContent(resident)
      && (hadActiveHydrate || this.activeHydrates.has(threadId))
    ) return;

    const cached = this.compactCachedRecordForRestore(
      threadId,
      projectConversationCacheState(resident),
    );
    cacheRecord(threadId, cached);
    this.deps.setState((latest: ThreadHydratorWriteState) => {
      if (latest.currentThreadId === threadId) return {};
      if (latest.runningThreadIds.has(threadId)) {
        return {
          records: patchThreadRecord(latest.records, threadId, cached),
        };
      }
      return {
        records: deleteThreadRecord(latest.records, threadId),
      };
    });
  }

  /** Remove an inactive empty loading shell after its hydrate result was discarded. */
  private discardInactiveLoadingRecord(threadId: string): void {
    this.deps.setState((state: ThreadHydratorWriteState) => {
      if (state.currentThreadId === threadId) return {};
      const resident = state.records.get(threadId);
      if (!resident || hasResidentContent(resident)) return {};
      return { records: deleteThreadRecord(state.records, threadId) };
    });
  }

  /** Makes a retained thread record visible while an existing background fetch settles. */
  private activateResidentLayer(threadId: string): void {
    this.deps.setState((state: ThreadHydratorWriteState) => {
      const current = getThreadRecord(state.records, threadId);
      return {
        records: patchThreadRecord(state.records, threadId, {
          loading: false,
          error: null,
          isLoadingMore: false,
          isLoadingNewer: false,
          loadEpoch: current.loadEpoch + 1,
          settings: this.deps.getWorkspaceThreadSettings(threadId),
        }),
        currentThreadId: threadId,
      };
    });
  }

  /** Active-thread cache miss path, reusing hover prefetches when available. */
  private async fetchActiveReusingBackground(
    threadId: string,
    opts?: ThreadHydratorOptions,
    hasResidentContent = false,
  ): Promise<void> {
    const residentFetchOptions = residentActiveFetchOptions(hasResidentContent);
    const background = this.backgroundHydrates.get(threadId);
    if (background) return this.reuseBackgroundHydration(threadId, opts, hasResidentContent, residentFetchOptions, background);
    await this.fetchAndCommit(threadId, opts, residentFetchOptions);
  }

  private async reuseBackgroundHydration(
    threadId: string,
    opts: ThreadHydratorOptions | undefined,
    hasResidentContent: boolean,
    residentFetchOptions: { skipPrepare: true; fetchLimit: number; prefetchEarlierHistory: true } | undefined,
    background: Promise<void>,
  ): Promise<void> {
    if (!hasResidentContent) this.selectInFlightLayer(threadId, false);
    await background;
    if (this.deps.getState().currentThreadId !== threadId) return;
    if (opts?.force) return this.fetchAndCommit(threadId, opts, residentFetchOptions ?? { skipPrepare: true });
    const cached = getCachedRecord(threadId);
    if (!cached) return this.fetchAndCommit(threadId, opts, { skipPrepare: true });
    const resident = this.deps.getState().records.get(threadId);
    this.restoreCachedActive(threadId, resident ? mergeResidentConversationCacheState(resident, cached) : cached, opts, { bumpLoadEpoch: false });
  }

  /** Makes an already-loading thread current without invalidating its request epoch. */
  private selectInFlightLayer(threadId: string, hasResidentContent: boolean): void {
    this.deps.setState((state: ThreadHydratorWriteState) => ({
      records: patchThreadRecord(state.records, threadId, {
        loading: !hasResidentContent,
        error: null,
        settings: this.deps.getWorkspaceThreadSettings(threadId),
      }),
      currentThreadId: threadId,
    }));
  }

  /** Restore cached data to the active store and refresh auxiliary data. */
  private restoreCachedActive(
    threadId: string,
    cached: ConversationCacheState,
    opts?: ThreadHydratorOptions,
    restoreOpts?: { bumpLoadEpoch?: boolean },
  ): void {
    const renderableCachedRecord = this.compactCachedRecordForRestore(threadId, cached);
    this.restoreFromCache(threadId, renderableCachedRecord, restoreOpts);
    recordThreadCommit(threadId, "cache-restore");
    const expectedEpoch = getThreadRecord(this.deps.getState().records, threadId).loadEpoch;
    void this.refreshThreadGoal(threadId, expectedEpoch);
    this.scheduleAuxiliaryHydration(threadId, expectedEpoch, {
      freshnessTtlMs: HYDRATION_TTL_MS,
      force: opts?.force,
      commitFileChangesToStore: true,
      expectedLoadEpoch: expectedEpoch,
    });
    if (
      renderableCachedRecord.hasMoreMessages &&
      renderableCachedRecord.messages.length < BACKGROUND_PREFETCH_LIMIT
    ) {
      this.scheduleEarlierHistoryPrefetch(threadId, renderableCachedRecord);
    }
  }

  /** Run auxiliary fanout after the first paint, unless this selection is superseded. */
  private scheduleAuxiliaryHydration(
    threadId: string,
    expectedEpoch: number,
    options: Parameters<AuxiliaryHydrator["hydrate"]>[1],
  ): void {
    this.deferredWork.get(threadId)?.cancel();
    let cancelled = false;
    let waitingForActive = false;
    let waitDeadline: ReturnType<typeof setTimeout> | undefined;
    let resume: (() => void) | undefined;
    const startedAt = Date.now();
    const run = (allowActive = false) => {
      if (cancelled) return;
      if (!allowActive && this.isActiveHydrationInFlight()) {
        if (waitingForActive) return;
        waitingForActive = true;
        resume = () => run(false);
        this.activeHydrationWaiters.add(resume);
        waitDeadline = setTimeout(
          () => run(true),
          Math.max(0, ACTIVE_HYDRATION_MAX_DELAY_MS - (Date.now() - startedAt)),
        );
        return;
      }
      waitingForActive = false;
      if (resume) this.activeHydrationWaiters.delete(resume);
      if (waitDeadline !== undefined) clearTimeout(waitDeadline);
      const state = this.deps.getState();
      const record = getThreadRecord(state.records, threadId);
      if (state.currentThreadId !== threadId || record.loadEpoch !== expectedEpoch) {
        this.deferredWork.delete(threadId);
        return;
      }
      this.auxiliaryHydrator.hydrate(threadId, options);
      this.deferredWork.delete(threadId);
    };
    const initial = scheduleDeferredWork(() => run(), { maxDelayMs: 100 });
    const handle: DeferredWorkHandle = {
      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        initial.cancel();
        if (resume) this.activeHydrationWaiters.delete(resume);
        if (waitDeadline !== undefined) clearTimeout(waitDeadline);
      },
      get cancelled() {
        return cancelled || initial.cancelled;
      },
    };
    this.deferredWork.set(threadId, handle);
  }

  /** Keep cache-hit reconciliation bounded while retaining loaded history for upward pagination. */
  private compactCachedRecordForRestore(
    threadId: string,
    cached: ConversationCacheState,
  ): ConversationCacheState {
    cacheRecord(threadId, cached);
    const bounded = getCachedRecord(threadId) ?? cached;
    if (
      bounded.messages.length <= MESSAGE_FETCH_SIZE
      || hasRememberedHistoryPosition(threadId)
    ) {
      return bounded;
    }

    const tailStart = bounded.messages.length - MESSAGE_FETCH_SIZE;
    const earlierMessages = bounded.messages.slice(0, tailStart);
    const retainedEarlierMessages = earlierMessages.slice(-HISTORY_PREFETCH_SIZE);
    const tailMessages = bounded.messages.slice(tailStart);
    const narrativeByMessage: ConversationPage["narrativeByMessage"] = {};
    for (const [messageId, narrative] of Object.entries(bounded.narrativeByMessage)) {
      if (narrative) narrativeByMessage[messageId] = narrative;
    }
    const page: ConversationPage = {
      messages: bounded.messages,
      hasMore: bounded.hasMoreMessages,
      answeredPlanMessageIds: [...bounded.answeredPlanMessageIds],
      narrativeByMessage,
    };
    const tailPage = buildConversationPageSubset(page, tailMessages, true);
    const compacted = {
      ...bounded,
      messages: tailMessages,
      oldestLoadedSequence: tailMessages[0].sequence,
      hasMoreMessages: true,
      narrativeByMessage: tailPage.narrativeByMessage,
      answeredPlanMessageIds: new Set(tailPage.answeredPlanMessageIds ?? []),
    };
    cacheRecord(threadId, compacted);
    cachePrefetchedHistoryPage(
      threadId,
      tailMessages[0].sequence,
      buildConversationPageSubset(
        page,
        retainedEarlierMessages,
        bounded.hasMoreMessages || retainedEarlierMessages.length < earlierMessages.length,
      ),
    );
    return compacted;
  }

  /** Restore cached conversation data without replacing resident live or auxiliary state. */
  private restoreFromCache(
    threadId: string,
    cached: ConversationCacheState,
    opts?: { bumpLoadEpoch?: boolean; select?: boolean },
  ): void {
    this.deps.setState((state: ThreadHydratorWriteState) => {
      const current = getThreadRecord(state.records, threadId);
      const isRunning = state.runningThreadIds.has(threadId);
      const ownsLiveFileEffects = isRunning || current.fileEffectTurnId.length > 0;
      const { settledFileEffectSummary, ...conversation } = cached;
      return {
        records: patchThreadRecord(state.records, threadId, {
          ...conversation,
          ...(!ownsLiveFileEffects && settledFileEffectSummary
            ? { fileEffectSummary: settledFileEffectSummary }
            : {}),
          error: null,
          loading: false,
          loadEpoch: opts?.bumpLoadEpoch === false ? current.loadEpoch : current.loadEpoch + 1,
          isLoadingMore: false,
          isLoadingNewer: false,
          settings: this.deps.getWorkspaceThreadSettings(threadId),
        }),
        ...(opts?.select === false ? {} : { currentThreadId: threadId }),
      };
    });
  }

  /** Apply lookup result semantics to the resident auxiliary record. */
  private applyGoalLookup(
    threadId: string,
    lookup: GoalLookupResult,
    expectedEpoch?: number,
  ): void {
    this.deps.setState((state: ThreadHydratorWriteState) => {
      const current = getThreadRecord(state.records, threadId);
      if (expectedEpoch != null && (
        state.currentThreadId !== threadId
        || current.loadEpoch !== expectedEpoch
      )) {
        return {};
      }
      const goal = resolveGoalLookupGoal(lookup, current.goal);
      return {
        records: patchThreadRecord(state.records, threadId, { goal }),
      };
    });
  }

  /** Merges file-change snapshots only into the load that requested them. */
  private applySnapshots(
    threadId: string,
    snapshots: Awaited<ReturnType<ThreadHydratorTransport["listSnapshots"]>>,
    expectedEpoch: number,
  ): void {
    const fileChanges = SnapshotBuilder.deriveFileChanges(snapshots);
    let applied = false;
    this.deps.setState((state: ThreadHydratorWriteState) => {
      const current = getThreadRecord(state.records, threadId);
      if (state.currentThreadId !== threadId || current.loadEpoch !== expectedEpoch) {
        return {};
      }
      applied = true;
      const ownsLiveFileEffects = current.fileEffectTurnId.length > 0
        || state.runningThreadIds.has(threadId);
      return {
        records: patchThreadRecord(state.records, threadId, {
          persistedFilesChanged: fileChanges.persistedFilesChanged,
          latestTurnWithChanges: fileChanges.latestTurnWithChanges,
          ...(!ownsLiveFileEffects ? { fileEffectSummary: fileChanges.fileEffectSummary } : {}),
        }),
      };
    });

    const cached = getCachedRecord(threadId);
    if (!cached || !applied) return;
    const liveRecord = getThreadRecord(this.deps.getState().records, threadId);
    const ownsLiveFileEffects = liveRecord.fileEffectTurnId.length > 0
      || this.deps.getState().runningThreadIds.has(threadId);
    cacheRecord(threadId, {
      ...cached,
      persistedFilesChanged: fileChanges.persistedFilesChanged,
      latestTurnWithChanges: fileChanges.latestTurnWithChanges,
      ...(!ownsLiveFileEffects
        ? { settledFileEffectSummary: fileChanges.fileEffectSummary }
        : {}),
    });
  }

  /** Refresh one thread's active goal without blocking main hydration. */
  private async refreshThreadGoal(threadId: string, expectedEpoch: number): Promise<void> {
    try {
      const lookup = await this.transport().getThreadGoal(threadId);
      this.applyGoalLookup(threadId, lookup, expectedEpoch);
    } catch {
      // Best-effort hydration: message load remains the authoritative error surface.
    }
  }

  /** Prepare the live record for an active-thread load before the RPC settles. */
  private prepareActiveLoad(threadId: string): void {
    const { getState, setState } = this.deps;
    this.deferredWork.get(threadId)?.cancel();
    this.deferredWork.delete(threadId);
    const isRunning = getState().runningThreadIds.has(threadId);

    if (!isRunning) {
      getState().toolCallRecordCache.clear();
      setState((state: ThreadHydratorWriteState) => {
        const current = getThreadRecord(state.records, threadId);
        return {
          records: patchThreadRecord(state.records, threadId, {
            loading: true,
            error: null,
            messages: [],
            persistedToolCallCounts: {},
            persistedFilesChanged: {},
            latestTurnWithChanges: null,
            isLoadingMore: false,
            isLoadingNewer: false,
            loadEpoch: current.loadEpoch + 1,
            streaming: "",
            streamingPreview: "",
            toolCalls: [],
            currentTurnMessageId: "",
            thoughtSegments: [],
            hooks: [],
            isCompacting: false,
            agentStartTime: undefined,
            settings: this.deps.getWorkspaceThreadSettings(threadId),
          }),
          currentThreadId: threadId,
        };
      });
      return;
    }

    setState((state: ThreadHydratorWriteState) => {
      const current = getThreadRecord(state.records, threadId);
      return {
        records: patchThreadRecord(state.records, threadId, {
          loading: true,
          error: null,
          isLoadingMore: false,
          isLoadingNewer: false,
          loadEpoch: current.loadEpoch + 1,
          settings: this.deps.getWorkspaceThreadSettings(threadId),
        }),
        currentThreadId: threadId,
      };
    });
  }

  /** Cache-miss path: reset volatile state, fetch RPCs, commit, populate cache. */
  private async fetchAndCommit(
    threadId: string,
    opts?: ThreadHydratorOptions,
    commitOpts?: FetchCommitOptions,
  ): Promise<void> {
    const context = this.startFetchCommit(threadId, commitOpts);
    try {
      const loaded = await this.loadActiveConversation(threadId, commitOpts);
      if (!this.fetchCommitContextMatches(threadId, context)) return this.settleDiscardedFetch(threadId, context);
      this.commitFetchedConversation(threadId, loaded.page, context);
      recordThreadCommit(threadId, "network-fetch");
      this.scheduleFetchedConversationAuxiliaries(threadId, opts, context.epoch);
      const tailFollowupInvalidated = loaded.usedTail && await this.hydrateTailNarrative(threadId, context);
      this.publishPendingPlanQuestions(threadId);
      this.cacheFetchedConversation(threadId, context, tailFollowupInvalidated);
      this.applyDeferredFetchResults(threadId, context.epoch, loaded, commitOpts);
    } catch (e) {
      this.failFetchCommit(threadId, e);
    }
  }

  private startFetchCommit(threadId: string, options: FetchCommitOptions | undefined): FetchCommitContext {
    if (!options?.skipPrepare) this.prepareActiveLoad(threadId);
    const record = getThreadRecord(this.deps.getState().records, threadId);
    return {
      epoch: record.loadEpoch,
      invalidationGeneration: this.invalidationGenerations.get(threadId) ?? 0,
      conversationRevision: conversationRevision(record),
      noticeState: noticeCollectionSnapshot(record),
    };
  }

  private async loadActiveConversation(threadId: string, options: FetchCommitOptions | undefined): Promise<LoadedActiveConversation> {
    const shouldFetchSnapshots = this.deps.getWorkspaceThread(threadId)?.has_file_changes !== false;
    const snapshots = shouldFetchSnapshots
      ? this.transport().listSnapshots(threadId).catch(() => [] as Awaited<ReturnType<ThreadHydratorTransport["listSnapshots"]>>)
      : Promise.resolve([] as Awaited<ReturnType<ThreadHydratorTransport["listSnapshots"]>>);
    const goalLookup = this.transport().getThreadGoal(threadId).catch(() => null);
    const requestedLimit = options?.fetchLimit ?? MESSAGE_FETCH_SIZE;
    const tailLoader = this.transport().loadConversationTail;
    const usedTail = tailLoader != null && requestedLimit <= MESSAGE_FETCH_SIZE;
    const page = usedTail && tailLoader
      ? await this.loadConversationTail(threadId, requestedLimit, tailLoader)
      : await this.transport().loadConversationPage(threadId, requestedLimit);
    return { page, usedTail, snapshots, goalLookup };
  }

  private async loadConversationTail(
    threadId: string,
    requestedLimit: number,
    loadTail: NonNullable<ThreadHydratorTransport["loadConversationTail"]>,
  ): Promise<ConversationPage> {
    const tail = await loadTail(threadId, Math.min(requestedLimit, MESSAGE_FETCH_SIZE));
    return { messages: normalizeTailMessages(tail), sessionNotices: tail.sessionNotices, hasMore: tail.hasMore, narrativeByMessage: {} };
  }

  private fetchCommitContextMatches(threadId: string, context: FetchCommitContext): boolean {
    const state = this.deps.getState();
    const record = getThreadRecord(state.records, threadId);
    return state.currentThreadId === threadId
      && record.loadEpoch === context.epoch
      && (this.invalidationGenerations.get(threadId) ?? 0) === context.invalidationGeneration
      && conversationRevision(record) === context.conversationRevision;
  }

  private settleDiscardedFetch(threadId: string, context: FetchCommitContext): void {
    this.deps.setState((state: ThreadHydratorWriteState) => {
      const current = getThreadRecord(state.records, threadId);
      if (state.currentThreadId !== threadId || current.loadEpoch !== context.epoch) return {};
      return { records: patchThreadRecord(state.records, threadId, { loading: false, isLoadingMore: false, isLoadingNewer: false }) };
    });
  }

  private commitFetchedConversation(threadId: string, page: ConversationPage, context: FetchCommitContext): void {
    const patch = snapshotBuilder.build({ messages: page.messages, sessionNotices: page.sessionNotices, hasMore: page.hasMore, answeredPlanMessageIds: page.answeredPlanMessageIds });
    this.deps.setState((state: ThreadHydratorWriteState) => {
      const current = getThreadRecord(state.records, threadId);
      const fetchedConversation = projectConversationCacheState({ ...createEmptyThreadRecord(), ...patch, narrativeByMessage: page.narrativeByMessage });
      const conversation = mergeResidentConversationCacheState(current, fetchedConversation, {
        preferResidentMessages: false,
        preferResidentNotices: hasNoticeCollectionChanged(current, context.noticeState),
      });
      const { settledFileEffectSummary, ...conversationFields } = conversation;
      return {
        records: patchThreadRecord(state.records, threadId, {
          ...conversationFields,
          ...this.committedFileEffectSummary(current, state, threadId, settledFileEffectSummary),
          loading: false,
          isLoadingMore: false,
          isLoadingNewer: false,
          lastHydratedAt: Date.now(),
          settings: this.deps.getWorkspaceThreadSettings(threadId),
        }),
      };
    });
  }

  private committedFileEffectSummary(
    current: ThreadRecord,
    state: ThreadHydratorWriteState,
    threadId: string,
    settledSummary: ConversationCacheState["settledFileEffectSummary"],
  ): Partial<ThreadRecord> {
    const ownsLiveEffects = current.fileEffectTurnId.length > 0 || state.runningThreadIds.has(threadId);
    if (ownsLiveEffects) return { fileEffectSummary: current.fileEffectSummary };
    return settledSummary ? { fileEffectSummary: settledSummary } : {};
  }

  private scheduleFetchedConversationAuxiliaries(threadId: string, opts: ThreadHydratorOptions | undefined, epoch: number): void {
    this.scheduleAuxiliaryHydration(threadId, epoch, {
      freshnessTtlMs: HYDRATION_TTL_MS,
      force: opts?.force ?? true,
      commitFileChangesToStore: true,
      expectedLoadEpoch: epoch,
      skipFileChangeSnapshots: true,
    });
  }

  private currentFetchCommitContext(threadId: string): FetchCommitContext {
    const record = getThreadRecord(this.deps.getState().records, threadId);
    return { epoch: record.loadEpoch, invalidationGeneration: this.invalidationGenerations.get(threadId) ?? 0, conversationRevision: conversationRevision(record), noticeState: noticeCollectionSnapshot(record) };
  }

  private async hydrateTailNarrative(threadId: string, context: FetchCommitContext): Promise<boolean> {
    const tailContext = this.currentFetchCommitContext(threadId);
    if (tailContext.epoch !== context.epoch || tailContext.invalidationGeneration !== context.invalidationGeneration) return true;
    try {
      const narrativePage = await this.transport().loadConversationPage(threadId, MESSAGE_FETCH_SIZE);
      if (!this.fetchCommitContextMatches(threadId, tailContext)) return true;
      this.commitTailNarrative(threadId, tailContext, narrativePage);
      return false;
    } catch {
      return !this.fetchCommitContextMatches(threadId, tailContext);
    }
  }

  private commitTailNarrative(threadId: string, context: FetchCommitContext, page: ConversationPage): void {
    this.deps.setState((state: ThreadHydratorWriteState) => {
      const current = getThreadRecord(state.records, threadId);
      if (!this.fetchCommitContextMatches(threadId, context)) return {};
      const retained = new Set(current.messages.map((message) => message.id));
      return {
        records: patchThreadRecord(state.records, threadId, {
          narrativeByMessage: Object.fromEntries(Object.entries(page.narrativeByMessage).filter(([id]) => retained.has(id))),
          answeredPlanMessageIds: new Set((page.answeredPlanMessageIds ?? []).filter((id) => retained.has(id))),
        }),
      };
    });
  }

  private publishPendingPlanQuestions(threadId: string): void {
    const committed = getThreadRecord(this.deps.getState().records, threadId);
    if (committed.planQuestionsStatus === "pending") return;
    const pendingQuestions = this.deps.extractPendingPlanQuestions(committed.messages, committed.answeredPlanMessageIds);
    if (pendingQuestions) this.deps.setPlanQuestions(threadId, pendingQuestions);
  }

  private cacheFetchedConversation(threadId: string, context: FetchCommitContext, tailFollowupInvalidated: boolean): void {
    const state = this.deps.getState();
    const record = getThreadRecord(state.records, threadId);
    if (tailFollowupInvalidated || state.currentThreadId !== threadId || record.loadEpoch !== context.epoch || (this.invalidationGenerations.get(threadId) ?? 0) !== context.invalidationGeneration) return;
    cacheRecord(threadId, projectConversationCacheState(record));
  }

  private applyDeferredFetchResults(threadId: string, epoch: number, loaded: LoadedActiveConversation, options: FetchCommitOptions | undefined): void {
    void loaded.snapshots.then((snapshots) => this.applySnapshots(threadId, snapshots, epoch));
    void loaded.goalLookup.then((goalLookup) => {
      if (goalLookup) this.applyGoalLookup(threadId, goalLookup, epoch);
    });
    if (options?.prefetchEarlierHistory !== false) this.scheduleEarlierHistoryPrefetch(threadId, loaded.page);
  }

  private failFetchCommit(threadId: string, error: unknown): void {
    if (this.deps.getState().currentThreadId === threadId) {
      this.deps.setState((state: ThreadHydratorWriteState) => ({
        records: patchThreadRecord(state.records, threadId, { error: String(error), loading: false }),
      }));
    }
    evictCachedRecord(threadId);
  }

  /** Defers older history until the browser has had a chance to paint the tail. */
  private scheduleEarlierHistoryPrefetch(
    threadId: string,
    page: Pick<ThreadRecord, "messages"> & { hasMore?: boolean; hasMoreMessages?: boolean },
  ): void {
    if (!(page.hasMore ?? page.hasMoreMessages) || page.messages.length === 0) return;
    const before = page.messages[0].sequence;
    if (hasPrefetchedHistoryPage(threadId, before)) return;
    const epoch = getThreadRecord(this.deps.getState().records, threadId).loadEpoch;
    const prefetchKey = `${threadId}:${before}`;
    let cancelled = false;
    const start = async () => {
      if (cancelled) return;
      await this.waitForActiveHydration();
      if (cancelled) return;
      const state = this.deps.getState();
      if (state.currentThreadId !== threadId) return;
      const record = getThreadRecord(state.records, threadId);
      if (record.loadEpoch !== epoch) return;
      const existing = this.pendingHistoryPrefetches.get(prefetchKey);
      if (existing) return;
      const prefetch: PendingHistoryPrefetch = {
        expectedEpoch: epoch,
        expectedRevision: record.conversationRevision,
        promise: Promise.resolve(),
      };
      prefetch.promise = this.prefetchEarlierHistory(
        threadId,
        before,
        prefetch.expectedEpoch,
        prefetch.expectedRevision,
      ).finally(() => {
        if (this.pendingHistoryPrefetches.get(prefetchKey) === prefetch) {
          this.pendingHistoryPrefetches.delete(prefetchKey);
        }
        this.deferredWork.delete(prefetchKey);
      });
      this.pendingHistoryPrefetches.set(prefetchKey, prefetch);
    };
    const initial = scheduleDeferredWork(() => {
      if (!cancelled) void start();
    }, { maxDelayMs: 100 });
    const deferred: DeferredWorkHandle = {
      cancel: () => {
        cancelled = true;
        initial.cancel();
      },
      get cancelled() {
        return cancelled || initial.cancelled;
      },
    };
    this.deferredWork.set(prefetchKey, deferred);
  }

  /** Cache the older history window without attaching it to live React state. */
  private async prefetchEarlierHistory(
    threadId: string,
    before: number,
    expectedEpoch: number,
    expectedRevision: number,
  ): Promise<void> {
    try {
      const request = {
        threadId,
        cursor: { version: 1 as const, beforeSequence: before },
        direction: "older" as const,
        generation: expectedEpoch,
        conversationRevision: expectedRevision,
        limit: HISTORY_PREFETCH_SIZE,
        maxBytes: CONVERSATION_OLDER_PAGE_MAX_BYTES,
      };
      const page = await this.transport().loadOlderConversationPage(request);
      const state = this.deps.getState();
      const current = getThreadRecord(state.records, threadId);
      if (
        state.currentThreadId !== threadId
        || current.loadEpoch !== expectedEpoch
        || current.conversationRevision !== expectedRevision
        || page.identity.threadId !== request.threadId
        || page.identity.cursor.beforeSequence !== request.cursor.beforeSequence
        || page.identity.direction !== request.direction
        || page.identity.generation !== request.generation
        || page.identity.conversationRevision !== request.conversationRevision
      ) return;

      cachePrefetchedHistoryPage(threadId, before, page);
    } catch {
      // The visible tail is complete; older history remains available on scroll.
    }
  }

}

/** Module-scoped hydrator instance registered by threadStore at init. */
let registeredHydrator: ThreadHydrator | null = null;

/** Register the live hydrator instance for prefetch and other callers. */
export function registerThreadHydrator(hydrator: ThreadHydrator): void {
  registeredHydrator = hydrator;
}

/** Return the registered hydrator; throws if threadStore has not initialized yet. */
export function getThreadHydrator(): ThreadHydrator {
  if (!registeredHydrator) {
    throw new Error("ThreadHydrator not initialized");
  }
  return registeredHydrator;
}

/** Factory for the production hydrator wired from threadStore. */
export function createThreadHydrator(deps: ThreadHydratorDeps): ThreadHydrator {
  return new ThreadHydrator(deps);
}

/** Test-only reset of the module-scoped hydrator pointer. */
export function __resetThreadHydratorForTests(): void {
  registeredHydrator = null;
}
