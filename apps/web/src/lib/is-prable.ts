import type { Thread } from "@/transport";

/**
 * Returns whether a thread can have a pull request through this app.
 *
 * A thread is PR-able only when it runs in an isolated worktree. Direct-mode
 * (local) threads run against the workspace's main checkout and are never
 * PR-able: there is nothing to open a pull request from. This is the single
 * source of truth shared by the sidebar thread list and the chat header so the
 * two surfaces can never disagree about whether to show PR affordances.
 */
export function isPrable(thread: Pick<Thread, "mode">): boolean {
  return thread.mode === "worktree";
}
