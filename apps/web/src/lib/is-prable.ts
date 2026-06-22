import type { Thread } from "@/transport";

/**
 * Returns whether a thread can have a pull request through this app.
 *
 * A thread is PR-able only after it runs on a publishable branch. Internal
 * worktree branches keep agent execution isolated, but the user should create
 * a named branch before opening a pull request.
 */
export function isPrable(thread: Pick<Thread, "mode" | "branch">): boolean {
  return thread.mode === "worktree" && !isInternalWorktreeBranch(thread.branch);
}

/** Returns whether a branch is an app-generated worktree implementation detail. */
export function isInternalWorktreeBranch(branch: string | null | undefined): boolean {
  return !branch || /^mcode-[a-z0-9]{8}$/.test(branch);
}
