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
needed an equivalent split: kill the expensive view, keep the cheap session.

## Decision

Split **shell session** (server PTY, long-lived) from **terminal view**
(client renderer, disposable).

- **Shell sessions** survive thread switches, tab hides, and view disposal.
  Output always drains into server-side scrollback, even with no mounted view.
  Pause/resume applies only to client backpressure when a view is mounted and
  cannot keep up, not to "nobody is watching."
- **Terminal views** mount for at most one shell at a time: the active shell
  on the active terminal scope, while the Terminal tab and right panel are
  open. All other shells run headless.
- **Scrollback** uses one knob: `terminal.scrollback` drives both server
  retention (for reattach replay) and the mounted view's buffer. Output
  beyond the limit is dropped oldest-first.
- **Remount** replays retained scrollback via `terminal.reattach` and opens
  at the latest output (follow). Smart scroll-position restore is a planned
  follow-up, not v1.
- **Mount/unmount speed** is a first-class requirement: remount must feel
  instant; optimize replay and xterm init accordingly.

## Considered Options

- **Persistent xterm pool (rejected).** Status quo; N hidden renderers, lag
  and memory grow with open shells.
- **Dispose views without server scrollback (rejected).** Saves memory but
  loses history on thread switch; unusable for long-running builds.
- **Separate server scrollback cap (rejected).** Two knobs confuse users;
  one setting should mean one retention policy.
- **Mount all shells for the active scope (rejected).** Up to four xterm
  instances per thread; still too heavy for the idle-memory target.
- **Detach views, persist scrollback server-side, max one mounted view
  (chosen).** Mirrors ADR-0002's discard pattern; reuses existing reattach
  infrastructure once the replay buffer is sized from `terminal.scrollback`.

## Consequences

- `TerminalPoolHost`'s always-mounted pool is replaced by mount-on-demand
  for the active shell only. Background shell tabs remount on select.
- Server replay buffer capacity must derive from `terminal.scrollback`, not
  the fixed 512 KB default.
- Tab switches within a thread trigger remount + replay; this must be fast
  enough to feel seamless.
- Smart follow (restore scroll position when the user had scrolled up) is
  deferred; v1 always follows latest output on remount.
- E2E specs that assume all terminals stay mounted (`__mcodeLiveTerminals`,
  scroll-on-thread-switch harness) need updating for the new lifecycle.
