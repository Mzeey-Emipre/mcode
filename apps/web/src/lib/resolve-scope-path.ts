/** Minimal shape of a thread row needed to resolve its base path. */
interface ScopeThread {
  readonly id: string;
  readonly mode: "direct" | "worktree";
  readonly worktree_path: string | null;
}

/** Minimal shape of a workspace row needed to resolve its base path. */
interface ScopeWorkspace {
  readonly id: string;
  readonly path: string;
}

/**
 * Resolve the local filesystem base path a panel tab (Browser/Terminal) runs
 * against for a given scope.
 *
 * Mirrors the server's `GitService.resolveWorkingDir`: a thread in worktree
 * mode binds to its worktree, while direct threads and the threadless
 * new-thread view (where the scope is a workspace, not a thread) bind to the
 * workspace root. This is what lets the Browser and Terminal run against the
 * workspace root with no thread and rebind to the thread's worktree once one
 * becomes active.
 *
 * @param scopeId - The panel scope id: a thread id when a thread is active, or
 *   a workspace id for the threadless shell. Null when no scope is resolved.
 * @param workspaceId - Active workspace id that owns the scope.
 * @param threads - All known threads in the workspace store.
 * @param workspaces - All known workspaces in the workspace store.
 * @returns The absolute base path, or null when the owning workspace is unknown.
 */
export function resolveScopeBasePath(
  scopeId: string | null,
  workspaceId: string | null | undefined,
  threads: readonly ScopeThread[],
  workspaces: readonly ScopeWorkspace[],
): string | null {
  const workspacePath =
    workspaces.find((w) => w.id === workspaceId)?.path ?? null;
  const thread = threads.find((t) => t.id === scopeId);
  if (thread?.mode === "worktree" && thread.worktree_path) {
    return thread.worktree_path;
  }
  return workspacePath;
}
