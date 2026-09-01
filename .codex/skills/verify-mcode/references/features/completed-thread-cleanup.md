# Completed-thread cleanup

## Sub-features

- A user can complete an idle worktree thread from the Project tree.
- The thread moves from Active to Completed.
- Completion persists a deletion schedule.
- Cleanup removes a managed worktree and its thread data after the retention period.
- Cleanup keeps user-owned or unsafe worktrees.

## How to get to it (user POV)

1. Open a project that has an idle worktree thread.
2. Select `Complete <thread title>` in the Project tree.
3. Open the completed thread view.
4. Confirm that the thread remains visible as completed.

## Driving it with verify-mcode

Run `thread-lifecycle proof --confirm-cleanup`. The harness creates a disposable worktree thread in Electron's fixture project. It uses Electron to select the same completion control that a user selects. The receipt records the completed timestamp and deletion schedule. `thread-lifecycle check` runs the cleanup-worker integration tests that prove later deletion.

## Gotchas

- A completed thread is retained for at least one day.
- The live proof does not alter the system clock or wait for retention expiry.
- The harness deletes only its generated thread, worktree, and evidence. It preserves the fixture project.
