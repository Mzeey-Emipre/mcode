---
status: accepted
---

# The default open-in app resolves in three tiers; choosing in a thread sets a thread-only override

## Context

"Open in editor" was a fixed dropdown: `mod+o` always opened the system File
Explorer, and selecting an editor was a one-off action that persisted nothing
(`OpenInEditorMenu.tsx`). The revamp turns this into a split button whose
primary action / `mod+o` opens a **default** app, with a dropdown to choose it.

The question is where that default lives. A single global setting is the obvious
choice, but it loses per-thread intent: a user reviewing a thread in Cursor and
another in VS Code would have to keep flipping one global preference.

## Decision

The effective open-in app resolves in **three tiers**:

1. **Thread override** — the app last picked from *that thread's* menu, persisted
   on the thread and surviving restarts.
2. **Global default** — `externalApps.defaultEditor` in user settings.
3. **Auto-resolve** — highest-priority installed editor (VS Code → Cursor → Zed),
   falling back to File Explorer.

Choosing an app from a thread's menu writes **tier 1 only**; it never changes the
global default. The global default is configured in Settings, independent of any
thread.

## Consequences

- A choice made in a thread is sticky to that thread and does not leak into the
  user's global preference — the surprising-but-intentional behavior this ADR
  exists to record.
- The auto-resolve tier means the split button is fully usable on day one with no
  configuration, so the Settings UI for the global default can ship as a
  follow-up without blocking the feature.
- Per-thread override persistence requires thread-scoped storage alongside the
  existing per-thread panel state.
- The open-in app registry expands beyond editors (terminals, git GUI, Explorer);
  every detected app is eligible as the default. That registry/detection
  expansion is tracked separately as an architecture-improvement effort.
