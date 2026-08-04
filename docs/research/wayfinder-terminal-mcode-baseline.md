# Mcode terminal baseline

This note records the current terminal implementation before Wayfinder decisions. It uses local repository sources and commit history only. “Observed” statements come directly from code or documentation. “Inference” statements describe implications that require validation.

## Architecture

**Observed.** The server owns PTY management, while the web app renders terminals and the Electron process remains a thin shell ([`ARCHITECTURE.md`](../../ARCHITECTURE.md), lines 95-120). The server implementation is [`apps/server/src/services/terminal-service.ts`](../../apps/server/src/services/terminal-service.ts), and it loads `node-pty` lazily through `createRequire` (lines 7-50). The web package uses `@xterm/xterm` 6 with fit, serialize, and WebGL addons ([`apps/web/package.json`](../../apps/web/package.json), lines 31-40).

**Inference.** A replacement can preserve the UI and transport contracts while replacing the PTY/process backend, or it can replace the full server-to-renderer path. The current boundaries make those two choices separable.

## PTY lifecycle and operating-system assumptions

**Observed.** `TerminalService.create` accepts either a thread ID or workspace ID. It resolves a thread's worktree/workspace directory through `GitService`, uses the workspace root for a threadless terminal, validates that the directory is absolute and exists, and limits each scope to four PTYs (lines 156-205). It spawns 80x24 PTYs with `TERM=xterm-256color`, `EnvService`'s environment, and a platform default shell: `powershell.exe` on Windows, `$SHELL` or `/bin/bash` elsewhere (lines 54-57 and 87-93, 208-225).

On Windows, the spawn path opts into the bundled ConPTY DLL because the source comments report that native ConPTY can create a console-list helper which may fail `AttachConsole` and crash the server (lines 221-224). The service assigns PTY roots to a global Job Object and a per-terminal process scope; failed assignment or reconciliation falls back to process-tree termination (lines 263-310). Closing waits up to 500 ms for process-scope authority, then uses the scoped termination path or `killProcessTree` (lines 597-628). `process-kill.ts` uses PowerShell CIM snapshots and `taskkill /T /F` on Windows; Unix uses `pgrep`, process-start identity checks, process-group signals, and bounded verification. The process tree and verification are capped at 128 processes ([`apps/server/src/services/process-kill.ts`](../../apps/server/src/services/process-kill.ts), lines 1-35 and 210-300).

**Inference.** Windows is the highest-risk platform boundary because it combines native node-pty/ConPTY packaging, Job Objects, process-tree races, and fallback enumeration. Cross-platform shell behavior is also not uniform: the default is fixed to PowerShell on Windows but inherited from the environment on Unix.

## Rendering and transport

**Observed.** `TerminalView` dynamically imports xterm and fit/serialize addons, mounts xterm, and registers direct PTY data/exit callbacks ([`apps/web/src/components/terminal/TerminalView.tsx`](../../apps/web/src/components/terminal/TerminalView.tsx), lines 35-64 and 270-360). Electron intentionally skips WebGL to avoid software-GL stalls; browsers use WebGL when available, with context-loss fallback to xterm's DOM renderer (lines 160-235). Hidden terminals remain mounted to preserve xterm state; the panel keeps terminals from all threads resident ([`apps/web/src/components/terminal/TerminalPanel.tsx`](../../apps/web/src/components/terminal/TerminalPanel.tsx), lines 28-34 and 195-210).

The server assigns a monotonic sequence to each PTY chunk, records it in an always-on replay buffer, and passes it through two-source flow control. New PTYs start paused until the renderer attaches (terminal service lines 237-259). Flow control pauses for client requests or socket backpressure and drops oldest bytes after a bounded ring fills ([`terminal-flow-control.ts`](../../apps/server/src/services/terminal-flow-control.ts), lines 1-13 and 54-130). Replay is byte-capped: 512 bytes per configured scrollback line, with 64 KiB and 8 MiB bounds; client “unlimited” scrollback still has an 8 MiB server cap ([`terminal-replay-buffer.ts`](../../apps/server/src/services/terminal-replay-buffer.ts), lines 14-59).

Current PTY output uses binary WebSocket frames with a sequence envelope ([`packages/contracts/src/ws/terminal-binary.ts`](../../packages/contracts/src/ws/terminal-binary.ts), lines 1-84). Reconnection lists active PTYs and calls `terminal.reattach` with the last received sequence; a replay gap emits a reconnect warning ([`apps/web/src/transport/ws-transport.ts`](../../apps/web/src/transport/ws-transport.ts), lines 308-349). Resize fitting is frame-coalesced locally and debounced to one trailing RPC after 100 ms (TerminalView lines 585-625).

## Stability and performance strengths

**Observed.** The implementation has explicit bounds, sequence-based replay, reconnect handling, process identity checks, graceful app-shutdown mode, and tests for flow control, replay, process killing, terminal lifecycle, and scroll restoration. The performance guide recommends binary/high-throughput channels and warns against one IPC message per terminal byte ([`docs/guides/performance-audit.md`](../../docs/guides/performance-audit.md), lines 64-69); the current terminal already uses binary WebSocket frames and batches replay writes. `TerminalView` exposes a 150 ms development remount budget and records mount timing (lines 54-64).

## Evidenced risks and unresolved questions

**Observed.** The source documents a native ConPTY crash hazard and a fallback from Job Objects to process-tree scans. Flow-control rings and replay buffers deliberately discard old bytes when bounded capacity is exceeded. Reconnection reports a gap rather than reconstructing evicted output. The panel keeps all thread terminals mounted, which retains renderer and scrollback state. Closing removes a terminal from the client store immediately after starting `terminal.kill` ([`TerminalPanel.tsx`](../../apps/web/src/components/terminal/TerminalPanel.tsx), lines 114-123).

**Inference.** Likely rewrite questions include whether one WebSocket frame per PTY chunk remains adequate under burst output, whether resident xterm instances scale across many threads, how much output loss is acceptable during backpressure/reconnect, and whether Windows process ownership can be made authoritative without fallbacks. These are hypotheses, not measured regressions; runtime benchmarks and failure-injection tests are still needed.

## Current user-facing capabilities

The contracts expose create, write, resize, kill, pause, resume, kill-by-thread, reattach, checkpoint, list-active, and child-process inspection ([`packages/contracts/src/ws/methods.ts`](../../packages/contracts/src/ws/methods.ts), lines 960-1045). The UI supports up to four terminals per scope, shell labels, split/list views, panel resizing, terminal toggle, copy and right-click paste behavior, scrollback configuration, reconnect notices, process-exit notices, and optional confirmation before killing a terminal with child processes. Terminals open in the thread worktree when applicable or the workspace root for a threadless shell.

## Rewrite seams

The narrow backend seam is `TerminalService` plus `TerminalFlowControl`, `TerminalReplayBuffer`, `process-kill`, `windows-process-scope`, and `job-object`. The protocol seam is the terminal methods and binary frame contract, plus `ws-router`, `ws-events`, and `ws-transport`. The renderer seam is `TerminalView`, `ptyDataRegistry`, `terminalStore`, `TerminalPanel`, and the terminal scroll/fit helpers. Electron lifecycle hooks only need coordination for server shutdown and packaged native PTY assets.

## Existing proposal and hardening history

The proposal [`docs/specs/2026-07-17-agent-readable-terminal-context.md`](../../docs/specs/2026-07-17-agent-readable-terminal-context.md) (tracking issue #874) identifies product gaps: providers cannot inspect bounded terminal output with command boundaries, exit status, directory, truncation, or shell identity; the renderer uses generic monospace styling and hard-coded colors. It proposes consented bounded snapshots/watch, shell and font selection, ANSI/Unicode fidelity, and Mcode-aligned chrome. Its acceptance criteria explicitly cover PowerShell, PowerShell 7, Git Bash/WSL, bash/zsh, alternate-screen output, long lines, truecolor, Unicode, prompt profiles, reconnect gaps, and scroll anchors. It is a proposal, not current behavior.

Recent commits show repeated lifecycle hardening:

- `610edb2b` — `fix(terminal): harden process lifecycle and exit reporting` (#955), 14 files and 2,786 additions, including process-tree verification and Windows process scopes.
- `4da3abac` — `fix(terminal): preserve state across cold restoration` (#953), including replay-buffer and cold-restoration changes across server, web, contracts, and E2E tests.
- `1faac51f` — `fix(desktop): keep packaged ConPTY runtime` (#857), adding packaged node-pty/ConPTY checks and smoke tests.
- `8356acd2` — `fix: stabilize terminal thread lifecycle` (#816), adding terminal remount lifecycle coverage.

The history confirms active investment in stability. It does not, by itself, prove that the current implementation fails a particular workload.
