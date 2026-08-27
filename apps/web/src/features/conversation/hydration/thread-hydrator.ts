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

/** Prefer an equally recent resident update while retaining disjoint cached history. */
function mergeResidentConversationCacheState(
  resident: ThreadRecord,
  cached: ConversationCacheState,
  preferResidentAtEqualSequence = true,
): ConversationCacheState {
  const residentCacheState = projectConversationCacheState(resident);
  const residentSequence = residentCacheState.messages.at(-1)?.sequence;
  const cachedSequence = cached.messages.at(-1)?.sequence;
  if (
    residentSequence == null
    || (cachedSequence != null
      && cachedSequence > residentSequence)
  ) {
    return cached;
  }
  const messagesById = new Map(cached.messages.map((message) => [message.id, message]));
  for (const message of residentCacheState.messages) {
    if (preferResidentAtEqualSequence || !messagesById.has(message.id)) {
      messagesById.set(message.id, message);
    }
  }
  const messages = [...messagesById.values()].sort((left, right) =>
    left.sequence - right.sequence || left.id.localeCompare(right.id),
  );
  const retainedMessageIds = new Set(messages.map((message) => message.id));
  const persistedFilesChanged = mergeMessageMetadata(
    cached.persistedFilesChanged,
    residentCacheState.persistedFilesChanged,
    retainedMessageIds,
  );

  return {
    ...cached,
    ...residentCacheState,
    messages,
    oldestLoadedSequence: messages[0]?.sequence ?? residentCacheState.oldestLoadedSequence,
    newestLoadedSequence: messages.at(-1)?.sequence ?? residentCacheState.newestLoadedSequence,
    hasMoreMessages: cached.hasMoreMessages || residentCacheState.hasMoreMessages,
    hasNewerMessages: cached.hasNewerMessages || residentCacheState.hasNewerMessages,
    persistedToolCallCounts: mergeMessageMetadata(
      cached.persistedToolCallCounts,
      residentCacheState.persistedToolCallCounts,
      retainedMessageIds,
    ),
    persistedFilesChanged,
    latestTurnWithChanges: findLatestTurnWithChanges(messages, persistedFilesChanged),
    serverMessageIds: mergeMessageMetadata(
      cached.serverMessageIds,
      residentCacheState.serverMessageIds,
      retainedMessageIds,
    ),
    narrativeByMessage: mergeMessageMetadata(
      cached.narrativeByMessage,
      residentCacheState.narrativeByMessage,
      retainedMessageIds,
    ),
    answeredPlanMessageIds: new Set(
      [...cached.answeredPlanMessageIds, ...residentCacheState.answeredPlanMessageIds]
        .filter((messageId) => retainedMessageIds.has(messageId)),
    ),
    assistantResponseKeys: mergeMessageMetadata(
      cached.assistantResponseKeys,
      residentCacheState.assistantResponseKeys,
      retainedMessageIds,
    ),
    settledFileEffectSummary: chooseSettledFileEffectSummary(
      residentCacheState.settledFileEffectSummary,
      cached.settledFileEffectSummary,
    ),
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
    const existing = this.residentHydrates.get(threadId);
    if (existing) {
      await existing;
      if (this.residentHydrateGenerations.get(threadId) !== opts.generation && opts.isCurrent()) {
        await this.hydrateResident(threadId, opts);
      }
      return;
    }
    const resident = this.deps.getState().records.get(threadId);
    if (resident && hasResidentContent(resident) && !opts.force) {
      this.synchronizeConversation(threadId);
      return;
    }
    const cached = getCachedRecord(threadId);
    // An empty cache can be a snapshot of a released in-flight display load.
    if (
      cached
      && (cached.messages.length > 0 || cached.lastHydratedAt !== undefined)
      && !opts.force
    ) {
      if (!opts.isCurrent()) return;
      this.restoreFromCache(threadId, this.compactCachedRecordForRestore(threadId, cached), {
        bumpLoadEpoch: true,
        select: false,
      });
      this.synchronizeConversation(threadId);
      return;
    }

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
        const conversation = hasResidentContent(current)
          ? mergeResidentConversationCacheState(current, fetchedConversation, false)
          : fetchedConversation;
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
      if (resident && hasResidentContent(resident)) {
        cacheRecord(threadId, mergeResidentConversationCacheState(resident, cachedRecord));
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

    const inFlight = this.activeHydrates.get(threadId);
    if (inFlight) {
      this.selectInFlightLayer(threadId, residentContent);
      await inFlight;
      const state = this.deps.getState();
      const current = getThreadRecord(state.records, threadId);
      if (state.currentThreadId === threadId && current.loading && !hasCachedRecord(threadId)) {
        await this.hydrateActive(threadId, opts);
      }
      return;
    }

    const cached = getCachedRecord(threadId);
    if (cached && !opts?.force) {
      this.restoreCachedActive(
        threadId,
        resident ? mergeResidentConversationCacheState(resident, cached) : cached,
        opts,
      );
      return;
    }

    if (residentContent) {
      this.activateResidentLayer(threadId);
      if (this.deps.getState().runningThreadIds.has(threadId) && !opts?.force) {
        const expectedEpoch = getThreadRecord(this.deps.getState().records, threadId).loadEpoch;
        this.synchronizeConversation(threadId);
        void this.refreshThreadGoal(threadId, expectedEpoch);
        this.scheduleAuxiliaryHydration(threadId, expectedEpoch, {
          freshnessTtlMs: HYDRATION_TTL_MS,
          force: opts?.force ?? false,
          commitFileChangesToStore: true,
          expectedLoadEpoch: expectedEpoch,
        });
        return;
      }
    }

    if (this.deps.getState().runningThreadIds.has(threadId)) {
      recordRunningFetchRequired(threadId);
    }

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
    const residentFetchOptions = hasResidentContent
      ? {
          skipPrepare: true,
          fetchLimit: MESSAGE_FETCH_SIZE,
          prefetchEarlierHistory: true,
        }
      : undefined;
    const backgroundFetchOptions = residentFetchOptions ?? { skipPrepare: true };
    const background = this.backgroundHydrates.get(threadId);
    if (background) {
      if (!hasResidentContent) {
        this.selectInFlightLayer(threadId, false);
      }
      await background;

      if (this.deps.getState().currentThreadId !== threadId) return;

      if (opts?.force) {
        await this.fetchAndCommit(threadId, opts, backgroundFetchOptions);
        return;
      }

      const cached = getCachedRecord(threadId);
      if (cached) {
        const resident = this.deps.getState().records.get(threadId);
        this.restoreCachedActive(
          threadId,
          resident ? mergeResidentConversationCacheState(resident, cached) : cached,
          opts,
          { bumpLoadEpoch: false },
        );
        return;
      }

      await this.fetchAndCommit(threadId, opts, { skipPrepare: true });
      return;
    }

    await this.fetchAndCommit(threadId, opts, residentFetchOptions);
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
    commitOpts?: {
      skipPrepare?: boolean;
      fetchLimit?: number;
      prefetchEarlierHistory?: boolean;
    },
  ): Promise<void> {
    const { getState, setState } = this.deps;

    if (!commitOpts?.skipPrepare) {
      this.prepareActiveLoad(threadId);
    }
    const expectedEpoch = getThreadRecord(getState().records, threadId).loadEpoch;
    const expectedInvalidationGeneration = this.invalidationGenerations.get(threadId) ?? 0;
    const expectedConversationRevision = conversationRevision(
      getThreadRecord(getState().records, threadId),
    );

    try {
      const workspaceThread = this.deps.getWorkspaceThread(threadId);
      const shouldFetchSnapshots = workspaceThread?.has_file_changes !== false;

      const goalLookupPromise = this.transport().getThreadGoal(threadId).catch(() => null);
      const snapshotsPromise = shouldFetchSnapshots
        ? this.transport().listSnapshots(threadId).catch(() => [] as Awaited<ReturnType<ThreadHydratorTransport["listSnapshots"]>>)
        : Promise.resolve([] as Awaited<ReturnType<ThreadHydratorTransport["listSnapshots"]>>);
      const requestedLimit = commitOpts?.fetchLimit ?? MESSAGE_FETCH_SIZE;
      const tailLoader = this.transport().loadConversationTail;
      const usedTail = tailLoader != null && requestedLimit <= MESSAGE_FETCH_SIZE;
      let pageResult: ConversationPage;
      if (usedTail && tailLoader) {
        const tail = await tailLoader(threadId, Math.min(requestedLimit, MESSAGE_FETCH_SIZE));
        pageResult = {
          messages: normalizeTailMessages(tail),
          hasMore: tail.hasMore,
          narrativeByMessage: {},
        };
      } else {
        pageResult = await this.transport().loadConversationPage(threadId, requestedLimit);
      }

      const stateAtCommit = getState();
      const recordAtCommit = getThreadRecord(stateAtCommit.records, threadId);
      if (
        stateAtCommit.currentThreadId !== threadId
        || recordAtCommit.loadEpoch !== expectedEpoch
        || (this.invalidationGenerations.get(threadId) ?? 0) !== expectedInvalidationGeneration
      ) {
        if (
          stateAtCommit.currentThreadId === threadId
          && recordAtCommit.loadEpoch === expectedEpoch
        ) {
          setState((state: ThreadHydratorWriteState) => {
            const current = getThreadRecord(state.records, threadId);
            if (state.currentThreadId !== threadId || current.loadEpoch !== expectedEpoch) return {};
            return {
              records: patchThreadRecord(state.records, threadId, {
                loading: false,
                isLoadingMore: false,
                isLoadingNewer: false,
              }),
            };
          });
        }
        return;
      }
      if (conversationRevision(recordAtCommit) !== expectedConversationRevision) {
        setState((state: ThreadHydratorWriteState) => {
          const current = getThreadRecord(state.records, threadId);
          if (state.currentThreadId !== threadId || current.loadEpoch !== expectedEpoch) return {};
          return {
            records: patchThreadRecord(state.records, threadId, {
              loading: false,
              isLoadingMore: false,
              isLoadingNewer: false,
            }),
          };
        });
        return;
      }

      const patch = snapshotBuilder.build({
        messages: pageResult.messages,
        hasMore: pageResult.hasMore,
        answeredPlanMessageIds: pageResult.answeredPlanMessageIds,
      });

      setState((state: ThreadHydratorWriteState) => {
        const current = getThreadRecord(state.records, threadId);
        const fetchedConversation = projectConversationCacheState({
          ...createEmptyThreadRecord(),
          ...patch,
          narrativeByMessage: pageResult.narrativeByMessage,
        });
        const conversation = hasResidentContent(current)
          ? mergeResidentConversationCacheState(current, fetchedConversation, false)
          : fetchedConversation;
        const ownsLiveFileEffects = current.fileEffectTurnId.length > 0
          || state.runningThreadIds.has(threadId);
        const { settledFileEffectSummary, ...conversationFields } = conversation;
        return {
          records: patchThreadRecord(state.records, threadId, {
            ...conversationFields,
            ...(!ownsLiveFileEffects && settledFileEffectSummary
              ? { fileEffectSummary: settledFileEffectSummary }
              : ownsLiveFileEffects
                ? { fileEffectSummary: current.fileEffectSummary }
                : {}),
            loading: false,
            isLoadingMore: false,
            isLoadingNewer: false,
            // Reserve the auxiliary freshness window with the conversation commit.
            // The fanout itself is deferred so the first paint is not blocked.
            lastHydratedAt: Date.now(),
            settings: this.deps.getWorkspaceThreadSettings(threadId),
          }),
        };
      });
      recordThreadCommit(threadId, "network-fetch");

      this.scheduleAuxiliaryHydration(threadId, expectedEpoch, {
        freshnessTtlMs: HYDRATION_TTL_MS,
        force: opts?.force ?? true,
        commitFileChangesToStore: true,
        expectedLoadEpoch: expectedEpoch,
        skipFileChangeSnapshots: true,
      });

      let tailFollowupInvalidated = false;
      if (usedTail) {
        const postTailState = getState();
        if (
          postTailState.currentThreadId !== threadId
          || getThreadRecord(postTailState.records, threadId).loadEpoch !== expectedEpoch
          || (this.invalidationGenerations.get(threadId) ?? 0) !== expectedInvalidationGeneration
        ) return;
        const tailRevision = conversationRevision(getThreadRecord(postTailState.records, threadId));
        const tailGeneration = this.invalidationGenerations.get(threadId) ?? 0;
        try {
          const narrativePage = await this.transport().loadConversationPage(
            threadId,
            MESSAGE_FETCH_SIZE,
          );
          const stateAtTailFollowup = getState();
          const recordAtTailFollowup = getThreadRecord(stateAtTailFollowup.records, threadId);
          if (
            stateAtTailFollowup.currentThreadId !== threadId
            || recordAtTailFollowup.loadEpoch !== expectedEpoch
            || (this.invalidationGenerations.get(threadId) ?? 0) !== tailGeneration
            || conversationRevision(recordAtTailFollowup) !== tailRevision
          ) {
            tailFollowupInvalidated = true;
          }
          setState((state: ThreadHydratorWriteState) => {
            const current = getThreadRecord(state.records, threadId);
            if (
              tailFollowupInvalidated
              || state.currentThreadId !== threadId
              || current.loadEpoch !== expectedEpoch
              || (this.invalidationGenerations.get(threadId) ?? 0) !== tailGeneration
              || conversationRevision(current) !== tailRevision
            ) return {};
            const retained = new Set(current.messages.map((message) => message.id));
            return {
              records: patchThreadRecord(state.records, threadId, {
                narrativeByMessage: Object.fromEntries(
                  Object.entries(narrativePage.narrativeByMessage).filter(([id]) => retained.has(id)),
                ),
                answeredPlanMessageIds: new Set(
                  (narrativePage.answeredPlanMessageIds ?? []).filter((id) => retained.has(id)),
                ),
              }),
            };
          });
        } catch {
          const stateAtTailFailure = getState();
          const recordAtTailFailure = getThreadRecord(stateAtTailFailure.records, threadId);
          tailFollowupInvalidated =
            stateAtTailFailure.currentThreadId !== threadId
            || recordAtTailFailure.loadEpoch !== expectedEpoch
            || (this.invalidationGenerations.get(threadId) ?? 0) !== tailGeneration
            || conversationRevision(recordAtTailFailure) !== tailRevision;
          // First-paint tail remains usable when the narrative follow-up fails.
        }
      }

      const committed = getThreadRecord(getState().records, threadId);
      if (committed.planQuestionsStatus !== "pending") {
        const pendingQuestions = this.deps.extractPendingPlanQuestions(
          committed.messages,
          committed.answeredPlanMessageIds,
        );
        if (pendingQuestions) {
          this.deps.setPlanQuestions(threadId, pendingQuestions);
        }
      }

      const stateBeforeCache = getState();
      const recordBeforeCache = getThreadRecord(stateBeforeCache.records, threadId);
      if (
        !tailFollowupInvalidated
        && stateBeforeCache.currentThreadId === threadId
        && recordBeforeCache.loadEpoch === expectedEpoch
        && (this.invalidationGenerations.get(threadId) ?? 0) === expectedInvalidationGeneration
      ) {
        cacheRecord(threadId, projectConversationCacheState(recordBeforeCache));
      }
      void snapshotsPromise.then((snapshots) => {
        this.applySnapshots(threadId, snapshots, expectedEpoch);
      });
      void goalLookupPromise.then((goalLookup) => {
        if (goalLookup) this.applyGoalLookup(threadId, goalLookup, expectedEpoch);
      });
      if (commitOpts?.prefetchEarlierHistory !== false) {
        this.scheduleEarlierHistoryPrefetch(threadId, pageResult);
      }
    } catch (e) {
      if (getState().currentThreadId === threadId) {
        setState((state: ThreadHydratorWriteState) => ({
          records: patchThreadRecord(state.records, threadId, {
            error: String(e),
            loading: false,
          }),
        }));
      }
      evictCachedRecord(threadId);
    }
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
