# Review Files Navigator

**Date:** 2026-07-20
**Status:** Specification
**Related glossary:** [Mcode context](../../CONTEXT.md)
**Related ADRs:** [Review default view](../adr/0011-review-default-view-per-thread.md), [Right-panel state](../adr/0012-right-panel-state-per-thread.md)

## Problem Statement

The Review tab's Files navigator currently opens automatically on wide layouts
and lists the complete worktree. That list does not match the active
Comparison, refreshes independently from the displayed diff, and performs work
even when the user did not ask to browse files. Expanded folders also retain a
selection-like background in both Review and pull request trees.

Users need an optional Files navigator that describes the exact diff they are
reviewing. Its contents, refresh lifecycle, status metadata, and selection must
remain aligned with the active Comparison without duplicate file-list requests.

## Solution

Keep the stable surface name **Files**. New Review scopes start with Files
closed. Once a user opens Files, that choice persists for the same thread or
workspace until the user closes it, including across app restarts.

The navigator lists only the files in the active Comparison. It uses the same
resolved comparison result as the diff, includes batched change-status
metadata, and performs no independent full-worktree read. A manual refresh
updates the diff and Files from one result while keeping the prior result
visible until the replacement is ready. Automatic refresh runs only after a
turn reports real file changes.

Folders start expanded because Files is a diff index. User-collapsed folders
stay collapsed across refreshes, while new folders start expanded. Expanded
folders do not receive a persistent background in either Review or pull request
trees. Hover, keyboard focus, and active-file selection remain visible.

## User Stories

1. As a reviewer, I want Files closed when I first open a Review scope, so that the diff gets the full inspection width.
2. As a reviewer, I want to open Files only when I need navigation, so that optional chrome does not compete with the diff.
3. As a returning reviewer, I want my Files visibility choice restored for each thread or workspace, so that the interface changes only when I change it.
4. As a reviewer, I want Files to list only the active Comparison's changed files, so that every listed path has a corresponding diff.
5. As a reviewer switching Review views, I want Files to update to the newly selected Comparison, so that stale paths never describe another diff.
6. As a reviewer, I want added, modified, deleted, renamed, copied, and binary changes identified, so that I can scan the nature of the Change stack.
7. As a reviewer, I want renamed files shown as their old and new paths, so that the change remains understandable without opening its diff.
8. As a reviewer of All turns, I want Files to reflect the cumulative net effect, so that files with no remaining net change are omitted.
9. As a reviewer, I want folders expanded when Files first opens, so that the changed paths are immediately visible.
10. As a reviewer, I want folders I collapse to remain collapsed after refresh, so that refresh does not undo my navigation choices.
11. As a reviewer, I want newly appearing folders expanded, so that fresh changes are visible without extra clicks.
12. As a keyboard user, I want tree focus and navigation semantics preserved, so that removing expanded-state highlighting does not weaken accessibility.
13. As a reviewer, I want active-file selection to remain distinct from folder expansion, so that I can tell which diff is active.
14. As a reviewer, I want one refresh to update the diff and Files together, so that the two projections cannot disagree.
15. As a reviewer, I want the existing result to remain visible during refresh, so that the panel does not flicker or lose my place.
16. As a reviewer, I want a subtle refresh indication, so that I know a replacement result is loading.
17. As a reviewer of an immutable commit, I do not want a no-op Refresh action, so that every visible action has an effect.
18. As a user running an agent, I want automatic Review refresh only after a turn with real file changes, so that no-op turns do not cause unnecessary work.
19. As a user with a large Change stack, I want Files virtualized, so that the DOM remains bounded while I scroll.
20. As a pull request reviewer, I want expanded folders to avoid selection-like backgrounds, so that expansion and selection have distinct visual meanings.

## Implementation Decisions

- The stable surface name is **Files**. The current source is the active
  Comparison. A future Project source may browse the full project without
  renaming the surface.
- The active Comparison resolves one bounded file-change collection that feeds
  both the inline diff and Files. The Changes source does not call the complete
  worktree file-list endpoint.
- Each comparison file record carries its path and change status in the batched
  result. Rename and copy records may also carry the previous path. Binary is
  represented without a per-file content request.
- Git-backed comparisons resolve their file metadata in bounded git operations.
  Snapshot-backed comparisons reuse persisted file-effect metadata. Neither
  path adds an N+1 request per file.
- All turns uses cumulative net semantics. It derives the status between the
  first before-state and final after-state, follows rename chains from original
  to final path, and omits changes that cancel out.
- Files visibility belongs to the existing per-thread panel record with the
  workspace fallback used for threadless Review. A scope with no explicit Files
  choice starts closed. Opening or closing Files records an explicit choice.
- Files remains open across Review-view changes and app restarts until the user
  closes it. The choice does not become a global preference.
- Directory expansion starts with every current directory expanded. A user's
  collapsed-directory set is preserved across comparison refreshes. New
  directory identifiers are expanded by default.
- The shared tree suppresses the generic expanded Button background only for
  directory rows. Hover, focus-visible, and active-file states remain intact.
- Manual refresh is a comparison-level operation. Mutable comparisons reload;
  immutable Commit comparisons do not expose Refresh.
- Refresh retains the settled comparison until the replacement succeeds, shows
  restrained progress, then publishes the new diff and Files collection in one
  state transition. A failed refresh retains the settled result and permits
  retry.
- Turn completion triggers automatic comparison invalidation only when the
  persisted turn reports at least one changed file. File autocomplete cache
  invalidation remains correct for real changes.
- The closed Files navigator is not mounted and performs no tree construction.
  Trees above the existing threshold remain virtualized with bounded overscan.
- File rows show change-status metadata but do not add per-file addition and
  deletion counts in this change.

## Testing Decisions

- The primary seam is the Review panel. A component integration test opens
  Files, changes Review views, triggers refresh, and observes that the diff and
  Files publish one matching comparison result.
- Review panel tests cover closed-first-paint behavior, per-scope persistence,
  user-only closing, immutable Commit refresh visibility, stale-while-refresh,
  and the absence of complete-worktree file requests.
- The shared Files tree component covers default expansion, preserved manual
  collapses, newly appearing folders, rename labels, status indicators,
  keyboard semantics, active-file selection, and the absence of a persistent
  expanded-folder background in both consumers.
- Service tests cover batched Git comparison metadata and the absence of
  per-file request fan-out. Worked fixtures include added, modified, deleted,
  renamed, copied, and binary files.
- Snapshot comparison tests cover Last turn status metadata and All turns net
  semantics, including rename chains and a file whose changes cancel out.
- Event-flow tests cover one no-change turn and one changed-file turn. Only the
  changed-file turn invalidates Review and file autocomplete data.
- A live browser check opens Review at wide and compact widths, confirms Files
  starts closed, opens it, switches comparisons, refreshes, exercises folder
  and keyboard navigation, and checks both themes and console output.
- Performance verification confirms that closed Files adds no request or tree
  work, open Files adds no duplicate comparison request, large trees keep a
  bounded DOM, and the pull request performance gate remains green.
- Tests assert user-visible state and transport call counts at public
  boundaries. They do not assert private React state or duplicate framework
  behavior.

## Out of Scope

- Browsing every project file from Files.
- Adding a Changes or Project source picker before Project browsing exists.
- Per-file addition and deletion counts in Files.
- Changing pull request file filtering or pull request data loading.
- Changing the inline diff's visual language or Review view catalog.
- Persisting individual folder expansion choices across app restarts.

## Further Notes

- The existing pull request changed-files tree is the visual and interaction
  reference. This is a scoped correction, not a new visual direction.
- The implementation must follow the performance audit: virtualize long lists,
  keep IPC bounded, subscribe to narrow store slices, and avoid mounting hidden
  work.
- No ADR is required. The change deepens the existing Comparison and
  per-thread panel-state decisions without introducing a costly architectural
  alternative that would be surprising without this spec.
