import type { WorktreeInfo } from "@/transport/types";

const DETACHED_WORKTREE_BRANCH = "(detached)";

/** Normalizes a worktree path for UI-side matching. */
export function normalizeWorktreePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
}

/** Returns true when git reports the worktree without a named branch. */
export function isDetachedWorktree(
  worktree: Pick<WorktreeInfo, "branch"> | null | undefined,
): boolean {
  return worktree?.branch === DETACHED_WORKTREE_BRANCH;
}

/** Returns the branch-facing label for a worktree picker row. */
export function worktreeBranchLabel(
  worktree: Pick<WorktreeInfo, "branch">,
): string {
  return isDetachedWorktree(worktree) ? "HEAD" : worktree.branch;
}
