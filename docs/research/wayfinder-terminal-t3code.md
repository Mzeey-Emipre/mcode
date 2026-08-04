# `pingdotgg/t3code` terminal research

**Reviewed ref:** `a261a6440ae7c1a063ff23591f43960c7d2b06e5`. Cached by the pinned OpenSrc CLI at `.opensrc/repos/github.com/pingdotgg/t3code/main`. Cached source was read only and not executed.

## Executive decision signal

T3 Code is a strong reference for a native-feeling terminal because it separates a server-owned PTY/session service from a platform-specific terminal emulator. Its web renderer uses the official `libghostty-vt` ABI compiled to WASM, renders dirty rows directly to Canvas, and keeps React out of the render loop. The backend uses `node-pty` where available, Bun's built-in PTY on non-Windows, explicit event sequencing, bounded history/buffers, serialized lifecycle commands, latest-wins resize commands, and process-tree cleanup. The main tradeoff is implementation and build complexity: vendored Ghostty WASM/native artifacts, ABI pinning, browser IME/canvas integration, and platform-specific PTY adapters.

## Architecture and rendering

- `docs/architecture/terminal-renderers.md` states that terminal sessions remain server-owned PTYs; clients receive raw bytes and send input/resize over existing contracts. Android and web share the official `libghostty-vt` C ABI for parsing, terminal state, grapheme boundaries, keyboard encoding, selection, and scrollback. The web runtime is singleton-scoped per browser tab, while each visible terminal owns/frees its own terminal and render handles. [source](https://github.com/pingdotgg/t3code/blob/a261a6440ae7c1a063ff23591f43960c7d2b06e5/docs/architecture/terminal-renderers.md) (cached: `.opensrc/.../docs/architecture/terminal-renderers.md`).
- `apps/web/src/terminal/ghostty/README.md` describes the split: `runtime.ts` owns singleton WASM, `core.ts` owns per-terminal handles/snapshots, `renderer.ts` batches Canvas backgrounds/style runs, and `surface.ts` owns input, IME, selection, scrolling, sizing, links, and cursor blinking. React state is explicitly excluded from terminal frames. [source](https://github.com/pingdotgg/t3code/blob/a261a6440ae7c1a063ff23591f43960c7d2b06e5/apps/web/src/terminal/ghostty/README.md)
- `renderer.ts` redraws only dirty rows unless a forced full repaint, groups adjacent cells by style/background, clips text runs to cell bounds, and separately redraws cursor rows. `surface.ts` schedules frames with `requestAnimationFrame`; cursor blink is timer-driven. This is a concrete low-jank rendering pattern for heavy output. [renderer](https://github.com/pingdotgg/t3code/blob/a261a6440ae7c1a063ff23591f43960c7d2b06e5/apps/web/src/terminal/ghostty/renderer.ts), [surface](https://github.com/pingdotgg/t3code/blob/a261a6440ae7c1a063ff23591f43960c7d2b06e5/apps/web/src/terminal/ghostty/surface.ts)

## PTY/backend and platform handling

## Windows compatibility: what is and is not proven

**Direct answer:** Ghostty's reusable terminal core is explicitly cross-platform, but the official Ghostty GUI is not currently a Windows product. T3 Code's browser/WASM renderer is the most promising Windows path for Mcode, because Chromium loads the same `wasm32-freestanding` artifact on Windows as on other desktop OSes. That proves portability of the emulator artifact, not a complete Windows terminal experience.

1. **Official Ghostty application.** The official README describes native apps for macOS (SwiftUI/Metal) and Linux (GTK), while its Windows-support discussion says the project was not committed to a Windows app for 1.0 and recent comments still describe third-party WinUI/DirectX work as rough prototypes. Treat standalone Ghostty-on-Windows as unsupported/experimental, not a shipping dependency. [official README](https://github.com/ghostty-org/ghostty/blob/main/README.md#native-platform-experiences), [Windows tracking discussion](https://github.com/ghostty-org/ghostty/discussions/2563)
2. **`libghostty-vt` engine.** Ghostty's official README states that `libghostty-vt` is usable from Zig/C and compatible with macOS, Linux, Windows, and WebAssembly, while warning that API signatures remain in flux. This is an engine/parser claim, not a promise of a native Windows renderer or PTY. [official `libghostty-vt` status](https://github.com/ghostty-org/ghostty#cross-platform-libghostty-for-embeddable-terminals)
3. **T3 Code in Electron/Chromium on Windows.** T3 Code builds `libghostty-vt` for `wasm32-freestanding`, vendors the artifact, and loads it through browser `fetch` + `WebAssembly.instantiate`; there is no OS-specific branch in this renderer. T3's release matrix does package a Windows x64 Electron app, and its Windows backend uses Node PTY/WSL support, but the inspected Ghostty tests are browser/runtime/ABI tests rather than a Windows-native rendering or end-to-end PTY test. [WASM build script](https://github.com/pingdotgg/t3code/blob/a261a6440ae7c1a063ff23591f43960c7d2b06e5/apps/web/scripts/build-libghostty-wasm.sh), [WASM loader](https://github.com/pingdotgg/t3code/blob/a261a6440ae7c1a063ff23591f43960c7d2b06e5/apps/web/src/terminal/ghostty/runtime.ts), [Windows release matrix](https://github.com/pingdotgg/t3code/blob/a261a6440ae7c1a063ff23591f43960c7d2b06e5/.github/workflows/release.yml#L362-L368), [Windows PTY adapter](https://github.com/pingdotgg/t3code/blob/a261a6440ae7c1a063ff23591f43960c7d2b06e5/apps/server/src/terminal/NodePtyAdapter.ts)

**What still needs a Windows prototype in Mcode:** run the packaged Electron build on Windows with the actual vendored WASM, exercise PowerShell/cmd and full-screen apps through the Windows PTY, and measure IME, keyboard encoding, font fallback, clipboard, resize/DPI, WebGL/Canvas behavior, high-rate output, and process-tree cleanup. T3's source makes this architecture plausible; it does not provide that Windows evidence by itself.

- `NodePtyAdapter.ts` dynamically loads `node-pty`, locates/repairs the packaged `spawn-helper` executable on POSIX, spawns with cwd, cols/rows, env, and `xterm-256color` (or `xterm-color` on Windows). [source](https://github.com/pingdotgg/t3code/blob/a261a6440ae7c1a063ff23591f43960c7d2b06e5/apps/server/src/terminal/NodePtyAdapter.ts)
- `BunPtyAdapter.ts` uses `Bun.spawn(..., terminal:{cols,rows,data})` on non-Windows and fails structurally on Windows, directing callers to Node.js. This avoids pretending Bun PTY behavior is portable. [source](https://github.com/pingdotgg/t3code/blob/a261a6440ae7c1a063ff23591f43960c7d2b06e5/apps/server/src/terminal/BunPtyAdapter.ts)
- `Manager.ts` resolves shell candidates per platform, including PowerShell/cmd fallbacks on Windows and zsh/bash/sh fallbacks on POSIX. It stores sessions keyed by `(threadId, terminalId)` and caps inactive retention at 128 by default. Cached lines: `Manager.ts:77-81, 2146-2204`.

## Transport, buffering, lifecycle, and recovery

- Contracts validate terminal IDs, cwd, cols (1-1000), rows (1-500), env count/value sizes, and write payloads (max 65,536 chars). `TerminalEvent` carries monotonically increasing optional `sequence`; attach emits a snapshot followed by live events. [source](https://github.com/pingdotgg/t3code/blob/a261a6440ae7c1a063ff23591f43960c7d2b06e5/packages/contracts/src/terminal.ts)
- `Manager.attachStream` subscribes before opening/attaching, buffers events during the race, sends the initial snapshot, drops duplicate buffered events by sequence, then switches to live delivery (`Manager.ts:2352-2406`). This is a useful reconnect/attach ordering pattern.
- PTY callbacks enqueue output/exit events per session and a single drain worker processes them in order (`Manager.ts:1660-1759, 1892-1904`). Output updates a sanitized, line-capped history and publishes raw PTY bytes. Defaults are 5,000 history lines and 40 ms persistence debounce (`Manager.ts:77-81, 1673-1743`).
- Client reducers retain at most 512 KiB of UTF-8 terminal buffer, preserving codepoint boundaries (`packages/client-runtime/src/state/terminalSession.ts:65-89, 125-173`). Resize commands use latest-wins scheduling while lifecycle commands are serial (`packages/client-runtime/src/state/terminal.ts:22-72`).
- On close, restart, startup failure, or server shutdown, the manager unsubscribes callbacks and escalates process termination with a 1-second grace period; Unix process trees are discovered with `pgrep`/`ps` (`Manager.ts:1299-1380, 1764-1800, 1979-2017, 2130-2143`). This is stronger than killing only the shell PID, though platform-specific inspection adds operational complexity.
- Existing sessions can be reattached without respawning; attach can optionally restart an exited session, and resize is applied when dimensions differ (`Manager.ts:2272-2318`). History is persisted per thread/terminal and restored on open (`Manager.ts:2146-2204, 1433-1505`).

## User-facing capabilities and tests

The Ghostty surface implements keyboard encoding (including Kitty mode), IME composition via hidden textarea, copy/paste shortcuts, selection with drag autoscroll, alternate-screen wheel behavior, application mouse reporting with Shift bypass, scrollbars, cursor styles/blink, Unicode/grapheme handling, OSC 8 links, wrapped-link hit testing, and bundled symbol-font fallback. Evidence is in `surface.ts`, `core.ts`, and focused tests under `apps/web/src/terminal/ghostty/*.test.ts`.

Tests cover repeated WASM create/write/free cycles, ABI revision and artifact budget, graphemes, selection, mouse encoding, keyboard encoding, dirty-row rendering, cursor repaint, resize/grid metrics, wheel accumulation, links, IME, and client buffer caps. Server terminal tests cover PTY adapters and manager lifecycle/race behavior. [tests](https://github.com/pingdotgg/t3code/tree/a261a6440ae7c1a063ff23591f43960c7d2b06e5/apps/web/src/terminal/ghostty)

## Strengths to carry into Mcode

1. Keep PTY ownership and lifecycle on the server; make the UI a byte/event consumer.
2. Use a real terminal parser/emulator (Ghostty/libghostty-vt is a serious candidate) and render dirty rows outside React.
3. Define bounded limits at contracts and reducers: input payload, dimensions, retained history, inactive sessions, and queue behavior.
4. Make attach/reconnect race-safe with snapshot plus sequenced events and pre-subscription buffering.
5. Serialize lifecycle actions, coalesce resize, and clean process trees rather than only shell PIDs.
6. Pin native/WASM artifacts to one revision and test ABI/version drift and repeated allocation/free cycles.

## Weaknesses / risks (inference from the source)

- Ghostty WASM/native vendoring and Canvas/IME implementation are a substantial maintenance surface; Mcode should prototype this before committing to a full replacement.
- The client retained buffer is bounded, but the server also maintains history and persistence queues; end-to-end output-pressure telemetry/backpressure is not obvious in the inspected contracts. High-rate output should be benchmarked explicitly.
- Bun PTY is intentionally unsupported on Windows, so a cross-platform product needs a Node/native fallback strategy and packaging tests for every target.
- Reconstructing terminal state from sanitized text history cannot restore alternate-screen/private terminal state after a renderer reconnect; the live PTY remains authoritative, but a disconnected client should expect a textual scrollback snapshot rather than an exact screen-state checkpoint.

## Open questions for the Mcode decision ticket

- Can Mcode accept a Ghostty/libghostty-vt build and licensing/update pipeline, or should it first harden the existing emulator behind the same server/event contracts?
- What measured output rate, latency, memory ceiling, and reconnect guarantees define “native” on all supported platforms?
- Does Mcode need exact full-screen-app restoration after UI reload, or is persisted textual scrollback sufficient?
