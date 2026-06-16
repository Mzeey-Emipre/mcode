---
status: accepted
---

# The right panel splits its state: open/closed is per-thread, width and tab are workspace-global; singleton tabs keep their own scope

> **Proposed revision:** ADR-0012 moves *all* panel container state (including
> width and active tab) to per-thread, with a workspace-level fallback. If
> accepted, it supersedes the state-split decision below; the singleton-tabs and
> per-tab-scope decisions here still stand.

## Context

The right panel was entirely thread-scoped: `RightPanel.tsx` returns `null`
without an `activeThreadId`, and every bit of panel state (visibility, width,
active tab) lived in `diffStore`'s `rightPanelByThread: Record<threadId, ...>`.
`CONTEXT.md` reinforced this — Preview was defined as "thread-scoped: each
thread keeps its own set of tabs."

The revamp requires the panel to be usable **before any thread exists** — the
user can open a Browser or Terminal against the workspace from the empty app.
That breaks the "no thread → no panel" invariant the whole module was built on,
and forces a decision about where panel state lives and what scope each tab runs
against.

An initial revision of this ADR made *all* panel state workspace-global,
including open/closed. Product feedback rejected that: opening the panel on one
thread must not open it on a sibling thread in the same workspace. Whether the
panel is showing is a per-thread reading decision; only its **size and which tab
is selected** are workspace-level preferences worth sharing. The decision below
reflects that hybrid split.

## Decision

The **panel container** state is **split by concern**:

- **Open/closed (visibility) is per-thread.** Showing the panel on one thread
  leaves it closed on its siblings. This lives in `diffStore`'s
  `rightPanelVisibleByThread: Record<threadId, boolean>` (absent = closed).
- **Width and active tab are workspace-global.** They persist across threads and
  with no thread open, in the `rightPanelByWorkspace` slice.

When **no thread is active**, visibility falls back to the workspace slice's
`visible` field, so the threadless Browser/Terminal shell can be opened against
the workspace itself. The panel no longer returns `null` when there is no
thread.

Individual **tabs keep their own scope**, declared per tab type rather than
inherited from the panel:

- **Browser, Terminal, Files** run against the **workspace root** when no thread
  is active, and rebind to the thread's worktree when one exists.
- **Review** is dual-scope: its git-working-tree views (Unstaged/Staged/Commit/
  Branch) need no thread; its turn views (Last turn, Cumulative) need one.
- **Scope** is thread-only and is simply unavailable threadless.

Every top-level tab is a **singleton** — at most one Browser, Terminal, Review,
Files, Scope. Multiplicity lives *inside* a tab (Browser pages, Terminal
shells), never as duplicate top-level tabs. The creatable-types set is filtered
by scope then by cardinality; when one type is creatable the add affordance
opens it directly, when none are it is hidden.

## Considered Options

- **Keep the panel fully thread-scoped (rejected).** Status quo; makes the
  threadless Browser/Terminal requirement impossible.
- **Make the whole panel container workspace-global, including open/closed
  (rejected).** Simpler state, but opening the panel on one thread would open it
  on every sibling thread in the same workspace. Product feedback called this
  wrong: visibility is a per-thread reading choice, not a shared workspace
  preference.
- **Make everything fully workspace-scoped (rejected).** Detaches tabs from
  threads entirely, discarding the per-thread Preview/Terminal model the rest of
  the app and the existing stores depend on, and breaking "each thread keeps its
  own tabs."
- **Split the state: per-thread visibility, workspace-global width and tab
  (chosen).** Keeps the per-thread open/closed feel users expect while sharing
  the size and tab selection — the two settings users do not want to re-set on
  every thread — and still supports a threadless shell via the workspace slice.
- **Allow multiple top-level tabs of the same type (rejected).** Duplicate
  Browser/Terminal tabs at the panel level would make the "add" menu never empty
  and contradict the existing internal page/shell pooling. Singleton tabs with
  internal multiplicity match both the Codex pattern and mcode's current
  `PreviewTabBar` / `TerminalPoolHost`.

## Consequences

- `rightPanelByThread` is replaced by two slices: `rightPanelByWorkspace`
  (width, active tab, and the threadless `visible` fallback) and
  `rightPanelVisibleByThread` (per-thread open/closed). This is the
  costly-to-reverse part of the decision.
- Panel **visibility is per-thread**, but **width and tab are workspace-global**,
  and tab *contents* keep their own scope — a deliberate three-way split that a
  future reader should not "simplify" into a single scope. Read effective
  visibility through `getRightPanelVisible(workspaceId, threadId?)`, never by
  reaching into either slice directly.
- `clearThread` must drop the thread's `rightPanelVisibleByThread` entry so a
  deleted thread does not leave a dangling open/closed bit.
- Threadless tabs need a cwd; they resolve to the active workspace root, and are
  unavailable when there is no workspace at all.
- The `CONTEXT.md` "Preview is thread-scoped" language is superseded; Preview is
  now the Browser tab type within this panel.
