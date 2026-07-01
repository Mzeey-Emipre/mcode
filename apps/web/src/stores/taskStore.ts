import { create } from "zustand";

/** Status of an individual task item. */
export type TaskStatus = "pending" | "in_progress" | "completed" | "cancelled";

/** Valid task status values for runtime validation. */
const VALID_TASK_STATUSES = new Set<string>([
  "pending",
  "in_progress",
  "completed",
  "cancelled",
]);

/**
 * Coerce an unknown status string to a valid TaskStatus, defaulting to "pending".
 * Accepts the American "canceled" spelling and normalizes it to "cancelled".
 */
export function coerceTaskStatus(raw: unknown): TaskStatus {
  const s = String(raw ?? "");
  if (s === "inProgress" || s === "in-progress") return "in_progress";
  if (s === "canceled") return "cancelled";
  return VALID_TASK_STATUSES.has(s) ? (s as TaskStatus) : "pending";
}

/** A single task item within a group. */
export interface TaskItem {
  readonly id: string;
  /**
   * Harness-assigned task id from the Task* tool family (e.g. "1"), captured
   * from the TaskCreate result. Used to correlate later TaskUpdate calls to the
   * task they mutate. Absent for legacy TodoWrite/update_plan tasks.
   */
  readonly harnessTaskId?: string;
  /** Imperative form shown when not active (e.g. "Run tests"). */
  readonly content: string;
  /** Present continuous form shown when active (e.g. "Running tests"). Falls back to content if not provided. */
  readonly activeForm?: string;
  readonly status: TaskStatus;
  readonly group: string;
}

/** Zustand state shape for the task store. */
interface TaskState {
  /** Task items keyed by thread ID. */
  tasksByThread: Record<string, readonly TaskItem[]>;
  /** Parent-agent tasks shown in the composer Task bubble, keyed by thread ID. */
  taskBubbleByThread: Record<string, readonly TaskItem[]>;
  /** Threads keeping unsettled prior tasks until the next turn reports parent tasks. */
  pendingTaskBubbleReplacementByThread: Record<string, boolean>;
  /** Replace all tasks for a thread (top-level TodoWrite). */
  setTasks: (threadId: string, tasks: readonly TaskItem[]) => void;
  /** Replace only tasks belonging to a specific group, preserving other groups. */
  setTaskGroup: (threadId: string, group: string, tasks: readonly TaskItem[]) => void;
  /** Clear tasks for a thread (e.g. on deletion). */
  clearTasks: (threadId: string) => void;
  /** Apply new-turn lifecycle rules to the composer Task bubble. */
  prepareTaskBubbleForNewTurn: (threadId: string) => void;
  /** Clear kept unsettled tasks when a new turn ends without parent-task updates. */
  clearTaskBubbleIfAwaitingReplacement: (threadId: string) => void;
}

function parentTasks(tasks: readonly TaskItem[]): readonly TaskItem[] {
  return tasks.filter((task) => task.group === "Tasks");
}

function allTasksSettled(tasks: readonly TaskItem[]): boolean {
  return tasks.length > 0 && tasks.every(
    (task) => task.status === "completed" || task.status === "cancelled",
  );
}

/** Zustand store for per-thread task data. */
export const useTaskStore = create<TaskState>((set) => ({
  tasksByThread: {},
  taskBubbleByThread: {},
  pendingTaskBubbleReplacementByThread: {},
  setTasks: (threadId, tasks) =>
    set((s) => {
      const visible = parentTasks(tasks);
      const pending = { ...s.pendingTaskBubbleReplacementByThread };
      delete pending[threadId];
      return {
        tasksByThread: { ...s.tasksByThread, [threadId]: tasks },
        taskBubbleByThread: { ...s.taskBubbleByThread, [threadId]: visible },
        pendingTaskBubbleReplacementByThread: pending,
      };
    }),
  setTaskGroup: (threadId, group, tasks) =>
    set((s) => {
      const existing = s.tasksByThread[threadId] ?? [];
      const otherGroups = existing.filter((t) => t.group !== group);
      const pending = { ...s.pendingTaskBubbleReplacementByThread };
      if (group === "Tasks") delete pending[threadId];
      return {
        tasksByThread: { ...s.tasksByThread, [threadId]: [...otherGroups, ...tasks] },
        ...(group === "Tasks"
          ? { taskBubbleByThread: { ...s.taskBubbleByThread, [threadId]: tasks } }
          : {}),
        pendingTaskBubbleReplacementByThread: pending,
      };
    }),
  clearTasks: (threadId) =>
    set((s) => {
      const next = { ...s.tasksByThread };
      const nextBubble = { ...s.taskBubbleByThread };
      const nextPending = { ...s.pendingTaskBubbleReplacementByThread };
      delete next[threadId];
      delete nextBubble[threadId];
      delete nextPending[threadId];
      return {
        tasksByThread: next,
        taskBubbleByThread: nextBubble,
        pendingTaskBubbleReplacementByThread: nextPending,
      };
    }),
  prepareTaskBubbleForNewTurn: (threadId) =>
    set((s) => {
      const visible = s.taskBubbleByThread[threadId] ?? parentTasks(s.tasksByThread[threadId] ?? []);
      const nextBubble = { ...s.taskBubbleByThread };
      const nextPending = { ...s.pendingTaskBubbleReplacementByThread };
      if (visible.length === 0 || allTasksSettled(visible)) {
        delete nextBubble[threadId];
        delete nextPending[threadId];
      } else {
        nextBubble[threadId] = visible;
        nextPending[threadId] = true;
      }
      return {
        taskBubbleByThread: nextBubble,
        pendingTaskBubbleReplacementByThread: nextPending,
      };
    }),
  clearTaskBubbleIfAwaitingReplacement: (threadId) =>
    set((s) => {
      if (!s.pendingTaskBubbleReplacementByThread[threadId]) return {};
      const nextBubble = { ...s.taskBubbleByThread };
      const nextPending = { ...s.pendingTaskBubbleReplacementByThread };
      delete nextBubble[threadId];
      delete nextPending[threadId];
      return {
        taskBubbleByThread: nextBubble,
        pendingTaskBubbleReplacementByThread: nextPending,
      };
    }),
}));

if (import.meta.env.DEV && typeof window !== "undefined") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__taskStore = {
    get state() { return useTaskStore.getState(); },
    setTasks: (threadId: string, tasks: readonly TaskItem[]) =>
      useTaskStore.getState().setTasks(threadId, tasks),
    setTaskGroup: (threadId: string, group: string, tasks: readonly TaskItem[]) =>
      useTaskStore.getState().setTaskGroup(threadId, group, tasks),
    clear: (threadId: string) => useTaskStore.getState().clearTasks(threadId),
  };
}
