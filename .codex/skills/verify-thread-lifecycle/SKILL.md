---
name: verify-thread-lifecycle
description: Verify the user flow for completing a thread and its managed-worktree cleanup. Use after changes to thread completion, retention cleanup, thread deletion, or managed worktree cleanup.
---

# Verify Thread Lifecycle

Use this skill before merge when a user can complete, reopen, delete, or clean up a thread worktree.

1. Run `bun run --cwd apps/desktop build`.
2. Run `bun .codex/skills/electorn-live-testing/scripts/ensure-playwright.mjs`.
3. Run `bun .codex/skills/verify-thread-lifecycle/scripts/verify-thread-lifecycle.mjs health`.
4. Run `check` for the focused completion, cleanup, worktree-safety, and Project Tree tests.
5. Run `proof --confirm-cleanup`. It creates a managed worktree thread in Electron's fixture project, clicks its `Complete <title>` control in Electron, and records a screenshot plus the persisted completion state.
6. Run `inspect` and read the receipt. Confirm that the thread was completed through the desktop UI and scheduled for deletion.
7. Run `cleanup --confirm-cleanup` after you no longer need the receipt and screenshot.

The app retains completed threads for at least one day. `proof` does not wait for that period. The focused integration checks prove the later retention-worker cleanup with a controlled clock and disposable Git repositories.

Read `references/features/README.md` before a regression pass. Read `references/features/completed-thread-cleanup.md` for this workflow.
