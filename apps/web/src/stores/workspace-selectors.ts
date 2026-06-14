import { useShallow } from "zustand/shallow";
import { useWorkspaceStore } from "./workspaceStore";
import type { WorkspaceThread } from "@/lib/workspace-thread";

/** Resolve one thread row from the workspace store threads list. */
export function getWorkspaceThread(
  threads: WorkspaceThread[],
  threadId: string | null | undefined,
): WorkspaceThread | undefined {
  if (!threadId) return undefined;
  return threads.find((t) => t.id === threadId);
}

/**
 * Subscribe to one workspace thread row with shallow equality on the selected slice.
 * Re-renders only when the selected slice for this thread changes, not when other
 * threads update.
 */
export function useWorkspaceThread<T>(
  threadId: string | null | undefined,
  selector: (thread: WorkspaceThread | undefined) => T,
): T {
  return useWorkspaceStore(
    useShallow((state) => {
      const thread = getWorkspaceThread(state.threads, threadId);
      return selector(thread);
    }),
  );
}

/**
 * Subscribe to the active workspace thread row with shallow equality on the selected slice.
 */
export function useActiveWorkspaceThread<T>(
  selector: (thread: WorkspaceThread | undefined) => T,
): T {
  return useWorkspaceStore(
    useShallow((state) => {
      const thread = getWorkspaceThread(state.threads, state.activeThreadId);
      return selector(thread);
    }),
  );
}

/** Imperative read of one workspace thread row without subscribing. */
export function readWorkspaceThread(threadId: string): WorkspaceThread | undefined {
  return getWorkspaceThread(useWorkspaceStore.getState().threads, threadId);
}

/** IDs of threads whose server status is interrupted. */
export function useInterruptedThreadIds(): string[] {
  return useWorkspaceStore(
    useShallow((state) =>
      state.threads.filter((t) => t.status === "interrupted").map((t) => t.id),
    ),
  );
}

/** Whether a parent thread row still exists in the sidebar list. */
export function useParentThreadExists(parentThreadId: string | null | undefined): boolean {
  return useWorkspaceStore(
    useShallow((state) =>
      parentThreadId ? state.threads.some((t) => t.id === parentThreadId) : false,
    ),
  );
}
