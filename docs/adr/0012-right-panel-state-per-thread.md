---
status: proposed
---

# Right-panel container state is per-thread, with a workspace-level fallback for the threadless and not-yet-customized cases

> **Terminal revision:** ADR-0020 supersedes the Terminal singleton and
> internal-multiplicity decision retained below. Other tool types remain
> singletons.

## Context

ADR-0004 split the panel container state: open/closed per-thread, but **width
and active tab workspace-global**, so "the two settings users do not want to
re-set on every thread" would be shared, while a threadless shell stayed
possible. Open-tabs and active-tab therefore persist across thread switches: open
a Terminal on thread A and it is still the active tab when you move to thread B.

Product judgment has shifted. A thread is a self-contained unit of work -
reinforced by the new [[Overview]] - and its panel layout (which tabs are open,
which is active, how wide, whether it is showing) should belong to the thread,
not bleed across siblings. Switching threads should restore *that* thread's
panel, not carry the previous thread's tabs. The one requirement from ADR-0004
that still stands: the panel must work with **no thread** (Browser/Terminal
against the workspace root).

## Decision

**All** panel container state - visibility, width, active tab, and the open-tabs
set - is **per-thread**.

A single **workspace-level fallback** record of the same shape is used in two
cases:

1. **Threadless** - when no thread is active, the panel reads and writes the
   fallback, preserving ADR-0004's workspace-root Browser/Terminal shell.
2. **Not-yet-customized thread** - a thread with no saved panel state inherits
   the fallback on first open, then **diverges the moment it changes any panel
   state**, after which its own per-thread record is authoritative.

This single mechanism removes ADR-0004's main objection: an untouched thread
shows the fallback set, so you do not re-open Terminal on every thread; the split
only happens once you deliberately customize a thread's panel.

Unchanged from ADR-0004: tabs are **singletons** with internal multiplicity
(Browser pages, Terminal shells); each **tab type keeps its own content scope**
(Browser/Terminal/Files against the workspace root or the thread worktree; Review
dual-scope; Scope thread-only). This ADR revises only *where the container state
lives*.

## Considered Options

- **Keep ADR-0004's split (per-thread visibility, workspace-global width + active
  tab).** Rejected by current product judgment: carrying the previous thread's
  open tabs and active tab into a different thread is the exact friction being
  removed.
- **Per-thread tabs but keep width workspace-global (the first, narrow
  revision).** Rejected: width should follow the thread too, so the whole
  container state lives at one scope instead of being split across two.
- **Everything per-thread with no fallback.** Rejected: breaks the threadless
  panel ADR-0004 deliberately enabled (no tab set when no thread) and lands every
  new thread on an empty panel.

## Consequences

- ADR-0004's `rightPanelByWorkspace` (width, active tab) plus
  `rightPanelVisibleByThread` split is replaced by a **per-thread panel-state
  map** plus **one workspace-level fallback record**. This re-introduces a
  per-thread container store (closer to the pre-0004 `rightPanelByThread`), now
  with an explicit fallback for the threadless and uninitialized cases. This is
  the costly-to-reverse part.
- Reads must go through an accessor that falls through to the fallback until the
  thread writes its own entry (copy-on-write), never reaching into a slice
  directly - the same discipline ADR-0004 set with `getRightPanelVisible`.
- `clearThread` drops the deleted thread's whole panel-state entry (ADR-0004
  already required this for visibility; it now covers the full record).
- ADR-0004's "width and active tab are workspace-global" decision is superseded.
  Its singleton-tabs and per-tab-scope decisions still stand.
