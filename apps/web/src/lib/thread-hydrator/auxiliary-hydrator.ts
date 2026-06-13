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
  constructor(private readonly deps: AuxiliaryHydratorDeps) {}

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
    this.hydrateFileChangeSnapshots(threadId, opts.commitFileChangesToStore ?? false);
  }

  private transport(): ThreadHydratorTransport {
    return this.deps.getTransport();
  }

  private hydratePermissions(threadId: string): void {
    const { getState, setState, shallowEqualBy } = this.deps;

    void this.transport()
      .listPendingPermissions(threadId)
      .then((pending) => {
        const mapped = pending.map((p) => ({ ...p, settled: false }));
        const current = getThreadRecord(getState().records, threadId).permissions;
        if (!shallowEqualBy(mapped, current, ["requestId", "toolName", "settled"])) {
          setState((s: ThreadHydratorWriteState) => {
            if (!s.records.has(threadId)) return {};
            return {
              records: patchThreadRecord(s.records, threadId, { permissions: mapped }),
            };
          });
        }
      })
      .catch(() => {
        /* non-critical */
      });
  }

  private hydrateTasks(threadId: string): void {
    const { shallowEqualBy, coerceTaskStatus } = this.deps;

    this.transport()
      .getThreadTasks(threadId)
      .then((tasks) => {
        const items = (tasks ?? []).map((t, i) => ({
          id: String(i),
          content: t.content,
          status: coerceTaskStatus(t.status),
          group: t.group ?? "Tasks",
        }));
        const currentTasks = this.deps.getTasksForThread(threadId);
        const currentGroups = new Set(currentTasks.map((task) => task.group));
        const merged = [
          ...items.filter((item) => !currentGroups.has(item.group)),
          ...currentTasks,
        ];
        if (!shallowEqualBy(merged, currentTasks, ["content", "status", "group"])) {
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
  private hydrateFileChangeSnapshots(threadId: string, commitToStore: boolean): void {
    const threadRecord = this.deps.getWorkspaceThread(threadId);
    if (!threadRecord?.has_file_changes) return;

    const cached = getCachedRecord(threadId);
    // Only backfill thin prefetched entries; cache-miss callers build a canonical record first.
    if (!cached || cached.latestTurnWithChanges) return;

    void this.transport()
      .listSnapshots(threadId)
      .then((snapshots) => {
        if (snapshots.length === 0) return;

        const latestCached = getCachedRecord(threadId);
        if (!latestCached) return;

        const fileChanges = SnapshotBuilder.deriveFileChanges(snapshots);
        if (Object.keys(fileChanges.persistedFilesChanged).length === 0) return;

        cacheRecord(threadId, {
          ...latestCached,
          persistedFilesChanged: {
            ...latestCached.persistedFilesChanged,
            ...fileChanges.persistedFilesChanged,
          },
          latestTurnWithChanges: fileChanges.latestTurnWithChanges,
        });

        if (!commitToStore) return;
        const { getState, setState } = this.deps;
        if (getState().currentThreadId !== threadId) return;

        setState((state: ThreadHydratorWriteState) => {
          if (state.currentThreadId !== threadId) return {};
          const rec = getThreadRecord(state.records, threadId);
          return {
            records: patchThreadRecord(state.records, threadId, {
              persistedFilesChanged: {
                ...rec.persistedFilesChanged,
                ...fileChanges.persistedFilesChanged,
              },
              latestTurnWithChanges: fileChanges.latestTurnWithChanges,
            }),
          };
        });
      })
      .catch(() => {
        /* non-critical */
      });
  }
}
