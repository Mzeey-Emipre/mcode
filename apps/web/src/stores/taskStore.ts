import { create } from "zustand";

/** Status of an individual task item. */
export type TaskStatus = "pending" | "in_progress" | "completed";

/** Valid task status values for runtime validation. */
const VALID_TASK_STATUSES = new Set<string>(["pending", "in_progress", "completed"]);

/** Coerce an unknown status string to a valid TaskStatus, defaulting to "pending". */
export function coerceTaskStatus(raw: unknown): TaskStatus {
  const s = String(raw ?? "");
  return VALID_TASK_STATUSES.has(s) ? (s as TaskStatus) : "pending";
}

/** A single task item within a group. */
export interface TaskItem {
  readonly id: string;
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
  /** Replace all tasks for a thread. */
  setTasks: (threadId: string, tasks: readonly TaskItem[]) => void;
  /** Clear tasks for a thread (e.g. on deletion). */
  clearTasks: (threadId: string) => void;
}

/** Zustand store for per-thread task data. */
export const useTaskStore = create<TaskState>((set) => ({
  tasksByThread: {},
  setTasks: (threadId, tasks) =>
    set((s) => ({ tasksByThread: { ...s.tasksByThread, [threadId]: tasks } })),
  clearTasks: (threadId) =>
    set((s) => {
      const next = { ...s.tasksByThread };
      delete next[threadId];
      return { tasksByThread: next };
    }),
}));

if (import.meta.env.DEV && typeof window !== "undefined") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__taskStore = {
    get state() { return useTaskStore.getState(); },
    setTasks: (threadId: string, tasks: readonly TaskItem[]) =>
      useTaskStore.getState().setTasks(threadId, tasks),
    clear: (threadId: string) => useTaskStore.getState().clearTasks(threadId),
  };
}
