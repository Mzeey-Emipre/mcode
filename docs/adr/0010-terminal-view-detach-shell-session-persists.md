---
status: accepted
---

# Terminal views detach; shell sessions persist with server-side scrollback

## Context

The integrated terminal kept every open shell's renderer mounted in a
persistent pool (`TerminalPoolHost`), hidden with CSS across thread switches.
That preserved scroll position but scaled memory and main-thread cost with
every long-running shell, causing lag on Windows and making multi-thread
sessions unusable.

The server already had `terminal.reattach` and a replay buffer, but the
512 KB cap was sized for WebSocket reconnect, not for scrollback. The
`terminal.scrollback` setting applied only to the client xterm buffer.

ADR-0002 established discard semantics for browser preview tabs. The terminal
needed an equivalent split: dispose inactive views, retain one warm view, and
keep every cheap shell session.

## Decision

Split **shell session** (server PTY, long-lived) from **terminal view**
(client renderer, disposable).

- **Shell sessions** survive thread switches, tab hides, and view disposal.
  Output always drains into server-side scrollback, even with no mounted view.
  Hiding the warm view pauses client delivery, not the shell or server-side
  retention. Reopening requests the buffered delta before delivery resumes.
- **Terminal views** mount for at most one shell at a time. The active shell's
  view stays warm when the Terminal tab or right panel is hidden. Switching
  shells or terminal scopes replaces that view. All other shells run headless.
- **Scrollback** uses one knob: `terminal.scrollback` drives both server
  retention (for reattach replay) and the mounted view's buffer. Output
  beyond the limit is dropped oldest-first.
- **Return to the same shell** reveals the warm view and requests only output
  after its last processed sequence. The view follows new output when the user
  was at the tail, or restores the same retained content when the user was
  reading history.
- **Switch to another shell** hydrates a new view while hidden. It applies a
  bounded scrollback replay or checkpoint plus delta, restores the viewport,
  then reveals the completed frame. Users never watch history paint from top
  to bottom.
- **Performance** keeps the terminal module lazy until first use, retains no
  more than one view, and releases rendering acceleration while the warm view
  is hidden. This follows the lazy-loading and bounded-renderer guidance in the
  [performance audit](../guides/performance-audit.md).

## Considered Options

- **Persistent xterm pool (rejected).** Status quo; N hidden renderers, lag
  and memory grow with open shells.
- **Dispose views without server scrollback (rejected).** Saves memory but
  loses history on thread switch; unusable for long-running builds.
- **Separate server scrollback cap (rejected).** Two knobs confuse users;
  one setting should mean one retention policy.
- **Mount all shells for the active scope (rejected).** Up to four xterm
  instances per thread; still too heavy for the idle-memory target.
- **Dispose every hidden view (rejected).** Keeps renderer memory lowest, but
  pays xterm creation, replay, parsing, layout, and viewport restoration on
  every reopen.
- **Persist scrollback server-side with one warm view (chosen).** Preserves the
  strict one-renderer bound while making the most recently used terminal fast
  to reopen. Cold shell switches hydrate before becoming visible.

## Consequences

- `TerminalPoolHost`'s many-view pool is replaced by one lazy terminal view.
  The view moves between the visible terminal surface and an offscreen host.
  Background shell tabs stay server-side only.
- Server replay buffer capacity must derive from `terminal.scrollback`, not
  the fixed 512 KB default.
- Closing and reopening the terminal surface keeps the active view and viewport
  intact. Shell or scope switches use hidden hydration and restore the saved
  tail or history anchor before reveal.
- Warm views process bounded output deltas. Cold views replay bounded retained
  scrollback without exposing intermediate render frames.
- E2E specs that assume all terminals stay mounted (`__mcodeLiveTerminals`,
  scroll-on-thread-switch harness) need updating for the new lifecycle.
