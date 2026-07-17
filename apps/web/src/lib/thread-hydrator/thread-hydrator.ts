import {
  cacheRecord,
  evictCachedRecord,
  getCachedRecord,
  hasCachedRecord,
} from "./record-cache";
import {
  createEmptyThreadRecord,
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
} from "./types";
import { SnapshotBuilder, snapshotBuilder } from "./snapshot-builder";
import { AuxiliaryHydrator } from "./auxiliary-hydrator";

interface HistoryHydrate {
  expectedEpoch: number;
  promise: Promise<void>;
}

/** Latest messages fetched before the selected thread first paints. */
export const MESSAGE_FETCH_SIZE = 12;

/** Earlier messages filled in after the latest tail has painted. */
export const HISTORY_PREFETCH_SIZE = 88;

/** Auxiliary side-effect refresh TTL (permissions, tasks, plans). */
export const HYDRATION_TTL_MS = 2000;

/** Background hover prefetch limit (matches legacy prefetch.ts). */
export const BACKGROUND_PREFETCH_LIMIT = 100;

/**
 * Owns the full "load this thread" flow: cache lookup, RPC fetch, record
 * commit, auxiliary fanout, and narrative prefetch.
 */
export class ThreadHydrator {
  private readonly auxiliaryHydrator: AuxiliaryHydrator;
  private readonly activeHydrates = new Map<string, Promise<void>>();
  private readonly backgroundHydrates = new Map<string, Promise<void>>();
  private readonly historyHydrates = new Map<string, HistoryHydrate>();

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

    const hydrate = this.fetchAndCacheBackground(threadId).finally(() => {
      if (this.backgroundHydrates.get(threadId) === hydrate) {
        this.backgroundHydrates.delete(threadId);
      }
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
        this.transport().loadConversationPage(threadId, BACKGROUND_PREFETCH_LIMIT),
        shouldFetchSnapshots
          ? this.transport().listSnapshots(threadId).catch(() => [] as Awaited<ReturnType<ThreadHydratorTransport["listSnapshots"]>>)
          : Promise.resolve([] as Awaited<ReturnType<ThreadHydratorTransport["listSnapshots"]>>),
      ]);

      if (hasCachedRecord(threadId)) return;

      const patch = snapshotBuilder.build({
        messages: pageResult.messages,
        hasMore: pageResult.hasMore,
        answeredPlanMessageIds: pageResult.answeredPlanMessageIds,
        snapshots,
      });

      const record: ThreadRecord = {
        ...createEmptyThreadRecord(),
        ...patch,
        narrativeByMessage: pageResult.narrativeByMessage,
        settings: this.deps.getWorkspaceThreadSettings(threadId),
      };
      cacheRecord(threadId, record);
    } catch {
      // Background prefetch is speculative; swallow errors silently.
    }
  }

  /** Active-thread load invoked from ChatView and workspaceStore. */
  private async hydrateActive(threadId: string, opts?: ThreadHydratorOptions): Promise<void> {
    // Defer until after the cache-restore set() so outgoing-thread streaming
    // previews do not trigger a mid-switch MessageList re-render.
    queueMicrotask(this.deps.flushPendingTextDeltas);

    const cached = getCachedRecord(threadId);
    if (cached) {
      this.restoreCachedActive(threadId, cached, opts);
      return;
    }

    const resident = this.deps.getState().records.get(threadId);
    const hasResidentLayer = resident != null && (
      resident.messages.length > 0
      || resident.streaming.length > 0
      || resident.toolCalls.length > 0
      || resident.thoughtSegments.length > 0
      || resident.hooks.length > 0
      || this.deps.getState().runningThreadIds.has(threadId)
    );

    const inFlight = this.activeHydrates.get(threadId);
    if (inFlight) {
      this.selectInFlightLayer(threadId, hasResidentLayer);
      await inFlight;
      const state = this.deps.getState();
      const current = getThreadRecord(state.records, threadId);
      if (state.currentThreadId === threadId && current.loading && !hasCachedRecord(threadId)) {
        await this.hydrateActive(threadId, opts);
      }
      return;
    }

    if (hasResidentLayer) {
      this.activateResidentLayer(threadId);
    }

    const hydrate = this.fetchActiveReusingBackground(threadId, opts, hasResidentLayer).finally(() => {
      if (this.activeHydrates.get(threadId) === hydrate) {
        this.activeHydrates.delete(threadId);
      }
    });
    this.activeHydrates.set(threadId, hydrate);
    await hydrate;
  }

  /** Active-thread cache miss path, reusing hover prefetches when available. */
  private async fetchActiveReusingBackground(
    threadId: string,
    opts?: ThreadHydratorOptions,
    hasResidentLayer = false,
  ): Promise<void> {
    const background = this.backgroundHydrates.get(threadId);
    if (background) {
      if (!hasResidentLayer) {
        this.prepareActiveLoad(threadId);
      }
      await background;

      if (this.deps.getState().currentThreadId !== threadId) return;

      const cached = getCachedRecord(threadId);
      if (cached) {
        this.restoreCachedActive(threadId, cached, opts, { bumpLoadEpoch: false });
        return;
      }

      await this.fetchAndCommit(threadId, opts, { skipPrepare: true });
      return;
    }

    await this.fetchAndCommit(threadId, opts, hasResidentLayer
      ? {
          skipPrepare: true,
          fetchLimit: BACKGROUND_PREFETCH_LIMIT,
          prefetchEarlierHistory: false,
        }
      : undefined);
  }

  /** Makes a retained thread record visible while its persisted history refreshes. */
  private activateResidentLayer(threadId: string): void {
    this.deps.setState((state: ThreadHydratorWriteState) => {
      const current = getThreadRecord(state.records, threadId);
      return {
        records: patchThreadRecord(state.records, threadId, {
          loading: false,
          error: null,
          isLoadingMore: false,
          loadEpoch: current.loadEpoch + 1,
          settings: this.deps.getWorkspaceThreadSettings(threadId),
        }),
        currentThreadId: threadId,
      };
    });
  }

  /** Makes an already-loading thread current without invalidating its request epoch. */
  private selectInFlightLayer(threadId: string, hasResidentLayer: boolean): void {
    this.deps.setState((state: ThreadHydratorWriteState) => ({
      records: patchThreadRecord(state.records, threadId, {
        loading: !hasResidentLayer,
        error: null,
        settings: this.deps.getWorkspaceThreadSettings(threadId),
      }),
      currentThreadId: threadId,
    }));
  }

  /** Restore cached data to the active store and refresh auxiliary data. */
  private restoreCachedActive(
    threadId: string,
    cached: ThreadRecord,
    opts?: ThreadHydratorOptions,
    restoreOpts?: { bumpLoadEpoch?: boolean },
  ): void {
    this.restoreFromCache(threadId, cached, restoreOpts);
    const expectedEpoch = getThreadRecord(this.deps.getState().records, threadId).loadEpoch;
    void this.refreshThreadGoal(threadId, expectedEpoch);
    this.auxiliaryHydrator.hydrate(threadId, {
      freshnessTtlMs: HYDRATION_TTL_MS,
      force: opts?.force,
      commitFileChangesToStore: true,
      expectedLoadEpoch: expectedEpoch,
    });
    if (cached.hasMoreMessages && cached.messages.length < BACKGROUND_PREFETCH_LIMIT) {
      this.scheduleEarlierHistoryHydration(threadId, cached);
    }
  }

  /**
   * Synchronously restore from a cached {@link ThreadRecord}.
   *
   * Auxiliary-owned fields (`permissions`, `lastHydratedAt`) are preserved from
   * the live record because the cache snapshot is taken synchronously after
   * `auxiliaryHydrator.hydrate()` fires its async RPCs, so the cached values
   * are typically stale relative to whatever the auxiliary writes settle to.
   * The auxiliary fanout that runs after restoration will refresh them anyway.
   */
  private restoreFromCache(
    threadId: string,
    cached: ThreadRecord,
    opts?: { bumpLoadEpoch?: boolean },
  ): void {
    this.deps.setState((state: ThreadHydratorWriteState) => {
      const current = getThreadRecord(state.records, threadId);
      // The cache snapshot predates in-flight narration, so for a running
      // thread the live record wins (mirrors fetchAndCommit's isRunning guard).
      const isRunning = state.runningThreadIds.has(threadId);
      const liveVolatile: Partial<ThreadRecord> = isRunning
        ? {
            toolCalls: current.toolCalls,
            thoughtSegments: current.thoughtSegments,
            hooks: current.hooks,
            streaming: current.streaming,
            streamingPreview: current.streamingPreview,
            agentStartTime: current.agentStartTime,
            currentTurnMessageId: current.currentTurnMessageId,
            isCompacting: current.isCompacting,
          }
        : {};
      return {
        records: patchThreadRecord(state.records, threadId, {
          ...cached,
          error: null,
          loading: false,
          loadEpoch: opts?.bumpLoadEpoch === false ? current.loadEpoch : current.loadEpoch + 1,
          isLoadingMore: false,
          lastHydratedAt: current.lastHydratedAt,
          permissions: current.permissions,
          settings: this.deps.getWorkspaceThreadSettings(threadId),
          ...liveVolatile,
        }),
        currentThreadId: threadId,
      };
    });
  }

  /** Apply lookup result semantics to the live record and record cache. */
  private applyGoalLookup(
    threadId: string,
    lookup: GoalLookupResult,
    expectedEpoch?: number,
  ): void {
    let applied = false;
    this.deps.setState((state: ThreadHydratorWriteState) => {
      const current = getThreadRecord(state.records, threadId);
      if (expectedEpoch != null && (
        state.currentThreadId !== threadId
        || current.loadEpoch !== expectedEpoch
      )) {
        return {};
      }
      applied = true;
      const goal = resolveGoalLookupGoal(lookup, current.goal);
      return {
        records: patchThreadRecord(state.records, threadId, { goal }),
      };
    });

    const cached = getCachedRecord(threadId);
    if (!cached || !applied) return;
    const goal = resolveGoalLookupGoal(lookup, cached.goal);
    cacheRecord(threadId, { ...cached, goal });
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
      return {
        records: patchThreadRecord(state.records, threadId, fileChanges),
      };
    });

    const cached = getCachedRecord(threadId);
    if (!cached || !applied) return;
    cacheRecord(threadId, { ...cached, ...fileChanges });
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
          messages: [],
          persistedToolCallCounts: {},
          persistedFilesChanged: {},
          latestTurnWithChanges: null,
          isLoadingMore: false,
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

    try {
      const workspaceThread = this.deps.getWorkspaceThread(threadId);
      const shouldFetchSnapshots = workspaceThread?.has_file_changes !== false;

      const goalLookupPromise = this.transport().getThreadGoal(threadId).catch(() => null);
      const snapshotsPromise = shouldFetchSnapshots
        ? this.transport().listSnapshots(threadId).catch(() => [] as Awaited<ReturnType<ThreadHydratorTransport["listSnapshots"]>>)
        : Promise.resolve([] as Awaited<ReturnType<ThreadHydratorTransport["listSnapshots"]>>);
      const pageResult = await this.transport().loadConversationPage(
        threadId,
        commitOpts?.fetchLimit ?? MESSAGE_FETCH_SIZE,
      );

      const stateAtCommit = getState();
      if (
        stateAtCommit.currentThreadId !== threadId
        || getThreadRecord(stateAtCommit.records, threadId).loadEpoch !== expectedEpoch
      ) return;

      const patch = snapshotBuilder.build({
        messages: pageResult.messages,
        hasMore: pageResult.hasMore,
        answeredPlanMessageIds: pageResult.answeredPlanMessageIds,
      });

      setState((state: ThreadHydratorWriteState) => ({
        records: patchThreadRecord(state.records, threadId, {
          ...patch,
          narrativeByMessage: pageResult.narrativeByMessage,
          loading: false,
          isLoadingMore: false,
          settings: this.deps.getWorkspaceThreadSettings(threadId),
        }),
      }));

      this.auxiliaryHydrator.hydrate(threadId, {
        freshnessTtlMs: HYDRATION_TTL_MS,
        force: opts?.force ?? true,
        commitFileChangesToStore: true,
        expectedLoadEpoch: expectedEpoch,
        skipFileChangeSnapshots: true,
      });

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

      cacheRecord(threadId, getThreadRecord(getState().records, threadId));
      void snapshotsPromise.then((snapshots) => {
        this.applySnapshots(threadId, snapshots, expectedEpoch);
      });
      void goalLookupPromise.then((goalLookup) => {
        if (goalLookup) this.applyGoalLookup(threadId, goalLookup, expectedEpoch);
      });
      if (commitOpts?.prefetchEarlierHistory !== false) {
        this.scheduleEarlierHistoryHydration(threadId, pageResult);
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
  private scheduleEarlierHistoryHydration(
    threadId: string,
    page: Pick<ThreadRecord, "messages"> & { hasMore?: boolean; hasMoreMessages?: boolean },
  ): void {
    if (!(page.hasMore ?? page.hasMoreMessages) || page.messages.length === 0) return;
    const before = page.messages[0].sequence;
    const epoch = getThreadRecord(this.deps.getState().records, threadId).loadEpoch;
    const hydrateKey = `${threadId}:${before}`;
    setTimeout(() => {
      const state = this.deps.getState();
      if (state.currentThreadId !== threadId) return;
      if (getThreadRecord(state.records, threadId).loadEpoch !== epoch) return;
      const existing = this.historyHydrates.get(hydrateKey);
      if (existing) {
        existing.expectedEpoch = epoch;
        return;
      }
      const hydrate: HistoryHydrate = {
        expectedEpoch: epoch,
        promise: Promise.resolve(),
      };
      hydrate.promise = this.hydrateEarlierHistory(
        threadId,
        before,
        () => hydrate.expectedEpoch,
      ).finally(() => {
        if (this.historyHydrates.get(hydrateKey) === hydrate) {
          this.historyHydrates.delete(hydrateKey);
        }
      });
      this.historyHydrates.set(hydrateKey, hydrate);
    }, 0);
  }

  /** Prepends the rest of the warm history window without blocking the tail. */
  private async hydrateEarlierHistory(
    threadId: string,
    before: number,
    getExpectedEpoch: () => number,
  ): Promise<void> {
    try {
      const page = await this.transport().loadConversationPage(
        threadId,
        HISTORY_PREFETCH_SIZE,
        before,
      );
      const state = this.deps.getState();
      const current = getThreadRecord(state.records, threadId);
      const expectedEpoch = getExpectedEpoch();
      if (state.currentThreadId !== threadId || current.loadEpoch !== expectedEpoch) return;

      const currentIds = new Set(current.messages.map((message) => message.id));
      const earlierMessages = page.messages.filter((message) => !currentIds.has(message.id));
      const persistedToolCallCounts = { ...current.persistedToolCallCounts };
      for (const message of earlierMessages) {
        if (message.tool_call_count && message.tool_call_count > 0) {
          persistedToolCallCounts[message.id] = message.tool_call_count;
        }
      }
      const messages = [...earlierMessages, ...current.messages];

      this.deps.setState((latest: ThreadHydratorWriteState) => {
        const record = getThreadRecord(latest.records, threadId);
        if (latest.currentThreadId !== threadId || record.loadEpoch !== expectedEpoch) {
          return {};
        }
        return {
          records: patchThreadRecord(latest.records, threadId, {
            messages,
            oldestLoadedSequence: messages[0]?.sequence ?? record.oldestLoadedSequence,
            hasMoreMessages: page.hasMore,
            persistedToolCallCounts,
            narrativeByMessage: {
              ...page.narrativeByMessage,
              ...record.narrativeByMessage,
            },
            answeredPlanMessageIds: new Set([
              ...record.answeredPlanMessageIds,
              ...(page.answeredPlanMessageIds ?? []),
            ]),
          }),
        };
      });
      const latest = this.deps.getState();
      const latestRecord = getThreadRecord(latest.records, threadId);
      if (latest.currentThreadId === threadId && latestRecord.loadEpoch === getExpectedEpoch()) {
        cacheRecord(threadId, latestRecord);
      }
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
