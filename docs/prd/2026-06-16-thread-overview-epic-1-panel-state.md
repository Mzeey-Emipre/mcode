# PRD - Per-thread panel state

**Epic:** 1 of 4 (Thread Overview)
**GitHub:** epic #753; sub-issues #757 (Review default), #758 (panel container state)
**Date:** 2026-06-16
**Status:** ready-for-agent
**Arch spec:** [2026-06-16-thread-overview-design.md](../specs/2026-06-16-thread-overview-design.md)
**ADRs:** [0011](../adr/0011-review-default-view-per-thread.md), [0012](../adr/0012-right-panel-state-per-thread.md)

## Problem Statement

I work across several threads in a workspace. Today the Review tab and the right panel do not belong to the thread I am on. The Review view is a single global selection, so switching threads carries the previous thread's view. The panel's open tabs, width, and visibility bleed across sibling threads. When I open Changes for a thread, it does not land on the view that matches that thread's state - a thread whose agent just produced changes can still show Branch, which hides uncommitted work. I have to re-orient the panel every time I switch threads.

## Solution

Each thread remembers its own Review view and its own panel layout. When I open Changes, the Review tab lands on the view that fits that thread's change state: Last turn if the agent registered changes, Unstaged if I have manual edits with no turn, Branch if the tree is clean. The default keeps up with the thread live until I pick a view myself, after which my pick sticks for that thread. The panel's tabs, width, and visibility follow the thread, not the workspace, with a single workspace-level fallback so the threadless Browser/Terminal shell still works and a brand-new thread does not land on an empty panel.

## User Stories

1. As a developer switching between threads, I want each thread's Review tab to open on the view that matches its change state, so that I see the most relevant diff without re-selecting.
2. As a developer whose agent just produced its first turn, I want the Review default to flip from Branch to Last turn live, so that I am not stuck looking at a view that hides the new work.
3. As a developer with only manual edits and no turn yet, I want the Review default to be Unstaged, so that my uncommitted edits are visible rather than hidden behind Branch's committed-only range.
4. As a developer on a clean thread, I want the Review default to be Branch, so that I see the branch's committed work.
5. As a developer who picked a specific Review view, I want that pick to stick for that thread, so that auto-defaulting stops overriding my choice.
6. As a developer who picked a view on one thread, I want a sibling thread to keep its own default, so that my pick does not leak across threads.
7. As a developer, I want the right panel's open tabs to belong to each thread, so that opening a Terminal on thread A does not change what thread B shows.
8. As a developer, I want the panel width and active tab to follow the thread, so that each thread restores its own layout when I switch to it.
9. As a developer, I want panel visibility to be per-thread, so that opening the panel on one thread leaves it closed on its siblings.
10. As a developer opening a brand-new thread, I want it to inherit the workspace fallback layout on first open, so that it does not start on a blank panel.
11. As a developer who customizes a thread's panel, I want it to diverge from the fallback the moment I change it, so that my customization is the thread's own from then on.
12. As a developer with no thread open, I want the Browser/Terminal panel to still work against the workspace root, so that the threadless shell from ADR-0004 keeps functioning.
13. As a developer deleting a thread, I want its Review view, override flag, and panel state cleaned up, so that no dangling state survives.
14. As a developer who restarts the app, I want the change-state default to apply again until I re-pin, so that the in-memory reset is predictable.

## Implementation Decisions

- **Review default becomes a per-thread, change-state choice.** Extend `defaultReviewView` from the current 2-way (thread -> Last turn, threadless -> Unstaged) to the 3-way default in ADR-0011: turn-registered changes -> Last turn; else dirty working tree -> Unstaged; else -> Branch. The turn-changes signal is the same one the header's changed-file count already uses.
- **A sticky per-thread override.** `diffStore` gains per-thread Review view state plus a per-thread "user picked" flag. The default re-evaluates live until the flag is set; a manual pick sets it and stops auto-defaulting for that thread. The mechanism mirrors the existing `branchManuallySelected` guard in `workspaceStore`.
- **All panel container state goes per-thread** (visibility, width, active tab, open-tabs set), per ADR-0012, read through a copy-on-write accessor that falls back to one workspace-level record until the thread writes its own entry. This supersedes ADR-0004's per-thread-visibility / workspace-global-width-and-tab split; ADR-0004's singleton-tabs and per-tab-scope decisions still stand.
- **Cleanup.** `clearThread` drops the thread's Review view, override flag, and panel-state record.
- **In-memory only.** Both the override and the panel state reset on restart, consistent with the ADRs; durable storage is a clean later add.
- **Coexistence.** The new default logic must coexist with the existing `DiffToolbar` scope-recovery effect, which still fires when the active view falls out of the current scope.

## Testing Decisions

- A good test asserts external behavior - the view or panel state a thread shows after a sequence of actions - not the store's internal shape.
- **Modules tested:** `diffStore` (per-thread view, override, panel state, `clearThread` cleanup) and `review-views` (the extended `defaultReviewView`).
- **Prior art:** `diffStore.test.ts` already tests `clearThread` cleanup and the per-thread `getRightPanelVisible` accessor with a pure Zustand pattern (seed state, call action, read back). `review-views.test.ts` already tests `defaultReviewView` as a pure function. Extend both - no new test seam is needed.
- Cases to add: the 3-way default for each change state; the override stops live re-evaluation; the override is per-thread; the copy-on-write fallback resolves to the workspace record until a thread diverges; `clearThread` drops every per-thread entry.

## Out of Scope

- The Overview surface itself - this epic only moves the state model; the surface lands in Epic 2.
- Persisting the override or panel state across restarts.
- Changing tab content scopes (Browser/Terminal/Files/Review/Scope keep their ADR-0004 scopes).

## Further Notes

This epic ships store-only changes with no UI surface of its own, so it can land and be verified before any Overview UI depends on it. Epic 2's Changes row consumes the new default; the dependency is soft - the Changes row works without this epic, just with the old global default.
