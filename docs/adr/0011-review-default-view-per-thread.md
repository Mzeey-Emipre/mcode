---
status: proposed
---

# The Review tab's default view is chosen per thread from change state, and a manual pick sticks

## Context

Today `viewMode` in `diffStore` is a single **global**, **unpersisted** field.
`defaultReviewView(scope)` returns `last-turn` for a thread and `unstaged`
threadless, and the only auto-selection is a `DiffToolbar` effect that resets the
view when the current one falls out of the active scope. There is no per-thread
memory and no "the user picked this" flag.

The new thread [[Overview]] surfaces a **Changes** row that opens the Review tab.
When it opens, the view should land on what the user most likely wants for *that*
thread without forcing a manual pick, and without overriding a choice they have
already made. The originating request was "default to branch view if the user
hadn't previously modified it"; grilling refined that into a change-state default
plus a sticky per-thread override.

## Decision

On opening the Review tab for a thread, the default view is chosen from the
thread's **change state**:

- the thread has **turn-registered changes** (at least one turn snapshot with
  changed files - the same signal the header's `changedFileCount` already uses)
  -> **Last turn**
- else the **working tree is dirty** (manual edits, no turn) -> **Unstaged**
- else (clean) -> **Branch**

The default **re-evaluates live** as change state changes - the first turn's
changes flip Branch -> Last turn - **until the user picks a view** from the
switcher. A manual pick sets a **per-thread override** that sticks; after that,
no auto-defaulting happens for that thread.

The override is remembered **per thread, in memory only** (resets on app
restart). The mechanism mirrors the existing `branchManuallySelected` guard in
`workspaceStore`, which protects the composer branch picker from live
`branch.changed` events the same way.

## Considered Options

- **Two-way default (turn changes -> Last turn; else Branch).** The original
  cut. Rejected: a working tree dirtied only by manual edits with no turn would
  default to Branch, whose three-dot range (ADR-0007) shows only committed work
  and therefore **hides** those uncommitted edits. The three-way default closes
  the hole by routing manual-only dirt to Unstaged.
- **Compute once on open, never re-evaluate.** Rejected: a thread opened before
  its first turn would stay pinned to Branch even after the agent produced
  changes - the opposite of what the user is looking at the panel for.
- **Persist the per-thread override across restarts.** Deferred: `viewMode` is
  ephemeral today, so in-memory per-thread is cheap and enough for v1; durable
  storage is a clean later add.
- **Keep the single global `viewMode` (status quo).** Rejected: switching threads
  carries the previous thread's view, and there is no way to express a per-thread
  default at all.

## Consequences

- `diffStore` gains per-thread view state plus a per-thread override flag,
  replacing (or layering over) the single global `viewMode`. This is the
  costly-to-reverse part of the decision.
- The new default logic must coexist with the existing `DiffToolbar`
  scope-recovery effect, which still fires when the active view falls out of the
  current scope (for example thread -> threadless while on a turn-only view).
- `clearThread` must drop the thread's view and override entries so a deleted
  thread leaves no dangling state, mirroring the `rightPanelVisibleByThread`
  cleanup ADR-0004 already requires.
- The override resets on app restart, so a user who pinned Cumulative sees the
  change-state default again next launch until they re-pin. Acceptable for v1;
  revisit if it grates.
