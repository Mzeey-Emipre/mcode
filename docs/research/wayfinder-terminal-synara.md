# Synara terminal research

Research target: `Emanuele-web04/synara`, cached with OpenSrc at verified commit `8f8258f9270a7485fbd7ce7c41216cd8d0422444` (2026-08-04). Cached source is under `.opensrc/repos/github.com/Emanuele-web04/synara/main` and was read-only. Public source links use that immutable commit: <https://github.com/Emanuele-web04/synara/tree/8f8258f9270a7485fbd7ce7c41216cd8d0422444>.

## Confirmed architecture

- Frontend uses `@xterm/xterm` with Clipboard, Fit, Image, Ligatures, Search, Unicode11, and WebGL addons in `apps/web/src/components/terminal/terminalRuntime.ts`. WebGL is attempted lazily for visible terminals, falls back to DOM after context loss, and font loading triggers atlas clear/refit. The runtime registry parks hidden xterm DOM nodes instead of destroying them, allowing tab/drawer/workspace switches to retain emulator state.
- Backend defines a PTY abstraction (`apps/server/src/terminal/Services/PTY.ts`) with `spawn`, `write`, `resize`, `kill`, `pause/resume`, data and exit listeners. `NodePTY.ts` lazily loads `node-pty`, sets `xterm-color` on Windows and `xterm-256color` elsewhere, and repairs the native spawn-helper executable on POSIX. `BunPTY.ts` is a second adapter for non-Windows Bun; it explicitly fails on Windows and buffers paused bytes up to 8 MiB.
- Terminal sessions are server-owned in `TerminalManagerRuntime` (`Layers/Manager.ts`), keyed by `threadId` plus `terminalId`. `terminal.open`, `write`, `resize`, `clear`, `restart`, `close`, and `ackOutput` are typed RPCs over the WebSocket transport (`packages/contracts/src/{terminal,rpc,ws}.ts`, `apps/server/src/wsRpc.ts`). Push events use `terminal.event`; clients subscribe independently.
- Open is idempotent and reconnect-aware. A re-open of an existing live session preserves cwd/env, resets ACK accounting, resumes reads, applies requested dimensions, flushes output, and returns a snapshot containing capped history plus a mode-replay preamble. Renderer-side `replaySnapshot` resets xterm (`ESC c`) and writes the snapshot before live output.
- Output is batched server-side every 16 ms or at 128 KiB. Reads pause at a 1 MiB pending-output watermark or 100 KiB unacknowledged renderer output; parsed xterm writes ACK byte counts. ACK low watermark is 5 KiB. A 10-second watchdog force-resumes if ACKs stop, preventing a disconnected renderer from freezing the PTY. Frontend batches writes to xterm per animation frame, 256 KiB, or 50 ms.
- History is append-optimized and bounded to 5,000 lines and 1 MiB UTF-8 by default (`terminalHistory.ts`). Trimming prefers replay-safe boundaries (ESC/newline/UTF-8 lead byte), then lazily materializes/caches. History is persisted per thread/terminal with a 250 ms debounce and private-file repair; inactive sessions are evicted after a 128-session cap.
- Shutdown captures descendants before signaling. POSIX uses `ps` snapshots, directly signals captured descendants (including reparented children), then `tree-kill`; SIGKILL checks PID command identity to avoid PID reuse. Windows delegates descendant traversal to `taskkill /T`. Capture/inspection is injectable and tested.
- Process activity polling shares one POSIX process-tree snapshot per cycle, polls at a base interval while busy, and backs off 8x while all sessions are idle. Managed wrappers/hooks and process-tree heuristics feed activity/CLI identity events.
- Tests cover contracts, manager lifecycle, ACK flow-control, history caps, PTY adapters, process-tree killer, terminal state/layout/link/focus behavior, WebSocket API, and a browser stress test that writes 2,400 lines and verifies xterm content/paint. `scripts/node-pty-smoke.mjs` provides a native PTY smoke check.
- User-facing capabilities include multiple terminal tabs, nested horizontal/vertical splits, drag-resizable panes, workspace/chat-drawer presentation modes, search, links/path opening, copy/paste, Unicode, images, ligatures, activity indicators, shell/profile environment injection, restart/clear/close, and terminal scrollback restoration.

## Decision-relevant strengths for Mcode

1. Treat the PTY as a durable server session, not a React component. Idempotent open plus snapshot replay makes UI remounts and WebSocket reconnects recoverable.
2. Make flow control explicit end-to-end. The dual high-watermarks, renderer parse ACKs, bounded buffers, and watchdog address the common “heavy output freezes forever” failure mode.
3. Bound scrollback by bytes as well as lines and trim on ANSI/UTF-8-safe boundaries. This is important for full-screen TUIs that emit few newlines.
4. Keep PTY implementations behind a narrow adapter and inject them in tests. Synara can switch Bun/Node implementations without changing session logic; Mcode should select one cross-platform production adapter rather than silently relying on Bun on Windows.
5. Capture process descendants before termination and verify command identity before escalation. This is substantially safer than killing only the PTY root.
6. Lazy-load xterm and WebGL only when a terminal is visible, while parking hidden runtimes. This protects startup cost without sacrificing instant tab switching.
7. Stress-test real xterm parsing and canvas paint, not only manager unit tests.

## Weaknesses / cautions and T3 divergence

- Synara is a T3 Code lineage, so the broad Electron/Bun/React/WebSocket shape and terminal concepts are not independent validation. The terminal-specific additions appear to be the durable-session manager, ACK flow-control, history/mode replay, process-tree cleanup, and multi-pane runtime; these should be compared with T3 before treating them as novel.
- Bun PTY is deliberately unavailable on Windows, forcing Node.js. A cross-platform Mcode design should make the supported adapter and packaging story explicit rather than allowing runtime-dependent failures.
- Output ACK is byte-count based and best-effort from the browser. The reconnect snapshot is the correctness backstop; it is not a durable per-client sequence log. If Mcode needs multiple simultaneous viewers or exact event replay, add sequence IDs and retention rather than copying this protocol unchanged.
- History replay is scrollback, not a full terminal checkpoint. Synara adds a mode-replay preamble for cursor modes, but arbitrary TUI state can still differ after reconnect. Native-feeling restoration should define what is guaranteed.
- Process-tree scans rely on `ps` and bounded snapshots on POSIX. They are carefully failure-aware, but polling and command inspection still have platform and race costs.
- WebGL is enabled by default with fallback on context loss. This is performant but needs GPU-driver telemetry and a deterministic DOM fallback path in Mcode QA.

## Source pointers

- [PTY contract and adapters](https://github.com/Emanuele-web04/synara/blob/8f8258f9270a7485fbd7ce7c41216cd8d0422444/apps/server/src/terminal/Services/PTY.ts)
- [Node PTY adapter](https://github.com/Emanuele-web04/synara/blob/8f8258f9270a7485fbd7ce7c41216cd8d0422444/apps/server/src/terminal/Layers/NodePTY.ts)
- [Bun PTY adapter/backpressure](https://github.com/Emanuele-web04/synara/blob/8f8258f9270a7485fbd7ce7c41216cd8d0422444/apps/server/src/terminal/Layers/BunPTY.ts)
- [Session manager, replay, ACK watermarks](https://github.com/Emanuele-web04/synara/blob/8f8258f9270a7485fbd7ce7c41216cd8d0422444/apps/server/src/terminal/Layers/Manager.ts)
- [History buffer/caps](https://github.com/Emanuele-web04/synara/blob/8f8258f9270a7485fbd7ce7c41216cd8d0422444/apps/server/src/terminal/terminalHistory.ts)
- [Process-tree cleanup](https://github.com/Emanuele-web04/synara/blob/8f8258f9270a7485fbd7ce7c41216cd8d0422444/apps/server/src/terminal/processTreeKiller.ts)
- [xterm runtime and WebGL lifecycle](https://github.com/Emanuele-web04/synara/blob/8f8258f9270a7485fbd7ce7c41216cd8d0422444/apps/web/src/components/terminal/terminalRuntime.ts)
- [Browser stress test](https://github.com/Emanuele-web04/synara/blob/8f8258f9270a7485fbd7ce7c41216cd8d0422444/apps/web/src/components/terminal/terminalStress.browser.tsx)
