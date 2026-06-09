---
status: accepted
---

# The right panel is workspace-global with singleton tabs; tab contents keep their own scope

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

## Decision

The **panel container** becomes **workspace-global**: visibility, width, and
active tab persist with no thread open. The panel no longer returns `null` when
there is no thread.

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
- **Make everything fully workspace-scoped (rejected).** Detaches tabs from
  threads entirely, discarding the per-thread Preview/Terminal model the rest of
  the app and the existing stores depend on, and breaking "each thread keeps its
  own tabs."
- **Allow multiple top-level tabs of the same type (rejected).** Duplicate
  Browser/Terminal tabs at the panel level would make the "add" menu never empty
  and contradict the existing internal page/shell pooling. Singleton tabs with
  internal multiplicity match both the Codex pattern and mcode's current
  `PreviewTabBar` / `TerminalPoolHost`.

## Consequences

- `rightPanelByThread` migrates to a workspace-global slice plus per-tab content
  scope. This is the costly-to-reverse part of the decision.
- Panel state is global but tab *contents* are scoped — a deliberate split that
  a future reader should not "simplify" into one or the other.
- Threadless tabs need a cwd; they resolve to the active workspace root, and are
  unavailable when there is no workspace at all.
- The `CONTEXT.md` "Preview is thread-scoped" language is superseded; Preview is
  now the Browser tab type within the workspace-global panel.
