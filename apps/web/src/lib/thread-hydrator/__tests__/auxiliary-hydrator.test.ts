import { describe, it, expect, beforeEach, vi } from "vitest";
import { HYDRATION_TTL_MS } from "@/lib/thread-hydrator";
import { AuxiliaryHydrator } from "@/lib/thread-hydrator/auxiliary-hydrator";
import {
  cacheRecord,
  clearRecordCache,
  getCachedRecord,
} from "@/lib/thread-hydrator/record-cache";
import {
  createEmptyThreadRecord,
  getThreadRecord,
  patchThreadRecord,
  type ThreadRecord,
} from "@/stores/thread-record";
import type { ThreadHydratorWriteState } from "@/lib/thread-hydrator/types";
import { mockTransport, createMockMessage, createMockThread } from "@/__tests__/mocks/transport";
import { shallowEqualBy } from "@/lib/shallowEqualBy";
import { coerceTaskStatus, type TaskItem } from "@/stores/taskStore";

const THREAD_ID = "aux-thread";

function makeThinRecord(): ThreadRecord {
  return {
    ...createEmptyThreadRecord(),
    messages: [createMockMessage({ id: "m1", thread_id: THREAD_ID, sequence: 1 })],
    oldestLoadedSequence: 1,
  };
}

describe("AuxiliaryHydrator", () => {
  let setStateSpy: ReturnType<typeof vi.fn>;
  let setTasksForThread: (threadId: string, tasks: readonly unknown[]) => void;
  let records: Map<string, ThreadRecord>;
  let currentThreadId: string | null;

  beforeEach(() => {
    clearRecordCache();
    vi.clearAllMocks();
    records = new Map<string, ThreadRecord>();
    currentThreadId = THREAD_ID;

    (mockTransport.listPendingPermissions as ReturnType<typeof vi.fn>).mockResolvedValue([
      { requestId: "r1", toolName: "bash", input: {}, threadId: THREAD_ID },
    ]);
    (mockTransport.getThreadTasks as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (mockTransport.getThreadPlans as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (mockTransport.listSnapshots as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    setStateSpy = vi.fn();
    setTasksForThread = vi.fn() as (threadId: string, tasks: readonly unknown[]) => void;

    cacheRecord(THREAD_ID, makeThinRecord());
  });

  function applySetState(
    partial:
      | Partial<ThreadHydratorWriteState>
      | ((state: ThreadHydratorWriteState) => Partial<ThreadHydratorWriteState>),
  ): void {
    (setStateSpy as (arg: unknown) => void)(partial);
    const base: ThreadHydratorWriteState = {
      records,
      currentThreadId,
      runningThreadIds: new Set<string>(),
    };
    const patch = typeof partial === "function" ? partial(base) : partial;
    if (patch.records) records = patch.records;
    if (patch.currentThreadId !== undefined) currentThreadId = patch.currentThreadId;
  }

  function createAux(
    overrides?: Partial<{
      getWorkspaceThread: () => { id: string; has_file_changes?: boolean } | undefined;
      getTasksForThread: (threadId: string) => readonly TaskItem[];
      runningThreadIds: Set<string>;
    }>,
  ): AuxiliaryHydrator {
    return new AuxiliaryHydrator({
      getTransport: () => mockTransport,
      getState: () => ({
        records,
        currentThreadId,
        runningThreadIds: overrides?.runningThreadIds ?? new Set(),
        toolCallRecordCache: { clear: vi.fn() },
      }),
      setState: applySetState,
      getWorkspaceThread:
        overrides?.getWorkspaceThread ??
        (() => createMockThread({ id: THREAD_ID, has_file_changes: false })),
      getTasksForThread: overrides?.getTasksForThread ?? (() => []),
      setTasksForThread,
      addPlanForThread: vi.fn(),
      shallowEqualBy,
      coerceTaskStatus,
    });
  }

  it("skipped a second fanout within the freshness TTL window", async () => {
    const aux = createAux();
    aux.hydrate(THREAD_ID, { freshnessTtlMs: HYDRATION_TTL_MS, force: false });
    await vi.waitFor(() => {
      expect(mockTransport.listPendingPermissions).toHaveBeenCalledTimes(1);
    });

    vi.clearAllMocks();
    aux.hydrate(THREAD_ID, { freshnessTtlMs: HYDRATION_TTL_MS, force: false });
    await new Promise((r) => setTimeout(r, 20));

    expect(mockTransport.listPendingPermissions).not.toHaveBeenCalled();
  });

  it("ran fanout again when force bypassed the TTL gate", async () => {
    const aux = createAux();
    aux.hydrate(THREAD_ID, { freshnessTtlMs: HYDRATION_TTL_MS });
    await vi.waitFor(() => {
      expect(mockTransport.listPendingPermissions).toHaveBeenCalledTimes(1);
    });

    vi.clearAllMocks();
    aux.hydrate(THREAD_ID, { freshnessTtlMs: HYDRATION_TTL_MS, force: true });
    await vi.waitFor(() => {
      expect(mockTransport.listPendingPermissions).toHaveBeenCalledTimes(1);
    });
  });

  it("did not call setState for permissions when payload was unchanged", async () => {
    records = patchThreadRecord(records, THREAD_ID, {
      permissions: [{ requestId: "r1", toolName: "bash", settled: false, threadId: THREAD_ID, input: {} }],
    });
    const aux = createAux();
    aux.hydrate(THREAD_ID, { freshnessTtlMs: HYDRATION_TTL_MS, force: true });
    await vi.waitFor(() => {
      expect(mockTransport.listPendingPermissions).toHaveBeenCalled();
    });

    const permissionPatches = setStateSpy.mock.calls.filter((call) => {
      const arg = call[0];
      if (typeof arg !== "function") return false;
      const patch = arg({ records, currentThreadId, runningThreadIds: new Set() });
      if (!patch.records) return false;
      const next = getThreadRecord(patch.records, THREAD_ID).permissions;
      const prev = getThreadRecord(records, THREAD_ID).permissions;
      return next !== prev;
    });
    expect(permissionPatches).toHaveLength(0);
  });

  it("continued other fanouts when one RPC failed", async () => {
    (mockTransport.listPendingPermissions as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("permissions down"),
    );
    const aux = createAux();
    aux.hydrate(THREAD_ID, { freshnessTtlMs: HYDRATION_TTL_MS, force: true });

    await vi.waitFor(() => {
      expect(mockTransport.getThreadTasks).toHaveBeenCalledWith(THREAD_ID);
      expect(mockTransport.getThreadPlans).toHaveBeenCalledWith(THREAD_ID);
    });
  });

  it("kept live tasks for a running thread when task hydration returned no persisted tasks", async () => {
    const liveTask: TaskItem = {
      id: "task-live",
      content: "Buy groceries - Pick up milk, eggs, bread",
      status: "pending",
      group: "Tasks",
    };
    (mockTransport.getThreadTasks as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const aux = createAux({
      getTasksForThread: () => [liveTask],
      runningThreadIds: new Set([THREAD_ID]),
    });
    aux.hydrate(THREAD_ID, { freshnessTtlMs: HYDRATION_TTL_MS, force: true });

    await vi.waitFor(() => {
      expect(mockTransport.getThreadTasks).toHaveBeenCalledWith(THREAD_ID);
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(setTasksForThread).not.toHaveBeenCalled();
  });

  it("kept live tasks for a running thread group when hydration returned stale persisted tasks", async () => {
    const liveTask: TaskItem = {
      id: "task-live",
      content: "Clean the kitchen - Dishes, counters, floor",
      status: "pending",
      group: "Tasks",
    };
    (mockTransport.getThreadTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        content: "Buy groceries - Pick up milk, eggs, bread",
        status: "pending",
        group: "Tasks",
      },
    ]);

    const aux = createAux({
      getTasksForThread: () => [liveTask],
      runningThreadIds: new Set([THREAD_ID]),
    });
    aux.hydrate(THREAD_ID, { freshnessTtlMs: HYDRATION_TTL_MS, force: true });

    await vi.waitFor(() => {
      expect(mockTransport.getThreadTasks).toHaveBeenCalledWith(THREAD_ID);
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(setTasksForThread).not.toHaveBeenCalled();
  });

  it("merged persisted groups that were missing from live tasks on a running thread", async () => {
    const liveTask: TaskItem = {
      id: "task-live",
      content: "Clean the kitchen - Dishes, counters, floor",
      status: "pending",
      group: "Tasks",
    };
    (mockTransport.getThreadTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        content: "Check child diagnostics",
        status: "pending",
        group: "Sub-agent",
      },
    ]);

    const aux = createAux({
      getTasksForThread: () => [liveTask],
      runningThreadIds: new Set([THREAD_ID]),
    });
    aux.hydrate(THREAD_ID, { freshnessTtlMs: HYDRATION_TTL_MS, force: true });

    await vi.waitFor(() => {
      expect(setTasksForThread).toHaveBeenCalledWith(THREAD_ID, [
        {
          id: "0",
          content: "Check child diagnostics",
          status: "pending",
          group: "Sub-agent",
        },
        liveTask,
      ]);
    });
  });

  it("replaced stale in-memory tasks with persisted tasks when the thread was idle", async () => {
    const staleTask: TaskItem = {
      id: "task-stale",
      content: "Old task",
      status: "pending",
      group: "Tasks",
    };
    (mockTransport.getThreadTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        content: "New task",
        status: "completed",
        group: "Tasks",
      },
    ]);

    const aux = createAux({
      getTasksForThread: () => [staleTask],
    });
    aux.hydrate(THREAD_ID, { freshnessTtlMs: HYDRATION_TTL_MS, force: true });

    await vi.waitFor(() => {
      expect(setTasksForThread).toHaveBeenCalledWith(THREAD_ID, [
        {
          id: "0",
          content: "New task",
          status: "completed",
          group: "Tasks",
        },
      ]);
    });
  });

  it("carried the harness task id and activeForm from persisted Task* tasks", async () => {
    (mockTransport.getThreadTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "1",
        content: "Run tests",
        status: "in_progress",
        activeForm: "Running tests",
        group: "Tasks",
      },
    ]);

    const aux = createAux({ getTasksForThread: () => [] });
    aux.hydrate(THREAD_ID, { freshnessTtlMs: HYDRATION_TTL_MS, force: true });

    await vi.waitFor(() => {
      expect(setTasksForThread).toHaveBeenCalledWith(THREAD_ID, [
        {
          id: "1",
          harnessTaskId: "1",
          content: "Run tests",
          activeForm: "Running tests",
          status: "in_progress",
          group: "Tasks",
        },
      ]);
    });
  });

  it("committed persisted tasks that differ only in identity fields so harnessTaskId reaches the store", async () => {
    // The live task matches on content/status/group but lacks the harness id, so
    // a gate that ignored identity fields would skip the write and later
    // TaskUpdate correlation by harnessTaskId would never land.
    const liveTask: TaskItem = {
      id: "task-live",
      content: "Run tests",
      status: "in_progress",
      group: "Tasks",
    };
    (mockTransport.getThreadTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "1",
        content: "Run tests",
        status: "in_progress",
        group: "Tasks",
      },
    ]);

    const aux = createAux({ getTasksForThread: () => [liveTask] });
    aux.hydrate(THREAD_ID, { freshnessTtlMs: HYDRATION_TTL_MS, force: true });

    await vi.waitFor(() => {
      expect(setTasksForThread).toHaveBeenCalledWith(THREAD_ID, [
        {
          id: "1",
          harnessTaskId: "1",
          content: "Run tests",
          status: "in_progress",
          group: "Tasks",
        },
      ]);
    });
  });

  it("backfilled file-change snapshots for thin cache entries on threads with changes", async () => {
    (mockTransport.listSnapshots as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        message_id: "turn-1",
        files_changed: ["src/a.ts"],
        thread_id: THREAD_ID,
        created_at: "2026-01-01T00:00:00Z",
      },
    ]);

    const aux = createAux({
      getWorkspaceThread: () => createMockThread({ id: THREAD_ID, has_file_changes: true }),
    });
    aux.hydrate(THREAD_ID, {
      freshnessTtlMs: HYDRATION_TTL_MS,
      force: true,
      commitFileChangesToStore: true,
    });

    await vi.waitFor(() => {
      expect(mockTransport.listSnapshots).toHaveBeenCalledWith(THREAD_ID);
    });

    expect(getCachedRecord(THREAD_ID)?.latestTurnWithChanges).toBe("turn-1");
    expect(getCachedRecord(THREAD_ID)?.persistedFilesChanged).toEqual({
      "turn-1": ["src/a.ts"],
    });
  });

  it("discarded file-change snapshots after the expected load epoch changed", async () => {
    let resolveSnapshots!: (value: Array<{
      message_id: string;
      files_changed: string[];
      thread_id: string;
      created_at: string;
    }>) => void;
    records = patchThreadRecord(records, THREAD_ID, { loadEpoch: 4 });
    (mockTransport.listSnapshots as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((resolve) => {
        resolveSnapshots = resolve;
      }),
    );

    const aux = createAux({
      getWorkspaceThread: () => createMockThread({ id: THREAD_ID, has_file_changes: true }),
    });
    aux.hydrate(THREAD_ID, {
      freshnessTtlMs: HYDRATION_TTL_MS,
      force: true,
      commitFileChangesToStore: true,
      expectedLoadEpoch: 4,
    });
    records = patchThreadRecord(records, THREAD_ID, { loadEpoch: 5 });

    resolveSnapshots([{
      message_id: "turn-stale",
      files_changed: ["src/stale.ts"],
      thread_id: THREAD_ID,
      created_at: "2026-01-01T00:00:00Z",
    }]);
    await Promise.resolve();
    await Promise.resolve();

    expect(getCachedRecord(THREAD_ID)?.persistedFilesChanged).toEqual({});
    expect(getThreadRecord(records, THREAD_ID).persistedFilesChanged).toEqual({});
  });
});
