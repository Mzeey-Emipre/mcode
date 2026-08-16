/**
 * Legacy PTY (pseudo-terminal) management service.
 * Spawns and manages terminal sessions tied to threads.
 * Extracted from apps/desktop/src/main/pty-manager.ts.
 */

import { createRequire } from "node:module";
import { injectable, inject } from "tsyringe";
import { isAbsolute } from "path";
import { existsSync, statSync } from "fs";
import type { IPty, IDisposable } from "node-pty";
import { v4 as uuid } from "uuid";
import { logger } from "@mcode/shared";
import { killProcessTree, gracefulKillProcessTree, listDirectChildren } from "../../../../runtime/process/containment/process-kill.js";
import { TerminalFlowControl } from "./terminal-flow-control.js";
import { TerminalReplayBuffer, replayCapBytesForScrollback } from "./terminal-replay-buffer.js";
import type { PtyPidRegistry } from "../../host/pty-pid-registry.js";
import type { ThreadRepo } from "../../../../repositories/thread-repo";
import type { WorkspaceRepo } from "../../../../repositories/workspace-repo";
import type { GitService } from "../../../projects/index.js";
import type { SettingsService } from "../../../../shared/settings/settings-service";
import { EnvService } from "../../../../runtime/environment/env-service.js";
import {
  WindowsProcessScopeFactory,
  type WindowsProcessScope,
} from "../../../../runtime/process/containment/windows-process-scope.js";

// createRequire lets us load native CJS modules (node-pty) from both ESM
// (Bun running `src/index.ts`) and the CJS production / dev bundle.
const _require = createRequire(import.meta.url);

/**
 * Returns the shell executable basename without a `.exe` suffix for display
 * and job-object descriptions.
 */
function shellBasename(shellPath: string): string {
  const base = shellPath.split(/[\\/]/).pop() ?? shellPath;
  return base.replace(/\.exe$/i, "").slice(0, 64);
}

/**
 * Lazily load node-pty's spawn function. Deferred to avoid crashing the server
 * at startup if the native binding is missing or incompatible - the error is
 * surfaced only when a terminal is actually requested.
 */
let _spawn: typeof import("node-pty").spawn | undefined;
function getSpawn(): typeof import("node-pty").spawn {
  if (!_spawn) {
    _spawn = (_require("node-pty") as typeof import("node-pty")).spawn;
  }
  return _spawn;
}

const MAX_PTYS_PER_THREAD = 4;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const TERM_NAME = "xterm-256color";

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Immutable record describing a single PTY session. */
interface PtySession {
  readonly id: string;
  readonly threadId: string;
  readonly shell: string;
  readonly cwd: string;
  readonly pty: IPty;
  readonly dataDisposable: IDisposable;
  readonly exitDisposable: IDisposable;
  status: "running" | "closing";
  pendingExit: { readonly exitCode: number; readonly signal?: number } | null;
  closePromise: Promise<void> | null;
  readonly processScope: WindowsProcessScope;
  readonly processScopeReady: Promise<boolean>;
}

/** Callbacks for streaming PTY output and exit events to connected clients. */
export interface PtySender {
  /** Send a JSON push event (used for terminal.exit and any future JSON events). */
  json: (channel: string, data: Record<string, unknown>) => void;
  /** Send a PTY data chunk as a binary frame (tag 0x01 envelope). */
  data: (ptyId: string, seq: number, bytes: Uint8Array) => void;
}

/** Determine the default shell for the current platform. */
function defaultShell(): string {
  if (process.platform === "win32") {
    return "powershell.exe";
  }
  return process.env["SHELL"] ?? "/bin/bash";
}

/**
 * Shell process basenames that are excluded when checking whether a terminal
 * has non-shell child processes. The comparison is case-insensitive.
 */
const SHELL_BASENAMES = new Set([
  "bash", "zsh", "sh", "fish", "ksh", "dash",
  "powershell.exe", "cmd.exe", "pwsh.exe", "pwsh", "powershell",
]);

/** Manages PTY sessions for the integrated terminal. */
@injectable()
export class TerminalService {
  private sessions = new Map<string, PtySession>();
  private threadIndex = new Map<string, Set<string>>();
  private sender: PtySender | null = null;
  private flowControls = new Map<string, TerminalFlowControl>();
  private replayBuffers = new Map<string, TerminalReplayBuffer>();
  /** When true, app-quit destroyPty uses graceful signal ladder instead of force-kill. */
  private useGracefulKill = false;
  /** Last applied terminal.scrollback, used to skip redundant buffer resizes. */
  private lastScrollback: number;
  /** Unsubscribe handle for the settings-change listener. */
  private readonly unsubscribeSettings: () => void;

  constructor(
    @inject("ThreadRepo") private readonly threadRepo: ThreadRepo,
    @inject("WorkspaceRepo") private readonly workspaceRepo: WorkspaceRepo,
    @inject("GitService") private readonly gitService: GitService,
    @inject("SettingsService") private readonly settingsService: SettingsService,
    @inject(EnvService) private readonly envService: EnvService,
    @inject("PtyPidRegistry") private readonly pidRegistry: PtyPidRegistry,
    @inject("JobObject") private readonly jobObject: import("../../../../runtime/process/containment/job-object.js").JobObject,
    private readonly processScopeFactory: WindowsProcessScopeFactory = new WindowsProcessScopeFactory(),
  ) {
    // Keep server-side scrollback retention in sync with the terminal.scrollback
    // setting: when the user changes it, resize all live replay buffers so
    // running sessions honour the new retention window.
    this.lastScrollback = this.settingsService.get().terminal.behavior.scrollback;
    this.unsubscribeSettings = this.settingsService.on("change", (next) => {
      this.applyScrollbackToReplayBuffers(next.terminal.behavior.scrollback);
    });
  }

  /**
   * Resize all live replay buffers to match a new terminal.scrollback value.
   * No-op when the value is unchanged so unrelated settings edits are cheap.
   */
  private applyScrollbackToReplayBuffers(scrollback: number): void {
    if (scrollback === this.lastScrollback) return;
    this.lastScrollback = scrollback;
    const cap = replayCapBytesForScrollback(scrollback);
    for (const buffer of this.replayBuffers.values()) {
      buffer.setCap(cap);
    }
  }

  /** Set the sender used to stream PTY data to connected clients. */
  setSender(sender: PtySender): void {
    this.sender = sender;
  }

  /**
   * Spawn a new PTY session tied to the given scope.
   *
   * The scope id is normally a thread id, in which case the working directory
   * follows the thread's worktree (worktree mode) or the workspace root. When no
   * thread is active yet — the new-thread composer view — the scope id is a
   * workspace id and the shell opens at the workspace root (the local checkout),
   * never a worktree, because no worktree exists until the thread is created.
   *
   * @param scopeId - A thread id, or a workspace id for the threadless shell.
   * @returns The unique PTY session ID.
   */
  create(scopeId: string): { ptyId: string; shell: string } {
    const thread = this.threadRepo.findById(scopeId);

    let cwd: string;
    if (thread) {
      const workspace = this.workspaceRepo.findById(thread.workspace_id);
      if (!workspace) {
        throw new Error(`Workspace not found: ${thread.workspace_id}`);
      }
      cwd = this.gitService.resolveWorkingDir(
        workspace.path,
        thread.mode,
        thread.worktree_path,
      );
    } else {
      // Threadless shell: the scope is a workspace, so anchor at its local root.
      const workspace = this.workspaceRepo.findById(scopeId);
      if (!workspace) {
        throw new Error(`Thread or workspace not found: ${scopeId}`);
      }
      cwd = workspace.path;
    }

    if (
      !isAbsolute(cwd) ||
      !existsSync(cwd) ||
      !statSync(cwd).isDirectory()
    ) {
      throw new Error(`Invalid working directory: ${cwd}`);
    }

    const threadPtys = this.threadIndex.get(scopeId);
    const count = threadPtys?.size ?? 0;

    if (count >= MAX_PTYS_PER_THREAD) {
      throw new Error(
        `Maximum PTY limit (${MAX_PTYS_PER_THREAD}) reached for scope ${scopeId}`,
      );
    }

    const id = uuid();
    const shell = defaultShell();

    logger.info("Spawning PTY", { id, scopeId, shell, cwd });

    let pty: IPty;
    try {
      pty = getSpawn()(shell, [], {
        name: TERM_NAME,
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
        cwd,
        env: this.envService.getEnv(),
        // The bundled ConPTY DLL closes the pseudo console directly. Native
        // Windows ConPTY makes node-pty fork a console-list helper on kill;
        // that helper can fail AttachConsole and crash the server process.
        ...(process.platform === "win32" ? { useConptyDll: true } : {}),
      });
    } catch (err) {
      logger.error("PTY spawn failed", {
        id,
        scopeId,
        shell,
        cwd,
        error: describeError(err),
      });
      throw err;
    }

    let seq = 0;

    const terminalSettings = this.settingsService.get().terminal;
    const fcSettings = terminalSettings.flowControl;
    const fc = new TerminalFlowControl({
      sink: (s, bytes) => this.sender?.data(id, s, bytes),
      highBytes: fcSettings.serverHighBytes,
      lowBytes: fcSettings.serverLowBytes,
    });
    // Hold the PTY until the client-side TerminalView has mounted and attached
    // its mcode:pty-data listener. Without this, the shell can emit its first
    // prompt before the view exists, leaving a newly-opened terminal blank
    // until some later output happens to arrive.
    fc.pause("client-request");
    this.flowControls.set(id, fc);

    // Size server-side retention from terminal.scrollback (the same knob that
    // drives the client xterm buffer) so reattach can replay roughly the
    // user's configured scrollback window, not a fixed 512 KB.
    const replayBuffer = new TerminalReplayBuffer(
      replayCapBytesForScrollback(terminalSettings.behavior.scrollback),
    );
    this.replayBuffers.set(id, replayBuffer);

    this.pidRegistry.register(id, pty.pid, shell);
    logger.info("PTY spawned", { id, pid: pty.pid, scopeId, shell, cwd });
    // Attach the shell PID to the server's Job Object. node-pty uses ConPTY
    // on Windows, which can spawn processes with CREATE_BREAKAWAY_FROM_JOB,
    // so explicit assignment is needed — inheritance alone is not sufficient.
    // Best-effort: no-op on non-Windows or if JobObject failed to init.
    const processScope = this.processScopeFactory.create();
    let processScopeReady = Promise.resolve(false);
    const globalAssigned = this.jobObject.assign(pty.pid);
    if (process.platform === "win32" && (!globalAssigned || !processScope.ready)) {
      logger.warn("PTY process scope unavailable; close will use process-tree fallback", {
        id,
        pid: pty.pid,
        reason: !globalAssigned ? "global-job-assignment-failed" : "child-job-init-failed",
      });
      processScope.close();
    } else if (process.platform === "win32") {
      const assignment = processScope.assign(pty.pid);
      if (!assignment.ok) {
        logger.warn("PTY process scope assignment failed; close will use process-tree fallback", {
          id,
          pid: pty.pid,
          error: assignment.error,
        });
        processScope.close();
      } else {
        processScopeReady = processScope.reconcile(pty.pid).then(
          (result) => {
            if (!result.ok) {
              logger.warn("PTY process scope reconciliation failed; close will use process-tree fallback", {
                id,
                pid: pty.pid,
                error: result.error,
              });
            }
            return result.ok;
          },
          (error: unknown) => {
            logger.warn("PTY process scope reconciliation failed; close will use process-tree fallback", {
              id,
              pid: pty.pid,
              error: describeError(error),
            });
            return false;
          },
        );
      }
    }
    this.jobObject.setDescription(pty.pid, `Mcode Terminal: ${shellBasename(shell)}`);

    const dataDisposable = pty.onData((data: string) => {
      // Re-encode to bytes so multi-byte sequences that straddle a node-pty
      // read boundary remain intact on the wire. Seq is assigned here, before
      // the ring-buffer decides whether to buffer or drop the chunk, so
      // evicted bytes leave a gap in the client's seq stream.
      const bytes = Buffer.from(data, "utf8");
      const currentSeq = seq++;
      // Record in replay buffer before flow control so replayed data matches
      // what was actually transmitted (replay buffer is not affected by pauses).
      replayBuffer.record(currentSeq, bytes);
      fc.push(currentSeq, bytes);
    });

    const exitDisposable = pty.onExit(({ exitCode, signal }) => {
      const current = this.sessions.get(id);
      if (!current) return;
      if (current.status === "closing") {
        current.pendingExit = { exitCode, signal };
        return;
      }
      this.handleNaturalExit(current, { exitCode, signal });
    });

    const session: PtySession = {
      id,
      threadId: scopeId,
      shell,
      cwd,
      pty,
      dataDisposable,
      exitDisposable,
      status: "running",
      pendingExit: null,
      closePromise: null,
      processScope,
      processScopeReady,
    };
    this.sessions = new Map([...this.sessions, [id, session]]);

    const updatedSet = new Set(threadPtys ?? []);
    updatedSet.add(id);
    this.threadIndex = new Map([
      ...this.threadIndex,
      [scopeId, updatedSet],
    ]);

    return { ptyId: id, shell: shellBasename(shell) };
  }

  /**
   * Hold a PTY under the client-request pause source. Idempotent.
   * Throws if the PTY ID is not found.
   */
  pause(ptyId: string): void {
    const fc = this.flowControls.get(ptyId);
    if (!fc) throw new Error(`PTY not found: ${ptyId}`);
    fc.pause("client-request");
  }

  /**
   * Release the client-request pause source for a PTY. Idempotent.
   * Throws if the PTY ID is not found.
   */
  resume(ptyId: string): void {
    const fc = this.flowControls.get(ptyId);
    if (!fc) throw new Error(`PTY not found: ${ptyId}`);
    fc.release("client-request");
  }

  /**
   * Invoked by the socket coordinator with the current worst-case
   * ws.bufferedAmount across all connected clients.
   */
  onBufferedAmountTick(bufferedAmount: number): void {
    for (const [, fc] of this.flowControls) {
      if (bufferedAmount > fc.marks.high) {
        fc.pause("socket-buffered");
      } else if (bufferedAmount < fc.marks.low) {
        fc.release("socket-buffered");
      }
    }
  }

  /** Forward keystrokes to a PTY session. */
  write(ptyId: string, data: string): void {
    const session = this.sessions.get(ptyId);
    if (!session) throw new Error(`PTY not found: ${ptyId}`);
    try {
      session.pty.write(data);
    } catch (err) {
      logger.error("PTY write failed", {
        id: session.id,
        pid: session.pty.pid,
        threadId: session.threadId,
        shell: session.shell,
        cwd: session.cwd,
        bytes: Buffer.byteLength(data, "utf8"),
        error: describeError(err),
      });
      throw err;
    }
  }

  /** Resize a PTY session. */
  resize(ptyId: string, cols: number, rows: number): void {
    const session = this.sessions.get(ptyId);
    if (!session) throw new Error(`PTY not found: ${ptyId}`);
    try {
      session.pty.resize(cols, rows);
    } catch (err) {
      logger.error("PTY resize failed", {
        id: session.id,
        pid: session.pty.pid,
        threadId: session.threadId,
        shell: session.shell,
        cwd: session.cwd,
        cols,
        rows,
        error: describeError(err),
      });
      throw err;
    }
  }

  /** Kill a single PTY session. No-op if the ID is unknown. */
  async kill(
    ptyId: string,
    reason: "user-requested-process-tree-close" | "app-shutdown" =
      "user-requested-process-tree-close",
  ): Promise<void> {
    const session = this.sessions.get(ptyId);
    if (!session) return;
    if (session.status === "closing" && session.closePromise) {
      return session.closePromise;
    }
    logger.info("PTY kill requested", {
      id: session.id,
      pid: session.pty.pid,
      threadId: session.threadId,
      shell: session.shell,
      reason,
    });
    session.status = "closing";
    const closePromise = this.closePty(session);
    session.closePromise = closePromise;
    return closePromise;
  }

  /** Kill all PTY sessions for a given thread, concurrently. */
  async killByThread(threadId: string): Promise<void> {
    const ptys = this.threadIndex.get(threadId);
    if (!ptys || ptys.size === 0) return;
    // Kill all PTYs concurrently: each killProcessTree is independent.
    await Promise.all([...ptys].map((ptyId) => this.kill(ptyId)));
    logger.info("All PTYs killed for thread", { threadId });
  }

  /** Kill all PTY sessions across all threads. */
  async shutdown(): Promise<void> {
    this.unsubscribeSettings();
    await Promise.all(
      [...this.sessions.keys()].map((ptyId) => this.kill(ptyId, "app-shutdown")),
    );
    this.pidRegistry.clear();
  }

  /**
   * Enable or disable graceful signal ladder (SIGHUP → SIGTERM → SIGKILL) for
   * the next destroyPty calls. Call with `true` just before app-quit shutdown.
   * User-initiated kills remain force-immediate regardless of this flag.
   */
  setGracefulKill(enabled: boolean): void {
    this.useGracefulKill = enabled;
  }

  /**
   * Replay buffered PTY output to a reconnecting client.
   * Sends chunks with seq > lastSeq as binary frames through the normal sender
   * path, then returns whether the replay window was exceeded.
   *
   * @param ptyId - The PTY session to replay.
   * @param lastSeq - Last seq number the client received before the disconnect.
   */
  reattach(
    ptyId: string,
    lastSeq: number,
    cold = false,
  ):
    | { mode: "delta" }
    | { mode: "reset"; discardThrough: number }
    | { mode: "checkpoint"; checkpoint: string; checkpointThrough: number } {
    const replayBuffer = this.replayBuffers.get(ptyId);
    if (!replayBuffer) throw new Error(`PTY not found: ${ptyId}`);

    const restore = cold ? replayBuffer.restoreCold() : null;
    const { chunks, gapped } = restore
      ? { chunks: restore.chunks, gapped: restore.mode === "reset" }
      : replayBuffer.replay(lastSeq);
    // Capture sender once to avoid repeated null checks inside the loop.
    const sender = this.sender;
    if (sender && !gapped) {
      for (const { seq, bytes } of chunks) {
        sender.data(ptyId, seq, bytes);
      }
    }
    if (restore?.mode === "checkpoint") {
      return {
        mode: "checkpoint",
        checkpoint: restore.checkpoint.data,
        checkpointThrough: restore.checkpoint.seq,
      };
    }
    if (restore?.mode === "reset") {
      return { mode: "reset", discardThrough: restore.discardThrough };
    }
    if (gapped) {
      return { mode: "reset", discardThrough: replayBuffer.latest };
    }
    return { mode: "delta" };
  }

  /** Saves a bounded serialized renderer state for a later cold mount. */
  checkpoint(ptyId: string, seq: number, data: string): { accepted: boolean } {
    const replayBuffer = this.replayBuffers.get(ptyId);
    if (!replayBuffer) throw new Error(`PTY not found: ${ptyId}`);
    return { accepted: replayBuffer.checkpointAt(seq, data) };
  }

  /**
   * Returns all currently active PTY sessions.
   * Used by reconnecting clients to discover which PTYs to reattach.
   */
  listActiveSessions(): Array<{ ptyId: string; threadId: string }> {
    return [...this.sessions.entries()].map(([ptyId, session]) => ({
      ptyId,
      threadId: session.threadId,
    }));
  }

  /**
   * Returns whether a PTY has non-shell child processes running.
   * Used by the optional kill confirmation feature (#315).
   *
   * @param ptyId - The PTY session to inspect.
   */
  async hasChildren(ptyId: string): Promise<{ hasChildren: boolean }> {
    const session = this.sessions.get(ptyId);
    if (!session) throw new Error(`PTY not found: ${ptyId}`);

    await this.awaitProcessScopeAuthority(session, 500);
    if (process.platform === "win32" && session.processScope.ownsProcessTree) {
      const snapshot = session.processScope.queryProcessIds();
      if (snapshot.ok && !snapshot.overflow) {
        return {
          hasChildren: snapshot.processIds.some((pid) => pid !== session.pty.pid),
        };
      }
    }

    const pending = [session.pty.pid];
    const visited = new Set<number>();
    try {
      while (pending.length > 0 && visited.size < 128) {
        const parentPid = pending.shift()!;
        if (visited.has(parentPid)) continue;
        visited.add(parentPid);
        const children = await listDirectChildren(parentPid);
        for (const child of children) {
          const basename =
            child.name.toLowerCase().split(/[\\/]/).pop() ?? child.name.toLowerCase();
          if (!SHELL_BASENAMES.has(basename)) return { hasChildren: true };
          pending.push(child.pid);
        }
      }
      return { hasChildren: pending.length > 0 };
    } catch (err) {
      logger.warn("Failed to inspect PTY process tree", {
        id: session.id,
        pid: session.pty.pid,
        threadId: session.threadId,
        error: describeError(err),
      });
      return { hasChildren: true };
    }
  }

  private async closePty(session: PtySession): Promise<void> {
    // Terminate the operating-system process tree while the root PID still
    // identifies its descendants. Closing ConPTY first can orphan children.
    if (this.useGracefulKill) {
      await gracefulKillProcessTree(session.pty.pid);
    } else if (
      process.platform === "win32" &&
      await this.awaitProcessScopeAuthority(session, 500) &&
      session.processScope.ownsProcessTree
    ) {
      const terminated = session.processScope.terminate(1);
      const emptied = terminated.ok
        ? await session.processScope.waitForEmpty(1_900)
        : terminated;
      if (!terminated.ok || !emptied.ok) {
        session.status = "running";
        session.closePromise = null;
        if (session.pendingExit) this.handleNaturalExit(session, session.pendingExit);
        throw new Error(terminated.error ?? emptied.error ?? "Windows process scope termination failed");
      }
    } else {
      try {
        await killProcessTree(session.pty.pid);
      } catch (err) {
        session.status = "running";
        session.closePromise = null;
        if (session.pendingExit) {
          this.handleNaturalExit(session, session.pendingExit);
        }
        throw err;
      }
    }

    try {
      session.pty.kill();
    } catch (err) {
      logger.warn("Failed to kill PTY process", {
        id: session.id,
        pid: session.pty.pid,
        threadId: session.threadId,
        shell: session.shell,
        error: describeError(err),
      });
    }
    this.finalizePty(session);
  }

  private async awaitProcessScopeAuthority(
    session: PtySession,
    timeoutMs: number,
  ): Promise<boolean> {
    if (process.platform !== "win32") return false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        session.processScopeReady,
        new Promise<false>((resolve) => {
          timeout = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  private handleNaturalExit(
    session: PtySession,
    exit: { readonly exitCode: number; readonly signal?: number },
  ): void {
    logger.info("PTY exited", {
      id: session.id,
      pid: session.pty.pid,
      scopeId: session.threadId,
      shell: session.shell,
      exitCode: exit.exitCode,
      signal: exit.signal,
      reason: "natural-exit",
    });
    this.finalizePty(session, exit.exitCode);
  }

  private finalizePty(session: PtySession, exitCode?: number): void {
    if (!this.sessions.has(session.id)) return;
    for (const [label, disposable] of [
      ["data", session.dataDisposable],
      ["exit", session.exitDisposable],
    ] as const) {
      try {
        disposable.dispose();
      } catch (err) {
        logger.warn(`Failed to dispose ${label} listener`, {
          id: session.id,
          pid: session.pty.pid,
          threadId: session.threadId,
          error: describeError(err),
        });
      }
    }
    if (exitCode !== undefined) {
      this.sender?.json("terminal.exit", { ptyId: session.id, code: exitCode });
    }
    this.removePty(session.id);
    session.processScope.close();
  }

  private removePty(ptyId: string): void {
    const session = this.sessions.get(ptyId);
    if (!session) return;

    const newSessions = new Map(this.sessions);
    newSessions.delete(ptyId);
    this.sessions = newSessions;

    const threadPtys = this.threadIndex.get(session.threadId);
    if (threadPtys) {
      const updated = new Set(threadPtys);
      updated.delete(ptyId);
      const newIndex = new Map(this.threadIndex);
      if (updated.size === 0) {
        newIndex.delete(session.threadId);
      } else {
        newIndex.set(session.threadId, updated);
      }
      this.threadIndex = newIndex;
    }

    this.flowControls.delete(ptyId);
    this.replayBuffers.delete(ptyId);
    this.pidRegistry.deregister(ptyId);
  }
}
