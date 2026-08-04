# VS Code integrated terminal research

Inspected source: `microsoft/vscode` cached by OpenSrc at `.opensrc/repos/github.com/microsoft/vscode/main`, commit `106a3a45eec09d92d4a23da89337f25521d73ccd` (2026-08-04 checkout). Cached source was read only and not executed. The source links below are pinned to that commit.

Pinned GitHub source: [`terminalProcess.ts`](https://github.com/microsoft/vscode/blob/106a3a45eec09d92d4a23da89337f25521d73ccd/src/vs/platform/terminal/node/terminalProcess.ts), [`terminalProcessManager.ts`](https://github.com/microsoft/vscode/blob/106a3a45eec09d92d4a23da89337f25521d73ccd/src/vs/workbench/contrib/terminal/browser/terminalProcessManager.ts), [`localTerminalBackend.ts`](https://github.com/microsoft/vscode/blob/106a3a45eec09d92d4a23da89337f25521d73ccd/src/vs/workbench/contrib/terminal/electron-browser/localTerminalBackend.ts), [`xtermTerminal.ts`](https://github.com/microsoft/vscode/blob/106a3a45eec09d92d4a23da89337f25521d73ccd/src/vs/workbench/contrib/terminal/browser/xterm/xtermTerminal.ts), [`ptyHostService.ts`](https://github.com/microsoft/vscode/blob/106a3a45eec09d92d4a23da89337f25521d73ccd/src/vs/platform/terminal/node/ptyHostService.ts).

## Confirmed architecture and mechanisms

- **Renderer/emulator:** The workbench wraps `@xterm/xterm` in `XtermTerminal`; writes and resizes are delegated to xterm (`xtermTerminal.ts`, lines 543-550). `TerminalInstance` owns the emulator and process manager, forwards xterm `onData` to the process manager, and writes process output back with xterm callbacks (`terminalInstance.ts`, lines 879-881 and 1658-1697). This keeps VT parsing/rendering in a battle-tested emulator rather than app code.
- **Process ownership:** Local shell processes live behind a dedicated pty host service/process. The renderer connects through an Electron `MessagePort` (`localTerminalBackend.ts`, lines 133-151), while `PtyHostService` exposes process data, shutdown, resize, and host-health events (`ptyHostService.ts`, lines 69-77, 229-259). This isolates blocking/unstable pty work from the renderer.
- **Flow control/backpressure:** `TerminalProcess` counts output characters, pauses node-pty above a high watermark, and resumes only after acknowledgements reduce the count below a low watermark (`terminalProcess.ts`, lines 323-334 and 580-585). `TerminalProcessManager` batches acknowledgements in fixed-size chunks (`terminalProcessManager.ts`, lines 742-755). Separately, `TerminalDataBufferer` coalesces bursts with a short throttle (default 5 ms) before forwarding (`terminalDataBuffering.ts`, lines 16-62). This is a concrete anti-freeze strategy for heavy output.
- **Input sequencing:** Input received before process readiness is queued and flushed once the pty is ready (`terminalProcessManager.ts`, lines 387-391, 651-663). Resize is debounced and early ConPTY resize is delayed (`terminalProcessManager.ts`, lines 634-642; `terminalProcess.ts`, lines 173-181). Tests explicitly reject duplicate resize actions (`agentHostPty.test.ts`, lines 250-262).
- **Exit/cleanup:** On exit, VS Code delays killing briefly to flush pending ConPTY output, then force-kills after a bounded maximum (5 seconds); Windows kill/spawn calls are throttled (`terminalProcess.ts`, lines 27-53, 377-426, 462-480). Child-process monitoring tracks whether descendants remain (`terminalProcess.ts`, lines 318-320), supporting confirmation and process-tree cleanup UX.
- **Reconnect/persistence:** Terminal processes expose persistent IDs and reconnection properties. The manager can attach to revived processes, emits pty reconnect events, and records a short data window for seamless relaunch (`terminalProcessManager.ts`, lines 132-133, 289-345, 439-442, 759-765). Agent-host terminals implement reconnect by unsubscribing, rehydrating/replaying content, and timing out after 10 seconds (`agentHostPty.ts`, lines 385-452). Configuration distinguishes revive on exit, revive on window close, or never (`terminalConfiguration.ts`, lines 549-555).
- **Host health and instrumentation:** The backend surfaces pty-host unresponsive/responsive/restart events and presents a user-visible status with a restart action (`baseTerminalBackend.ts`, lines 47-101). Latency is measured through backend calls (`localTerminalBackend.ts`, lines 252-268; `terminalProcessManager.ts`, lines 425-428), and developer settings allow simulated pty-host latency/startup delay (`terminalConfiguration.ts`, lines 681-689).
- **Platform abstraction:** A common terminal contract fronts local, remote, and agent-host implementations. Windows-specific behavior is explicit: ConPTY handling, delayed resize, kill/spawn spacing, optional shipped `conpty.dll`, and selectable Unicode width versions (`terminalProcess.ts`, lines 173-181; `terminalConfiguration.ts`, lines 486-486, 537-541). Shell profile resolution is OS-aware and supports detected and extension-contributed profiles (`terminalProfileResolverService.ts`, lines 35-35, 196-214, 290-290; `terminal.ts`, lines 670-720).
- **Capabilities and accessibility:** The terminal uses xterm addons/capabilities for command detection, marks, links, shell integration, and Unicode. Accessibility is a first-class mode; `TerminalInstance` maps VS Code screen-reader optimization to xterm `screenReaderMode` (`terminalInstance.ts`, lines 1997-1999), with accessible-view actions in the terminal action layer (`terminalActions.ts`, lines 25-54). Shell integration is injected to provide command tracking and current-directory metadata (`terminalConfiguration.ts`, lines 612-612).
- **Testing:** The repository has focused tests for xterm behavior, shell integration, buffering, process manager behavior, resize deduplication, shutdown, reconnect, and recorded cross-platform sessions (`src/vs/workbench/contrib/terminal/test/...`). This is evidence that terminal correctness is tested as protocol/state behavior, not only visually.

## Decision implications for Mcode

### Strengths worth borrowing

1. Keep xterm.js (or an equivalent mature VT emulator) as the sole renderer/parser and integrate through a narrow adapter.
2. Move PTY creation, IO, resize, and kill into a dedicated host process/service separated from the UI renderer.
3. Make output flow control explicit: character-count watermarks, acknowledgements, short burst coalescing, and bounded queues.
4. Define lifecycle state transitions (launching, ready, disconnected, exited, killed) and queue pre-ready input rather than dropping it.
5. Treat resize as a sequenced operation: deduplicate, debounce, delay early Windows resize, and test resize during output.
6. Add persistent process IDs plus bounded replay/reconnect if Mcode requires window reloads or server restarts.
7. Expose pty-host health and latency telemetry so freezes are diagnosable instead of silent.
8. Make shell profiles, Unicode width, ConPTY choice, shell integration, and screen-reader behavior explicit capabilities with platform-specific tests.

### Complexity to avoid initially

- VS Code supports local, remote, extension-contributed, agent-host, task, chat-mirror, and seamless-relaunch terminal variants. Mcode should first implement one authoritative local PTY path and a single transport contract, then add remote/reconnect variants only when required.
- Full process revival across application shutdown, multi-window reconnection, extension profile providers, command-detection capabilities, and chat terminal mirrors are valuable but substantially expand lifecycle/state surface. Keep them behind separate decisions.
- Do not copy VS Code's internal service graph or Electron IPC layering wholesale. Preserve the invariants (host isolation, flow control, bounded lifecycle, observability) with fewer interfaces.

## Official documentation

- [VS Code Integrated Terminal basics](https://code.visualstudio.com/docs/terminal/basics) (terminal creation, profiles, interaction and accessibility entry points).
- [VS Code terminal advanced topics](https://code.visualstudio.com/docs/terminal/advanced) (shell integration, persistent sessions, performance and troubleshooting guidance).
- [VS Code terminal profiles](https://code.visualstudio.com/docs/terminal/profiles) (platform-specific profile configuration and detection).

These docs are product-level guidance; implementation facts above come from the pinned source commit and cached paths.
