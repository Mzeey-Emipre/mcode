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
import { snapshotBuilder } from "./snapshot-builder";
import { AuxiliaryHydrator } from "./auxiliary-hydrator";

/** Initial message fetch size per thread. */
export const MESSAGE_FETCH_SIZE = 100;

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
      this.restoreFromCache(threadId, cached);
      void this.refreshThreadGoal(threadId);
      this.auxiliaryHydrator.hydrate(threadId, {
        freshnessTtlMs: HYDRATION_TTL_MS,
        force: opts?.force,
        commitFileChangesToStore: true,
      });
      return;
    }

    const inFlight = this.activeHydrates.get(threadId);
    if (inFlight) {
      await inFlight;
      return;
    }

    const hydrate = this.fetchAndCommit(threadId, opts).finally(() => {
      if (this.activeHydrates.get(threadId) === hydrate) {
        this.activeHydrates.delete(threadId);
      }
    });
    this.activeHydrates.set(threadId, hydrate);
    await hydrate;
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
  private restoreFromCache(threadId: string, cached: ThreadRecord): void {
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
          loadEpoch: current.loadEpoch + 1,
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
  private applyGoalLookup(threadId: string, lookup: GoalLookupResult): void {
    this.deps.setState((state: ThreadHydratorWriteState) => {
      const current = getThreadRecord(state.records, threadId);
      const goal = resolveGoalLookupGoal(lookup, current.goal);
      return {
        records: patchThreadRecord(state.records, threadId, { goal }),
      };
    });

    const cached = getCachedRecord(threadId);
    if (!cached) return;
    const goal = resolveGoalLookupGoal(lookup, cached.goal);
    cacheRecord(threadId, { ...cached, goal });
  }

  /** Refresh one thread's active goal without blocking main hydration. */
  private async refreshThreadGoal(threadId: string): Promise<void> {
    try {
      const lookup = await this.transport().getThreadGoal(threadId);
      this.applyGoalLookup(threadId, lookup);
    } catch {
      // Best-effort hydration: message load remains the authoritative error surface.
    }
  }

  /** Cache-miss path: reset volatile state, fetch RPCs, commit, populate cache. */
  private async fetchAndCommit(threadId: string, opts?: ThreadHydratorOptions): Promise<void> {
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
    } else {
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

    try {
      const workspaceThread = this.deps.getWorkspaceThread(threadId);
      const shouldFetchSnapshots = workspaceThread?.has_file_changes !== false;

      const goalLookupPromise = this.transport().getThreadGoal(threadId).catch(() => null);
      const [pageResult, snapshots, goalLookup] = await Promise.all([
        this.transport().loadConversationPage(threadId, MESSAGE_FETCH_SIZE),
        shouldFetchSnapshots
          ? this.transport().listSnapshots(threadId).catch(() => [] as Awaited<ReturnType<ThreadHydratorTransport["listSnapshots"]>>)
          : Promise.resolve([] as Awaited<ReturnType<ThreadHydratorTransport["listSnapshots"]>>),
        goalLookupPromise,
      ]);

      if (getState().currentThreadId !== threadId) return;

      const patch = snapshotBuilder.build({
        messages: pageResult.messages,
        hasMore: pageResult.hasMore,
        answeredPlanMessageIds: pageResult.answeredPlanMessageIds,
        snapshots,
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
      if (goalLookup) {
        this.applyGoalLookup(threadId, goalLookup);
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
