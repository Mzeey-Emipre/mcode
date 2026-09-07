/**
 * Legacy PTY (pseudo-terminal) management service.
 * Spawns and manages terminal sessions tied to threads.
 * Extracted from apps/desktop/src/main/pty-manager.ts.
 */

import { injectable, inject } from "tsyringe";
import * as NodePath from "node:path";
import * as NodeFS from "node:fs";
import { v4 as uuid } from "uuid";
import { logger } from "@mcode/shared";
import type { Settings, TerminalProfileReference, TerminalResolvedProfile, TerminalScope } from "@mcode/contracts";
import { TerminalFlowControl } from "./terminal-flow-control.js";
import { TerminalReplayBuffer, replayCapBytesForScrollback } from "./terminal-replay-buffer.js";
import type { PtyHostAdapter, PtyHostCommand } from "../../host/pty-host-adapter.js";
import type { PtyHostEvent } from "../../host/pty-host-protocol.js";
import type { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import type { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { GitWorktreeService } from "../../../projects/git/git-worktree-service.js";
import type { SettingsService } from "../../../settings/settings-service.js";
import { EnvService } from "../../../../runtime/environment/env-service.js";

/**
 * Returns the shell executable basename without a `.exe` suffix for display
 * and job-object descriptions.
 */
function shellBasename(shellPath: string): string {
  const base = shellPath.split(/[\\/]/).pop() ?? shellPath;
  return base.replace(/\.exe$/i, "").slice(0, 64);
}

const MAX_PTYS_PER_THREAD = 4;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MAX_HOST_ENVIRONMENT_NAMES = 256;
const MAX_HOST_ENVIRONMENT_BYTES = 65_536;

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Immutable record describing a single PTY session. */
interface PtySession {
  readonly id: string;
  readonly threadId: string;
  readonly shell: string;
  readonly cwd: string;
  readonly hostGeneration: string;
  status: "creating" | "running" | "closing";
  creationPromise: Promise<boolean>;
  closePromise: Promise<void> | null;
  commandSequence: bigint;
  commandTail: Promise<void>;
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
  readonly requestedProfileId: TerminalProfileReference;
  readonly resolvedProfile: TerminalResolvedProfile;
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

/**
 * Shell process basenames that are excluded when checking whether a terminal
 * has non-shell child processes. The comparison is case-insensitive.
 */
/** Manages PTY sessions for the integrated terminal. */
@injectable()
export class TerminalService {
  private sessions = new Map<string, PtySession>();
  private readonly completedHeadlessSessions = new Map<string, PtySession>();
  private threadIndex = new Map<string, Set<string>>();
  private pendingCreations = new Map<string, number>();
  private sender: PtySender | null = null;
  private flowControls = new Map<string, TerminalFlowControl>();
  private replayBuffers = new Map<string, TerminalReplayBuffer>();
  /** Last applied terminal.scrollback, used to skip redundant buffer resizes. */
  private lastScrollback: number;
  /** Unsubscribe handle for the settings-change listener. */
  private readonly unsubscribeSettings: () => void;
  private readonly unsubscribeHost: () => void;
  private useGracefulKill = false;

  constructor(
    @inject("ThreadRepo") private readonly threadRepo: ThreadRepo,
    @inject("WorkspaceRepo") private readonly workspaceRepo: WorkspaceRepo,
    @inject(GitWorktreeService) private readonly gitWorktrees: GitWorktreeService,
    @inject("SettingsService") private readonly settingsService: SettingsService,
    @inject(EnvService) private readonly envService: EnvService,
    @inject("PtyHost") private readonly host: PtyHostAdapter,
  ) {
    // Keep server-side scrollback retention in sync with the terminal.scrollback
    // setting: when the user changes it, resize all live replay buffers so
    // running sessions honour the new retention window.
    this.lastScrollback = this.settingsService.get().terminal.behavior.scrollback;
    this.unsubscribeSettings = this.settingsService.on("change", (next) => {
      this.applyScrollbackToReplayBuffers(next.terminal.behavior.scrollback);
    });
    this.unsubscribeHost = this.host.subscribe((event) => this.handleHostEvent(event));
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
  async create(scopeId: string, launch: LegacyTerminalLaunch): Promise<{ ptyId: string; shell: string }> {
    const { cwd } = this.preparePtyCreation(scopeId, launch);
    this.reserveCreation(scopeId);
    let reserved = true;
    const id = uuid();
    const shell = launch.executable;
    logger.info("Spawning PTY", { id, scopeId, shell, cwd });
    let hostGeneration: string;
    try {
      hostGeneration = (await this.host.start()).hostGeneration;
    } catch (error) {
      this.releaseCreation(scopeId);
      reserved = false;
      throw error;
    }
    const terminalSettings = this.settingsService.get().terminal;
    const fc = this.createFlowControl(id, terminalSettings, launch);
    this.flowControls.set(id, fc);
    this.replayBuffers.set(id, new TerminalReplayBuffer(
      replayCapBytesForScrollback(terminalSettings.behavior.scrollback),
    ));
    const session = this.createPtySession(id, scopeId, shell, cwd, hostGeneration, launch);
    this.sessions = new Map([...this.sessions, [id, session]]);
    const updatedSet = new Set(this.threadIndex.get(scopeId) ?? []);
    updatedSet.add(id);
    this.threadIndex = new Map([
      ...this.threadIndex,
      [scopeId, updatedSet],
    ]);
    this.releaseCreation(scopeId);
    reserved = false;
    try {
      const creation = this.host.create({
        sessionId: id,
        hostGeneration,
        launch: {
          requestedProfileId: launch.requestedProfileId,
          resolvedProfile: launch.resolvedProfile,
          scope: this.scopeFor(scopeId),
          arguments: launch.arguments,
        },
        cwd,
        protectedEnv: this.environmentSnapshot(launch.environment ?? this.envService.getEnv()),
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
      });
      session.creationPromise = creation.then(() => true, () => false);
      await creation;
      if (this.sessions.has(id) && session.status === "creating") session.status = "running";
      return { ptyId: id, shell: shellBasename(shell) };
    } catch (error) {
      this.finalizePty(session);
      throw error;
    } finally {
      if (reserved) this.releaseCreation(scopeId);
    }
  }

  private preparePtyCreation(
    scopeId: string,
    launch: LegacyTerminalLaunch | undefined,
  ): { readonly cwd: string } {
    const cwd = this.resolveWorkingDirectory(scopeId);
    if (!NodePath.isAbsolute(cwd) || !NodeFS.existsSync(cwd) || !NodeFS.statSync(cwd).isDirectory()) {
      throw new Error(`Invalid working directory: ${cwd}`);
    }
    const threadPtys = this.threadIndex.get(scopeId);
    if ((threadPtys?.size ?? 0) + (this.pendingCreations.get(scopeId) ?? 0) >= MAX_PTYS_PER_THREAD) {
      throw new Error(`Maximum PTY limit (${MAX_PTYS_PER_THREAD}) reached for scope ${scopeId}`);
    }
    this.assertHeadlessCapacity(launch);
    return { cwd };
  }

  private assertHeadlessCapacity(launch: LegacyTerminalLaunch | undefined): void {
    const globalLimit = this.settingsService.get().terminal.behavior.sessionLimit;
    if (launch?.headless && this.sessions.size + this.pendingCreationCount() >= globalLimit) {
      throw new Error("The app-wide Terminal session limit is reached");
    }
  }

  private pendingCreationCount(): number {
    let count = 0;
    for (const pending of this.pendingCreations.values()) count += pending;
    return count;
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

  private createPtySession(
    id: string,
    scopeId: string,
    shell: string,
    cwd: string,
    hostGeneration: string,
    launch: LegacyTerminalLaunch | undefined,
  ): PtySession {
    let resolveCloseBarrier!: () => void;
    const closeBarrier = new Promise<void>((resolve) => { resolveCloseBarrier = resolve; });
    return {
      id, threadId: scopeId, shell, cwd, hostGeneration,
      status: "creating",
      creationPromise: Promise.resolve(true),
      closePromise: null,
      commandSequence: 0n,
      commandTail: Promise.resolve(),
      headless: launch?.headless ?? false,
      outputListeners: new Set(),
      exitListeners: new Set(),
      headlessOutput: [],
      headlessExit: undefined,
      closeBarrier,
      resolveCloseBarrier,
    };
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

  private reserveCreation(scopeId: string): void {
    this.pendingCreations.set(scopeId, (this.pendingCreations.get(scopeId) ?? 0) + 1);
  }

  private releaseCreation(scopeId: string): void {
    const pending = (this.pendingCreations.get(scopeId) ?? 1) - 1;
    if (pending === 0) this.pendingCreations.delete(scopeId);
    else this.pendingCreations.set(scopeId, pending);
  }

  private scopeFor(scopeId: string): TerminalScope {
    const thread = this.threadRepo.findById(scopeId);
    if (thread) return { kind: "thread", workspaceId: thread.workspace_id, threadId: thread.id };
    return { kind: "workspace", workspaceId: scopeId };
  }

  private environmentSnapshot(environment: Record<string, string>): Array<{ name: string; value: string }> {
    const entries = Object.entries(environment)
      .filter(([name, value]) => /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) && typeof value === "string")
      .sort(([left], [right]) => left.localeCompare(right));
    if (entries.length > MAX_HOST_ENVIRONMENT_NAMES) {
      throw new Error("Terminal environment exceeds the host boundary limit");
    }
    for (const [, value] of entries) {
      if (value.length > 8_192) {
        throw new Error("Terminal environment contains an invalid entry");
      }
    }
    const snapshot = entries.map(([name, value]) => ({ name, value }));
    if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > MAX_HOST_ENVIRONMENT_BYTES) {
      throw new Error("Terminal environment exceeds the host boundary limit");
    }
    return snapshot;
  }

  /** Starts a private noninteractive PTY command that shares legacy capacity and process tracking. */
  async startPreparedCommand(threadId: string, launch: Omit<LegacyTerminalLaunch, "headless" | "environment">): Promise<{
    readonly terminalSessionId: string;
    readonly checkoutPath: string;
    readonly executable: string;
    readonly arguments: string[];
    readonly environmentNames: string[];
    onOutput(listener: (data: Uint8Array) => void): () => void;
    onExit(listener: (exitCode: number | null) => void): () => void;
    stop(): Promise<void>;
  }> {
    const environment = this.envService.getEnv();
    const environmentNames = Object.keys(environment).sort();
    if (environmentNames.length > MAX_HOST_ENVIRONMENT_NAMES) {
      throw new Error("Prepared terminal environment exceeds the host boundary limit");
    }
    const created = await this.create(threadId, {
      executable: launch.executable,
      arguments: [...launch.arguments],
      requestedProfileId: launch.requestedProfileId,
      resolvedProfile: launch.resolvedProfile,
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
      await this.write(ptyId, "\u0003");
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
  write(ptyId: string, data: string): Promise<void> {
    const session = this.sessions.get(ptyId);
    if (!session) throw new Error(`PTY not found: ${ptyId}`);
    if (session.status !== "running")
      throw new Error(`PTY is ${session.status}`);
    return this.sendCommand(session, (commandSeq) => ({
      sessionId: session.id,
      hostGeneration: session.hostGeneration,
      attachmentEpoch: "0",
      commandSeq,
      kind: "input",
      data: Buffer.from(data, "utf8"),
    }));
  }

  /** Resize a PTY session. */
  resize(ptyId: string, cols: number, rows: number): Promise<void> {
    const session = this.sessions.get(ptyId);
    if (!session) throw new Error(`PTY not found: ${ptyId}`);
    if (session.status !== "running")
      throw new Error(`PTY is ${session.status}`);
    return this.sendCommand(session, (commandSeq) => ({
      sessionId: session.id,
      hostGeneration: session.hostGeneration,
      attachmentEpoch: "0",
      commandSeq,
      kind: "resize",
      data: { cols, rows },
    }));
  }

  private sendCommand(session: PtySession, makeCommand: (commandSeq: string) => PtyHostCommand): Promise<void> {
    const send = async (): Promise<void> => {
      const commandSeq = session.commandSequence + 1n;
      await this.host.send(makeCommand(commandSeq.toString()));
      session.commandSequence = commandSeq;
    };
    session.commandTail = session.commandTail.then(send, send);
    return session.commandTail;
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
    session.status = "closing";
    const close = async (): Promise<void> => {
      await session.commandTail.catch(() => undefined);
      await this.host.close({
        sessionId: session.id,
        hostGeneration: session.hostGeneration,
        closeSeq: (session.commandSequence + 1n).toString(),
        reason: reason === "app-shutdown" && this.useGracefulKill ? "app-shutdown" : "user",
      });
      this.finalizePty(session);
    };
    const closePromise = session.creationPromise.then((created) => created ? close() : this.finalizePty(session)).catch((error: unknown) => {
      if (this.sessions.has(session.id)) {
        session.status = "running";
        session.closePromise = null;
      }
      throw error;
    });
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
    this.unsubscribeHost();
    const results = await Promise.allSettled(
      [...this.sessions.keys()].map((ptyId) => this.kill(ptyId, "app-shutdown")),
    );
    this.completedHeadlessSessions.clear();
    let shutdownError: unknown;
    try {
      await this.host.shutdown();
    } catch (error) {
      shutdownError = error;
    }
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (shutdownError !== undefined) failures.push(shutdownError);
    if (failures.length > 0) {
      throw new AggregateError(failures, "Terminal shutdown failed");
    }
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
    return this.host.inspectChildren(session.id, session.hostGeneration);
  }

  private handleHostEvent(event: PtyHostEvent): void {
    if (event.kind === "output") {
      this.handleHostOutput(event);
      return;
    }
    if (event.kind === "exit") {
      this.handleHostExit(event);
    }
    if (event.kind === "failure") this.handleHostFailure(event);
  }

  private handleHostOutput(event: Extract<PtyHostEvent, { kind: "output" }>): void {
    const session = this.sessions.get(event.sessionId);
    if (!session || session.hostGeneration !== event.hostGeneration) return;
    const bytes = Buffer.from(event.dataBase64, "base64");
    const sequence = Number(event.outputSeq);
    this.replayBuffers.get(session.id)?.record(sequence, bytes);
    if (session.headless) {
      appendHeadlessOutput(session, bytes, replayCapBytesForScrollback(this.lastScrollback));
      for (const listener of session.outputListeners) listener(bytes);
      return;
    }
    this.flowControls.get(session.id)?.push(sequence, bytes);
  }

  private handleHostExit(event: Extract<PtyHostEvent, { kind: "exit" }>): void {
    const session = this.sessions.get(event.sessionId);
    if (session && session.hostGeneration === event.hostGeneration) this.finalizePty(session, event.code ?? undefined);
  }

  private handleHostFailure(event: Extract<PtyHostEvent, { kind: "failure" }>): void {
    for (const session of this.sessions.values()) {
      if (session.hostGeneration === event.hostGeneration) this.finalizePty(session, 1);
    }
  }

  private finalizePty(session: PtySession, exitCode?: number): void {
    if (!this.sessions.has(session.id)) return;
    const awaitOwnerAttachment = session.headless && session.exitListeners.size === 0;
    this.notifyPtyExit(session, exitCode);
    this.removePty(session.id);
    if (awaitOwnerAttachment) {
      this.completedHeadlessSessions.set(session.id, session);
    }
    session.resolveCloseBarrier();
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
  }
}

function appendHeadlessOutput(session: PtySession, data: Uint8Array, maxBytes: number): void {
  const retained = Buffer.concat([...session.headlessOutput, Buffer.from(data)]);
  const bounded = retained.byteLength > maxBytes
    ? retained.subarray(retained.byteLength - maxBytes)
    : retained;
  session.headlessOutput = [bounded];
}
