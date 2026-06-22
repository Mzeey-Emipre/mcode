---
status: proposed
---

# Branchless worktrees for new isolated threads

New isolated threads should create a branchless worktree from a selected base
branch, then let the user create a named branch only when that branch matters.
This removes upfront Auto, Custom, and AI branch-naming decisions from the
composer while keeping the thread isolated from the workspace checkout.

## Decision

`New worktree` creates a branchless worktree from the user's selected base
branch. The thread records an explicit checkout state so callers know whether
the worktree is on a named branch or on `HEAD` from a saved base branch.

Branchless threads are not PR-able until a named branch exists. `Create branch`
turns the same worktree into a normal branch worktree in place. `Create PR` on a
branchless thread first asks for a branch name, creates the branch, then
continues through the PR flow.

Review comparisons for branchless worktrees use the saved base branch as the
base and `HEAD` as the target. Review may temporarily compare another base to
`HEAD`, but that picker state does not change the thread's saved base branch.

## Consequences

- The composer keeps `New worktree` and its base-branch picker, but drops the
  upfront branch-name controls.
- `worktree.naming.*` settings should disappear from the UI and docs. Existing
  persisted settings remain tolerated during load and migration.
- Overview shows branchless worktrees as `HEAD` from the selected base branch
  and makes `Create branch` the next git action.
- PR, push, commits-ahead polling, and PR-check polling must key off checkout
  state instead of treating every worktree thread as PR-able.
- The implementation should expose one canonical checkout-state contract rather
  than spreading `branch === "HEAD"` checks across Review, Overview, PR actions,
  and git services.
