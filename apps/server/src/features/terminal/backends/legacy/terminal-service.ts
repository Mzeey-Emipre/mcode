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
import type { Settings } from "@mcode/contracts";
import { killProcessTree, gracefulKillProcessTree, listDirectChildren } from "../../../../runtime/process/containment/process-kill.js";
import { TerminalFlowControl } from "./terminal-flow-control.js";
import { TerminalReplayBuffer, replayCapBytesForScrollback } from "./terminal-replay-buffer.js";
import type { PtyPidRegistry } from "../../host/pty-pid-registry.js";
import type { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import type { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { GitWorktreeService } from "../../../projects/git/git-worktree-service.js";
import type { SettingsService } from "../../../settings/settings-service.js";
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
const NOOP_DISPOSABLE: IDisposable = { dispose: () => undefined };
const MAX_PREPARED_ENVIRONMENT_NAMES = 512;

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
  dataDisposable: IDisposable;
  exitDisposable: IDisposable;
  status: "running" | "closing";
  pendingExit: { readonly exitCode: number; readonly signal?: number } | null;
  closePromise: Promise<void> | null;
  readonly processScope: WindowsProcessScope;
  readonly processScopeReady: Promise<boolean>;
  readonly headless: boolean;
  readonly outputListeners: Set<(data: Uint8Array) => void>;
  readonly exitListeners: Set<(exitCode: number | null) => void>;
  headlessOutput: Uint8Array[];
  headlessExit: number | null | undefined;
  readonly closeBarrier: Promise<void>;
  readonly resolveCloseBarrier: () => void;
}

interface LegacyTerminalLaunch {
  readonly executable: string;
  readonly arguments: string[];
  readonly headless: boolean;
  readonly environment?: Record<string, string>;
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
  private readonly completedHeadlessSessions = new Map<string, PtySession>();
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
    @inject(GitWorktreeService) private readonly gitWorktrees: GitWorktreeService,
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
  create(scopeId: string, launch?: LegacyTerminalLaunch): { ptyId: string; shell: string } {
    const { cwd, threadPtys } = this.preparePtyCreation(scopeId, launch);
    const id = uuid();
    const shell = launch?.executable ?? defaultShell();
    logger.info("Spawning PTY", { id, scopeId, shell, cwd });
    const terminalSettings = this.settingsService.get().terminal;
    const pty = this.spawnPty(id, scopeId, shell, cwd, launch);
    const fc = this.createFlowControl(id, terminalSettings, launch);
    this.flowControls.set(id, fc);
    const replayBuffer = new TerminalReplayBuffer(
      replayCapBytesForScrollback(terminalSettings.behavior.scrollback),
    );
    this.replayBuffers.set(id, replayBuffer);

    this.pidRegistry.register(id, pty.pid, shell);
    logger.info("PTY spawned", { id, pid: pty.pid, scopeId, shell, cwd });
    const { processScope, processScopeReady } = this.establishProcessScope(id, pty);
    this.jobObject.setDescription(pty.pid, `Mcode Terminal: ${shellBasename(shell)}`);
    const session = this.createPtySession(
      id, scopeId, shell, cwd, pty, processScope, processScopeReady, launch,
    );
    this.sessions = new Map([...this.sessions, [id, session]]);
    const updatedSet = new Set(threadPtys ?? []);
    updatedSet.add(id);
    this.threadIndex = new Map([
      ...this.threadIndex,
      [scopeId, updatedSet],
    ]);
    this.attachPtyListeners(session, launch, fc, replayBuffer, terminalSettings.behavior.scrollback);
    return { ptyId: id, shell: shellBasename(shell) };
  }

  private preparePtyCreation(
    scopeId: string,
    launch: LegacyTerminalLaunch | undefined,
  ): { readonly cwd: string; readonly threadPtys: ReadonlySet<string> | undefined } {
    const cwd = this.resolveWorkingDirectory(scopeId);
    if (!isAbsolute(cwd) || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
      throw new Error(`Invalid working directory: ${cwd}`);
    }
    const threadPtys = this.threadIndex.get(scopeId);
    if ((threadPtys?.size ?? 0) >= MAX_PTYS_PER_THREAD) {
      throw new Error(`Maximum PTY limit (${MAX_PTYS_PER_THREAD}) reached for scope ${scopeId}`);
    }
    const globalLimit = this.settingsService.get().terminal.behavior.sessionLimit;
    if (launch?.headless && this.sessions.size >= globalLimit) {
      throw new Error("The app-wide Terminal session limit is reached");
    }
    return { cwd, threadPtys };
  }

  private spawnPty(
    id: string,
    scopeId: string,
    shell: string,
    cwd: string,
    launch: LegacyTerminalLaunch | undefined,
  ): IPty {
    try {
      return getSpawn()(shell, launch?.arguments ?? [], {
        name: TERM_NAME,
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
        cwd,
        env: launch?.environment ?? this.envService.getEnv(),
        ...(process.platform === "win32" ? { useConptyDll: true } : {}),
      });
    } catch (error) {
      logger.error("PTY spawn failed", {
        id,
        scopeId,
        shell,
        cwd,
        error: describeError(error),
      });
      throw error;
    }
  }

  private createFlowControl(
    id: string,
    settings: Settings["terminal"],
    launch: LegacyTerminalLaunch | undefined,
  ): TerminalFlowControl {
    const flowControl = new TerminalFlowControl({
      sink: (sequence, bytes) => this.sender?.data(id, sequence, bytes),
      highBytes: settings.flowControl.serverHighBytes,
      lowBytes: settings.flowControl.serverLowBytes,
    });
    if (!launch?.headless) flowControl.pause("client-request");
    return flowControl;
  }

  private establishProcessScope(
    id: string,
    pty: IPty,
  ): { readonly processScope: ReturnType<WindowsProcessScopeFactory["create"]>; readonly processScopeReady: Promise<boolean> } {
    const processScope = this.processScopeFactory.create();
    let processScopeReady = Promise.resolve(false);
    const globalAssigned = this.jobObject.assign(pty.pid);
    if (process.platform === "win32" && (!globalAssigned || !processScope.ready)) {
      logger.warn("PTY process scope unavailable; close will use process-tree fallback", {
        id, pid: pty.pid,
        reason: !globalAssigned ? "global-job-assignment-failed" : "child-job-init-failed",
      });
      processScope.close();
    } else if (process.platform === "win32") {
      processScopeReady = this.assignProcessScope(id, pty, processScope);
    }
    return { processScope, processScopeReady };
  }

  private assignProcessScope(
    id: string,
    pty: IPty,
    processScope: ReturnType<WindowsProcessScopeFactory["create"]>,
  ): Promise<boolean> {
    const assignment = processScope.assign(pty.pid);
    if (!assignment.ok) {
      logger.warn("PTY process scope assignment failed; close will use process-tree fallback", {
        id, pid: pty.pid, error: assignment.error,
      });
      processScope.close();
      return Promise.resolve(false);
    }
    return processScope.reconcile(pty.pid).then(
      (result) => this.logReconciliationResult(id, pty.pid, result),
      (error: unknown) => this.logReconciliationFailure(id, pty.pid, error),
    );
  }

  private logReconciliationResult(
    id: string,
    pid: number,
    result: { readonly ok: boolean; readonly error?: string },
  ): boolean {
    if (!result.ok) {
      logger.warn("PTY process scope reconciliation failed; close will use process-tree fallback", {
        id, pid, error: result.error,
      });
    }
    return result.ok;
  }

  private logReconciliationFailure(id: string, pid: number, error: unknown): false {
    logger.warn("PTY process scope reconciliation failed; close will use process-tree fallback", {
      id, pid, error: describeError(error),
    });
    return false;
  }

  private createPtySession(
    id: string,
    scopeId: string,
    shell: string,
    cwd: string,
    pty: IPty,
    processScope: ReturnType<WindowsProcessScopeFactory["create"]>,
    processScopeReady: Promise<boolean>,
    launch: LegacyTerminalLaunch | undefined,
  ): PtySession {
    let resolveCloseBarrier!: () => void;
    const closeBarrier = new Promise<void>((resolve) => { resolveCloseBarrier = resolve; });
    return {
      id, threadId: scopeId, shell, cwd, pty,
      dataDisposable: NOOP_DISPOSABLE,
      exitDisposable: NOOP_DISPOSABLE,
      status: "running",
      pendingExit: null,
      closePromise: null,
      processScope,
      processScopeReady,
      headless: launch?.headless ?? false,
      outputListeners: new Set(),
      exitListeners: new Set(),
      headlessOutput: [],
      headlessExit: undefined,
      closeBarrier,
      resolveCloseBarrier,
    };
  }

  private attachPtyListeners(
    session: PtySession,
    launch: LegacyTerminalLaunch | undefined,
    flowControl: TerminalFlowControl,
    replayBuffer: TerminalReplayBuffer,
    scrollback: number,
  ): void {
    let sequence = 0;
    const dataDisposable = session.pty.onData((data: string) => {
      const bytes = Buffer.from(data, "utf8");
      const currentSequence = sequence++;
      replayBuffer.record(currentSequence, bytes);
      if (launch?.headless) {
        appendHeadlessOutput(session, bytes, replayCapBytesForScrollback(scrollback));
        for (const listener of session.outputListeners) listener(bytes);
        return;
      }
      flowControl.push(currentSequence, bytes);
    });
    this.storePtyDisposable(session, "dataDisposable", dataDisposable);
    const exitDisposable = session.pty.onExit(({ exitCode, signal }) => {
      const current = this.sessions.get(session.id);
      if (!current) return;
      if (current.status === "closing") {
        current.pendingExit = { exitCode, signal };
        return;
      }
      this.handleNaturalExit(current, { exitCode, signal });
    });
    this.storePtyDisposable(session, "exitDisposable", exitDisposable);
  }

  private storePtyDisposable(
    session: PtySession,
    key: "dataDisposable" | "exitDisposable",
    disposable: { dispose(): void },
  ): void {
    if (this.sessions.has(session.id)) session[key] = disposable;
    else disposable.dispose();
  }

  /** Resolves the checkout path used by a thread or workspace terminal session. */
  resolveWorkingDirectory(scopeId: string): string {
    const thread = this.threadRepo.findById(scopeId);
    if (thread) {
      const workspace = this.workspaceRepo.findById(thread.workspace_id);
      if (!workspace) throw new Error(`Workspace not found: ${thread.workspace_id}`);
      return this.gitWorktrees.resolveWorkingDir(workspace.path, thread.mode, thread.worktree_path);
    }
    const workspace = this.workspaceRepo.findById(scopeId);
    if (!workspace) throw new Error(`Thread or workspace not found: ${scopeId}`);
    return workspace.path;
  }

  /** Starts a private noninteractive PTY command that shares legacy capacity and process tracking. */
  startPreparedCommand(threadId: string, launch: { readonly executable: string; readonly arguments: readonly string[] }): {
    readonly terminalSessionId: string;
    readonly checkoutPath: string;
    readonly executable: string;
    readonly arguments: string[];
    readonly environmentNames: string[];
    onOutput(listener: (data: Uint8Array) => void): () => void;
    onExit(listener: (exitCode: number | null) => void): () => void;
    stop(): Promise<void>;
  } {
    const environment = this.envService.getEnv();
    const environmentNames = Object.keys(environment).sort();
    if (environmentNames.length > MAX_PREPARED_ENVIRONMENT_NAMES) {
      throw new Error("Prepared terminal environment exceeds the Action snapshot limit");
    }
    const created = this.create(threadId, {
      executable: launch.executable,
      arguments: [...launch.arguments],
      headless: true,
      environment,
    });
    const session = this.sessions.get(created.ptyId) ?? this.completedHeadlessSessions.get(created.ptyId);
    if (!session) throw new Error("Prepared terminal session was not retained");
    return {
      terminalSessionId: session.id,
      checkoutPath: session.cwd,
      executable: launch.executable,
      arguments: [...launch.arguments],
      environmentNames,
      onOutput: (listener) => {
        session.outputListeners.add(listener);
        for (const data of session.headlessOutput) listener(data);
        return () => session.outputListeners.delete(listener);
      },
      onExit: (listener) => {
        session.exitListeners.add(listener);
        if (session.headlessExit !== undefined) {
          listener(session.headlessExit);
          if (!this.sessions.has(session.id)) this.completedHeadlessSessions.delete(session.id);
        }
        return () => session.exitListeners.delete(listener);
      },
      stop: async () => {
        if (this.completedHeadlessSessions.delete(session.id)) return;
        await this.stopPreparedCommand(session.id);
      },
    };
  }

  /** Requests a graceful Ctrl-C close, then force-closes after the Action five-second barrier. */
  private async stopPreparedCommand(ptyId: string): Promise<void> {
    const session = this.sessions.get(ptyId);
    if (!session) return;
    try {
      session.pty.write("\u0003");
    } catch {
      await this.kill(ptyId);
      return;
    }
    const closed = await Promise.race([
      session.closeBarrier.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
    ]);
    if (!closed) await this.kill(ptyId);
    await session.closeBarrier;
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
    await Promise.all([...ptys]
      .filter((ptyId) => !this.sessions.get(ptyId)?.headless)
      .map((ptyId) => this.kill(ptyId)));
    logger.info("All PTYs killed for thread", { threadId });
  }

  /** Kill all PTY sessions across all threads. */
  async shutdown(): Promise<void> {
    this.unsubscribeSettings();
    await Promise.all(
      [...this.sessions.keys()].map((ptyId) => this.kill(ptyId, "app-shutdown")),
    );
    this.completedHeadlessSessions.clear();
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
    const replay = this.prepareReattachReplay(replayBuffer, lastSeq, cold);
    this.sendReattachReplay(ptyId, replay.chunks, replay.gapped);
    return this.reattachResult(replayBuffer, replay.restore, replay.gapped);
  }

  private prepareReattachReplay(
    replayBuffer: TerminalReplayBuffer,
    lastSeq: number,
    cold: boolean,
  ): {
    readonly chunks: ReturnType<TerminalReplayBuffer["replay"]>["chunks"];
    readonly gapped: boolean;
    readonly restore: ReturnType<TerminalReplayBuffer["restoreCold"]> | null;
  } {
    const restore = cold ? replayBuffer.restoreCold() : null;
    if (restore) {
      return { chunks: restore.chunks, gapped: restore.mode === "reset", restore };
    }
    const replay = replayBuffer.replay(lastSeq);
    return { ...replay, restore: null };
  }

  private sendReattachReplay(
    ptyId: string,
    chunks: ReturnType<TerminalReplayBuffer["replay"]>["chunks"],
    gapped: boolean,
  ): void {
    const sender = this.sender;
    if (!sender || gapped) return;
    for (const { seq, bytes } of chunks) sender.data(ptyId, seq, bytes);
  }

  private reattachResult(
    replayBuffer: TerminalReplayBuffer,
    restore: ReturnType<TerminalReplayBuffer["restoreCold"]> | null,
    gapped: boolean,
  ):
    | { mode: "delta" }
    | { mode: "reset"; discardThrough: number }
    | { mode: "checkpoint"; checkpoint: string; checkpointThrough: number } {
    if (restore?.mode === "checkpoint") {
      return {
        mode: "checkpoint",
        checkpoint: restore.checkpoint.data,
        checkpointThrough: restore.checkpoint.seq,
      };
    }
    if (restore?.mode === "reset") return { mode: "reset", discardThrough: restore.discardThrough };
    if (gapped) return { mode: "reset", discardThrough: replayBuffer.latest };
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
    return [...this.sessions.entries()]
      .filter(([, session]) => !session.headless)
      .map(([ptyId, session]) => ({
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
    const scopedChildren = this.childrenInWindowsScope(session);
    if (scopedChildren !== null) return { hasChildren: scopedChildren };
    return this.inspectPtyProcessTree(session);
  }

  private childrenInWindowsScope(session: PtySession): boolean | null {
    if (process.platform !== "win32" || !session.processScope.ownsProcessTree) return null;
    const snapshot = session.processScope.queryProcessIds();
    if (!snapshot.ok || snapshot.overflow) return null;
    return snapshot.processIds.some((pid) => pid !== session.pty.pid);
  }

  private async inspectPtyProcessTree(session: PtySession): Promise<{ hasChildren: boolean }> {
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
    await this.terminatePtyProcessTree(session);
    this.killPtyHandle(session);
    this.finalizePty(session);
  }

  private async terminatePtyProcessTree(session: PtySession): Promise<void> {
    if (this.useGracefulKill) {
      await gracefulKillProcessTree(session.pty.pid);
      return;
    }
    try {
      if (await this.canUseProcessScope(session)) {
        await this.terminateWindowsProcessScope(session);
        return;
      }
      await killProcessTree(session.pty.pid);
    } catch (error) {
      this.restoreFailedClose(session);
      throw error;
    }
  }

  private async canUseProcessScope(session: PtySession): Promise<boolean> {
    return process.platform === "win32" &&
      await this.awaitProcessScopeAuthority(session, 500) &&
      session.processScope.ownsProcessTree;
  }

  private async terminateWindowsProcessScope(session: PtySession): Promise<void> {
    const terminated = session.processScope.terminate(1);
    const emptied = terminated.ok
      ? await session.processScope.waitForEmpty(1_900)
      : terminated;
    if (!terminated.ok || !emptied.ok) {
      throw new Error(terminated.error ?? emptied.error ?? "Windows process scope termination failed");
    }
  }

  private restoreFailedClose(session: PtySession): void {
    session.status = "running";
    session.closePromise = null;
    if (session.pendingExit) this.handleNaturalExit(session, session.pendingExit);
  }

  private killPtyHandle(session: PtySession): void {
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
    this.disposePtyListeners(session);
    const awaitOwnerAttachment = session.headless && session.exitListeners.size === 0;
    this.notifyPtyExit(session, exitCode);
    this.removePty(session.id);
    if (awaitOwnerAttachment) {
      this.completedHeadlessSessions.set(session.id, session);
    }
    session.processScope.close();
    session.resolveCloseBarrier();
  }

  private disposePtyListeners(session: PtySession): void {
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
  }

  private notifyPtyExit(session: PtySession, exitCode?: number): void {
    if (exitCode !== undefined && !session.headless) {
      this.sender?.json("terminal.exit", { ptyId: session.id, code: exitCode });
    }
    if (session.headless) session.headlessExit = exitCode ?? null;
    for (const listener of session.exitListeners) {
      try {
        listener(exitCode ?? null);
      } catch (err) {
        logger.warn("Headless terminal exit listener failed during PTY finalization", {
          id: session.id,
          pid: session.pty.pid,
          threadId: session.threadId,
          error: describeError(err),
        });
      }
    }
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

function appendHeadlessOutput(session: PtySession, data: Uint8Array, maxBytes: number): void {
  const retained = Buffer.concat([...session.headlessOutput, Buffer.from(data)]);
  const bounded = retained.byteLength > maxBytes
    ? retained.subarray(retained.byteLength - maxBytes)
    : retained;
  session.headlessOutput = [bounded];
}
