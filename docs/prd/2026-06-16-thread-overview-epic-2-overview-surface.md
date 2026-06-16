# PRD - Thread Overview surface and git/context rows

**Epic:** 2 of 4 (Thread Overview)
**GitHub:** epic #754; sub-issues #759-#767
**Date:** 2026-06-16
**Status:** ready-for-agent
**Arch spec:** [2026-06-16-thread-overview-design.md](../specs/2026-06-16-thread-overview-design.md)
**ADRs:** consumes [0011](../adr/0011-review-default-view-per-thread.md) (soft), [0012](../adr/0012-right-panel-state-per-thread.md)

## Problem Statement

The thread header tells me almost nothing about the thread I am in. The `header-workspace-menu` is a thin dropdown - Changes, Branch, Commit-or-push, Create PR - and the rest of the thread's context is invisible. I cannot see, in one place, what repository the thread targets, which worktree and branch it runs on, how much provider budget is left, or the live PR and CI state. I have to hunt across the sidebar, the composer status bar, and the PR button to assemble a picture of a single thread.

## Solution

The `header-workspace-menu` becomes a thread-scoped popover, the Overview (`ThreadOverview`), that recaps the thread and hosts its git and context rows in one vertical list: a Recap slot (filled by Epic 3), Changes (opens the Review tab on this thread's default view), Repository (the `org/repo` it targets, opens in the browser), PR (live status with commit-or-push, create PR, and open PR), Mode (the worktree and branch, with copy), Usage (the active provider's quota and cost), and Create branch (a new branch created and checked out in place). A small CI status dot on the trigger shows red when checks are failing and green when they pass, scoped to the active thread, visible without opening the popover.

## User Stories

1. As a developer, I want a single Overview popover on the thread header, so that I can see and act on the whole thread context in one place.
2. As a developer, I want the Overview to show my thread's changed-file count and open the Review tab, so that I can jump straight to the diff.
3. As a developer, I want the Review tab to land on my thread's default view when I open it from the Overview, so that I see the most relevant diff without re-selecting (consumes Epic 1).
4. As a developer, I want the Overview to show the repository the thread targets as `org/repo`, so that I know which remote my work lands on.
5. As a developer, I want to click the repository row to open the remote in my browser, so that I can reach the GitHub page without copying a URL.
6. As a developer on a thread with no remote, I want the repository row to fall back to the folder name, so that the row is still meaningful for a local-only repo.
7. As a developer, I want the Overview to show my PR's live status and CI, so that I know whether my branch is mergeable.
8. As a developer with uncommitted work, I want a commit-or-push action in the Overview, so that I can push without leaving the thread.
9. As a developer with commits ahead and no PR, I want a Create PR action in the Overview, so that I can open a PR in place.
10. As a developer with an open PR, I want to open it from the Overview, so that I can reach the PR page directly.
11. As a developer, I want the Overview to show my thread's worktree path and branch, so that I know where the code lives.
12. As a developer, I want to copy the branch name from the Overview, so that I can paste it elsewhere.
13. As a developer, I want the Overview to show my active provider's usage and cost, so that I can judge remaining budget for this thread.
14. As a developer on a provider without usage reporting, I want the Usage row to say usage is unavailable, so that the row degrades cleanly rather than erroring.
15. As a developer, I want to create a new branch from the Overview that is created and checked out in place, so that I can branch this thread without a fork.
16. As a developer, I want the new-branch action to reject unsafe branch names, so that I cannot inject arguments into the git command.
17. As a developer, I want a CI status dot on the Overview trigger, so that I can see at a glance whether my thread's checks are failing or passing without opening the popover.
18. As a developer, I want the CI dot to show nothing when there is no PR or checks are pending, so that the signal is meaningful only when it matters.
19. As a developer, I want the Overview to be scoped to the active thread, so that it always reflects the thread I am looking at.

## Implementation Decisions

- **Enrich, do not replace blindly.** `HeaderActions.tsx`'s `header-workspace-menu` becomes `ThreadOverview`, a popover. The existing PR affordances (`PrSplitButton`, `ChecksPopover`, `CreatePrDialog`) and the `useThreadGitActions(thread)` data (`prable`, `pr`, `hasCommitsAhead`, `checks`, `openPrDetail`, `dirPath`, commit-or-push, open-PR) are reused, not rebuilt.
- **New RPC `git.getRemoteUrl`.** `GitService.getRemoteUrl(path)` runs `git remote get-url origin`, normalizes SSH and `.git` suffixes to an https web URL, derives the `org/repo` label, and falls back to the directory basename with a null URL when there is no remote. Normalization is server-side, validated once at the boundary. Follows the `diffSummary.*` wiring idiom (WS_METHODS entry, router case, named transport wrapper).
- **New RPC `git.createBranch`.** `GitService.createBranch(path, name)` runs `git checkout -b <name>` (create plus checkout). The name is validated against a git-ref allowlist before exec (reject empty, leading `-`, whitespace, `..`, shell metacharacters); fail closed. Returns the created branch.
- **Usage row reuses the existing path.** It reads `usageByProvider[thread.provider]` from the thread record, already populated by `fetchProviderUsage`. No new fetch and no new server code; providers without `getUsage` already return an empty-but-valid shape.
- **CI blob is a pure derivation.** `(pr, checks) -> "red" | "green" | null` over the `checks`/`pr` already in `useThreadGitActions`. Red when failing, green when all passed, null otherwise. Active-thread scope.
- **Changes row** triggers the existing `changes.toggle` command and relies on Epic 1 for the per-thread default (soft dependency - works without it).

## Testing Decisions

- A good test asserts what the user sees and the side effect they trigger, not the component internals.
- **Modules tested:** `GitService` (`getRemoteUrl`, `createBranch`), the CI-blob pure function, and the `ThreadOverview` popover behavior.
- **Prior art:** `GitService` tests use an injected mock git executor (`git-service-push.test.ts`) - assert the SSH->https normalization output, the folder-name fallback, the exec args for `createBranch`, and that the arg-injection guard fires on an unsafe name. The CI blob is a trivial pure function test. For the popover, extend `chat-header-consolidated.spec.ts` (it already drives `header-workspace-menu` -> `workspace-menu-changes`) and follow `sidebar-usage-popover.spec.ts` for popover mechanics (mock WS, inject Zustand, open, assert `[data-slot="popover-content"]`, dismiss). Cover: each row renders, Changes opens Review, Repository opens the remote, the PR actions appear when applicable, the CI dot shows red and green.

## Out of Scope

- The Recap row content and its generation - Epic 3 fills the slot.
- The Fork group and Switch provider - Epic 4.
- Removing the now-redundant chrome (header project/workspace badge, composer status bar) - a fast-follow after the Overview ships.
- Implementing `getUsage` for Codex and Cursor - the row degrades gracefully; this is a later add.

## Further Notes

This epic is the shell every other row plugs into. It depends softly on Epic 1 (the Changes row's default) and hard-blocks Epics 3 and 4, which fill the Recap slot and the continuation actions respectively. The two new git RPCs are the only net-new server contracts here; everything else reuses an existing path.
