import { cacheRecord, getCachedRecord } from "./record-cache";
import {
  getThreadRecord,
  patchThreadRecord,
} from "@/stores/thread-record";
import type { PlanRecord } from "@mcode/contracts";
import type { TaskItem } from "@/stores/taskStore";
import type {
  ThreadHydratorTransport,
  ThreadHydratorState,
  ThreadHydratorWriteState,
  HydratorWorkspaceThread,
} from "./types";
import { SnapshotBuilder } from "./snapshot-builder";

/** Options for an auxiliary hydration pass. */
export interface AuxiliaryHydratorOptions {
  /** Skip fanout when a recent hydration timestamp is within this window. */
  freshnessTtlMs: number;
  /** When true, bypasses the freshness TTL gate. */
  force?: boolean;
  /** When true, merges file-change data into the live store if this thread is current. */
  commitFileChangesToStore?: boolean;
  /** Load epoch that may receive a deferred file-change result. */
  expectedLoadEpoch?: number;
  /** Skips snapshots when the caller already owns that request. */
  skipFileChangeSnapshots?: boolean;
}

/** Collaborators injected into {@link AuxiliaryHydrator}. */
export interface AuxiliaryHydratorDeps {
  getTransport: () => ThreadHydratorTransport;
  getState: () => ThreadHydratorState;
  setState: (
    partial:
      | Partial<ThreadHydratorWriteState>
      | ((state: ThreadHydratorWriteState) => Partial<ThreadHydratorWriteState>),
  ) => void;
  getWorkspaceThread: (threadId: string) => HydratorWorkspaceThread | undefined;
  getTasksForThread: (threadId: string) => readonly TaskItem[];
  setTasksForThread: (threadId: string, tasks: readonly TaskItem[]) => void;
  addPlanForThread: (threadId: string, plan: PlanRecord) => void;
  shallowEqualBy: <T>(a: readonly T[], b: readonly T[], keys: (keyof T)[]) => boolean;
  coerceTaskStatus: (status: string) => TaskItem["status"];
}

/**
 * Fan-out hydrator for permissions, tasks, plans, and file-change snapshots.
 * Owns the freshness TTL gate and diff-before-set discipline.
 */
export class AuxiliaryHydrator {
  private readonly permissionSnapshotGenerations = new Map<string, number>();
  private readonly pendingPermissionHydrations = new Map<string, number>();
  private readonly permissionGenerationDisposals = new Set<string>();

  constructor(private readonly deps: AuxiliaryHydratorDeps) {}

  /** Invalidate pending permission snapshots for one thread instance. */
  invalidatePermissions(threadId: string): void {
    this.permissionSnapshotGenerations.set(
      threadId,
      (this.permissionSnapshotGenerations.get(threadId) ?? 0) + 1,
    );
  }

  /**
   * Release generation state after thread deletion without allowing an in-flight
   * permission snapshot to commit into a newly-created thread with the same ID.
   */
  forgetThread(threadId: string): void {
    this.invalidatePermissions(threadId);
    if ((this.pendingPermissionHydrations.get(threadId) ?? 0) === 0) {
      this.permissionSnapshotGenerations.delete(threadId);
      return;
    }
    this.permissionGenerationDisposals.add(threadId);
  }

  /**
   * Run the auxiliary fanout for a thread when the TTL gate allows (or force is set).
   * Individual RPC failures are non-fatal and logged at debug level.
   */
  hydrate(threadId: string, opts: AuxiliaryHydratorOptions): void {
    const { getState, setState } = this.deps;
    const record = getThreadRecord(getState().records, threadId);
    const lastHydrated = record.lastHydratedAt ?? 0;
    const isFresh = !opts.force && Date.now() - lastHydrated < opts.freshnessTtlMs;

    if (isFresh) return;

    setState((s: ThreadHydratorWriteState) => ({
      records: patchThreadRecord(s.records, threadId, { lastHydratedAt: Date.now() }),
    }));

    this.hydratePermissions(threadId);
    this.hydrateTasks(threadId);
    this.hydratePlans(threadId);
    if (!opts.skipFileChangeSnapshots) {
      this.hydrateFileChangeSnapshots(
        threadId,
        opts.commitFileChangesToStore ?? false,
        opts.expectedLoadEpoch,
      );
    }
  }

  private transport(): ThreadHydratorTransport {
    return this.deps.getTransport();
  }

  private hydratePermissions(threadId: string): void {
    const { getState, setState, shallowEqualBy } = this.deps;
    const startedState = getState();
    const startedRecord = getThreadRecord(startedState.records, threadId);
    const startedGeneration = this.permissionSnapshotGenerations.get(threadId) ?? 0;
    const startedRunning = startedState.runningThreadIds.has(threadId);
    const startedCurrentThreadId = startedState.currentThreadId;
    this.pendingPermissionHydrations.set(
      threadId,
      (this.pendingPermissionHydrations.get(threadId) ?? 0) + 1,
    );

    void this.transport()
      .listPendingPermissions(threadId)
      .then((pending) => {
        const state = getState();
        const current = getThreadRecord(state.records, threadId);
        const generation = this.permissionSnapshotGenerations.get(threadId) ?? 0;
        const runningNow = state.runningThreadIds.has(threadId);
        // Snapshot may commit only to same thread instance and lifecycle. A
        // live request wins once present; empty live state still permits a
        // running snapshot when no event arrived to populate it.
        if (
          generation !== startedGeneration
          || state.currentThreadId !== startedCurrentThreadId
          || !state.records.has(threadId)
          || current.loadEpoch !== startedRecord.loadEpoch
          || runningNow !== startedRunning
          || (runningNow && current.permissions.length > 0)
        ) return;
        const mapped = pending.map((p) => ({ ...p, settled: false }));
        if (!shallowEqualBy(mapped, current.permissions, ["requestId", "toolName", "settled"])) {
          setState((s: ThreadHydratorWriteState) => {
            const next = getThreadRecord(s.records, threadId);
            if (
              !s.records.has(threadId)
              || s.currentThreadId !== startedCurrentThreadId
              || next.loadEpoch !== startedRecord.loadEpoch
              || (this.permissionSnapshotGenerations.get(threadId) ?? 0) !== startedGeneration
              || s.runningThreadIds.has(threadId) !== startedRunning
              || (s.runningThreadIds.has(threadId) && next.permissions.length > 0)
            ) return {};
            return {
              records: patchThreadRecord(s.records, threadId, { permissions: mapped }),
            };
          });
        }
      })
      .catch(() => {
        /* non-critical */
      })
      .finally(() => {
        const pending = (this.pendingPermissionHydrations.get(threadId) ?? 1) - 1;
        if (pending > 0) {
          this.pendingPermissionHydrations.set(threadId, pending);
          return;
        }
        this.pendingPermissionHydrations.delete(threadId);
        if (this.permissionGenerationDisposals.delete(threadId)) {
          this.permissionSnapshotGenerations.delete(threadId);
        }
      });
  }

  private hydrateTasks(threadId: string): void {
    const { shallowEqualBy, coerceTaskStatus } = this.deps;

    this.transport()
      .getThreadTasks(threadId)
      .then((tasks) => {
        const items = (tasks ?? []).map((t, i) => ({
          id: t.id ?? String(i),
          harnessTaskId: t.id,
          content: t.content,
          activeForm: t.activeForm,
          status: coerceTaskStatus(t.status),
          group: t.group ?? "Tasks",
        }));
        const currentTasks = this.deps.getTasksForThread(threadId);
        const isThreadRunning = this.deps.getState().runningThreadIds.has(threadId);
        const merged = isThreadRunning
          ? (() => {
              const currentGroups = new Set(currentTasks.map((task) => task.group));
              return [
                ...items.filter((item) => !currentGroups.has(item.group)),
                ...currentTasks,
              ];
            })()
          : items;
        if (
          !shallowEqualBy(merged, currentTasks, [
            "id",
            "harnessTaskId",
            "content",
            "activeForm",
            "status",
            "group",
          ])
        ) {
          this.deps.setTasksForThread(threadId, merged);
        }
      })
      .catch((err) => {
        console.debug("[taskHydration] Failed to load tasks for thread %s:", threadId, err);
      });
  }

  private hydratePlans(threadId: string): void {
    this.transport()
      .getThreadPlans(threadId)
      .then((plans) => {
        if (plans && plans.length > 0) {
          for (const plan of plans) {
            this.deps.addPlanForThread(threadId, plan);
          }
        }
      })
      .catch((err: unknown) => {
        console.debug("[planHydration] Failed to load plans for thread %s:", threadId, err);
      });
  }

  /**
   * Fetch file-change snapshots when the thread has changes but the cache entry
   * lacks file-change data (e.g. after a background prefetch).
   */
  private hydrateFileChangeSnapshots(
    threadId: string,
    commitToStore: boolean,
    expectedLoadEpoch?: number,
  ): void {
    const threadRecord = this.deps.getWorkspaceThread(threadId);
    if (!threadRecord?.has_file_changes) return;

    const cached = getCachedRecord(threadId);
    // Only backfill thin prefetched entries; cache-miss callers build a canonical record first.
    if (!cached || cached.latestTurnWithChanges) return;

    void this.transport()
      .listSnapshots(threadId)
      .then((snapshots) => this.applyFileChangeSnapshots(threadId, snapshots, commitToStore, expectedLoadEpoch))
      .catch(() => {
        /* non-critical */
      });
  }

  private applyFileChangeSnapshots(
    threadId: string,
    snapshots: Awaited<ReturnType<ThreadHydratorTransport["listSnapshots"]>>,
    commitToStore: boolean,
    expectedLoadEpoch: number | undefined,
  ): void {
    if (snapshots.length === 0 || !this.fileChangeSnapshotRequestIsCurrent(threadId, expectedLoadEpoch)) return;
    const cached = getCachedRecord(threadId);
    if (!cached) return;
    const fileChanges = SnapshotBuilder.deriveFileChanges(snapshots);
    if (!this.hasFileChanges(fileChanges)) return;
    this.cacheFileChanges(threadId, cached, fileChanges);
    if (commitToStore) this.commitFileChanges(threadId, fileChanges, expectedLoadEpoch);
  }

  private fileChangeSnapshotRequestIsCurrent(threadId: string, expectedLoadEpoch: number | undefined): boolean {
    if (expectedLoadEpoch === undefined) return true;
    const state = this.deps.getState();
    return state.currentThreadId === threadId && getThreadRecord(state.records, threadId).loadEpoch === expectedLoadEpoch;
  }

  private hasFileChanges(fileChanges: ReturnType<typeof SnapshotBuilder.deriveFileChanges>): boolean {
    return Object.keys(fileChanges.persistedFilesChanged).length > 0 || fileChanges.fileEffectSummary.fileCount > 0;
  }

  private cacheFileChanges(
    threadId: string,
    cached: NonNullable<ReturnType<typeof getCachedRecord>>,
    fileChanges: ReturnType<typeof SnapshotBuilder.deriveFileChanges>,
  ): void {
    const state = this.deps.getState();
    const record = getThreadRecord(state.records, threadId);
    const ownsLiveEffects = record.fileEffectTurnId.length > 0 || state.runningThreadIds.has(threadId);
    cacheRecord(threadId, {
      ...cached,
      persistedFilesChanged: { ...cached.persistedFilesChanged, ...fileChanges.persistedFilesChanged },
      latestTurnWithChanges: fileChanges.latestTurnWithChanges,
      ...(!ownsLiveEffects ? { settledFileEffectSummary: fileChanges.fileEffectSummary } : {}),
    });
  }

  private commitFileChanges(
    threadId: string,
    fileChanges: ReturnType<typeof SnapshotBuilder.deriveFileChanges>,
    expectedLoadEpoch: number | undefined,
  ): void {
    if (this.deps.getState().currentThreadId !== threadId) return;
    this.deps.setState((state: ThreadHydratorWriteState) => {
      const record = getThreadRecord(state.records, threadId);
      if (state.currentThreadId !== threadId || (expectedLoadEpoch !== undefined && record.loadEpoch !== expectedLoadEpoch)) return {};
      const ownsLiveEffects = record.fileEffectTurnId.length > 0 || state.runningThreadIds.has(threadId);
      return {
        records: patchThreadRecord(state.records, threadId, {
          persistedFilesChanged: { ...record.persistedFilesChanged, ...fileChanges.persistedFilesChanged },
          latestTurnWithChanges: fileChanges.latestTurnWithChanges,
          ...(!ownsLiveEffects ? { fileEffectSummary: fileChanges.fileEffectSummary } : {}),
        }),
      };
    });
  }
}
