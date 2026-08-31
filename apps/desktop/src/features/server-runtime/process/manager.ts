/**
 * Child process lifecycle manager for the Mcode server.
 * Spawns the server as a detached child process, polls for readiness,
 * and provides restart/shutdown capabilities.
 */

import { app } from "electron";
import type { ChildProcess } from "child_process";
import { existsSync, readFileSync, type WriteStream } from "fs";
import { join } from "path";
import { getMcodeDir } from "@mcode/shared";
import {
  getServerPortBand,
  SERVER_LOG_PATH,
  spawnServerProcess,
} from "./child.js";
import {
  attachServerExitHandler,
  PlannedRestartCoordinator,
} from "./exit-tracking.js";
import {
  delay,
  isPortInRange,
  lockFilePath,
  readPreferredPort,
  readServerLockWithRetry,
  sameOwnedServerIdentity,
  tryExistingServer,
  type OwnedServerIdentity,
  type ServerLock,
} from "./lock.js";
import {
  acquireStartupLock,
  createStartupLockDependencies,
  findAvailablePort,
  releaseStartupLock,
} from "./startup.js";
import { stopServerHeldByLock } from "./shutdown.js";

/** Interval between server readiness probes. */
const HEALTH_POLL_INTERVAL = 200;

/** Maximum server startup time, including database and workspace initialization. */
const STARTUP_TIMEOUT_MS = 30_000;

/** Number of lock-file reads after readiness passes. */
const LOCK_READ_ATTEMPTS = 10;

/** Port band for the desktop mode active when Electron loads this module. */
const { min: PORT_MIN, max: PORT_MAX } = getServerPortBand();

/** Manages the lifecycle of the detached Mcode server process. */
export class ServerManager {
  private serverProcess: NodeChildProcess.ChildProcess | null = null;
  private serverProcessGeneration = 0;
  private ownedServerIdentity: OwnedServerIdentity | null = null;
  private ownedServerProcess: NodeChildProcess.ChildProcess | null = null;
  private _port = 0;
  private _authToken = "";
  private _ipcPath = "";
  private _reusedExisting = false;
  private readonly plannedExitProcesses = new Set<NodeChildProcess.ChildProcess>();
  private readonly plannedRestartCoordinator = new PlannedRestartCoordinator();

  /** Callback invoked when the current server exits without a planned shutdown. */
  onUnexpectedExit: ((code: number | null) => void) | null = null;

  constructor(private readonly platform: NodeJS.Platform) {}

  /** The port the server is listening on. */
  get port(): number {
    return this._port;
  }

  /** The auth token required to connect to the server. */
  get authToken(): string {
    return this._authToken;
  }

  /** Whether this instance reused a server started by another Electron process. */
  get reusedExisting(): boolean {
    return this._reusedExisting;
  }

  /** IPC path for the server's fast-path push transport. */
  get ipcPath(): string {
    return this._ipcPath;
  }

  /** Start a server or reuse a healthy lock-owned server in this mode's port band. */
  async start(): Promise<{ port: number; authToken: string }> {
    const replacedProcesses = new Set<ChildProcess>();
    try {
      for (;;) {
        const reusableServer =
          await this.tryReuseExistingServer(replacedProcesses);
        if (reusableServer) return reusableServer;
        const sentinelPath = join(getMcodeDir(), "server.starting");
        const startupLock = await acquireStartupLock(
          createStartupLockDependencies(sentinelPath, () =>
            tryExistingServer(lockFilePath(getMcodeDir()), PORT_MIN, PORT_MAX),
          ),
        );
        if (startupLock.kind === "existing") {
          const existingServer = await this.useExistingServer(
            startupLock.lock,
            replacedProcesses,
          );
          if (existingServer) return existingServer;
          continue;
        }
        try {
          return await this.startNewServer();
        } finally {
          releaseStartupLock(sentinelPath, startupLock.owner);
        }
      }
    } catch (error) {
      this.clearPlannedExits(replacedProcesses);
      throw error;
    }
  }

  /** Probe the current server health endpoint with a short cancellation timeout. */
  async isHealthy(): Promise<boolean> {
    if (!this._port) return false;
    try {
      const response = await fetch(`http://localhost:${this._port}/health`, {
        signal: AbortSignal.timeout(3_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Replace an owned server, wait briefly, and start a fresh server. */
  async restart(): Promise<void> {
    const replacedProcess = this.serverProcess;
    try {
      if (!this._reusedExisting) await this.forceReplace();
      await delay(500);
      await this.start();
    } catch (error) {
      this.clearPlannedExit(replacedProcess);
      throw error;
    }
  }

  /** Restart an owned server without reporting its replaced child as a crash. */
  restartPlanned(): Promise<void> {
    return this.plannedRestartCoordinator.restart(
      this._reusedExisting,
      this.serverProcess,
      this.plannedExitProcesses,
      () => this.restart(),
    );
  }

  /** Detach from an owned child without killing its process or process group. */
  shutdown(): void {
    if (this._reusedExisting || !this.serverProcess) return;
    this.detachServerProcess();
  }

  /** Gracefully stop the in-band lock holder before an application update. */
  async stopServerHeldByLock(): Promise<void> {
    const result = await stopServerHeldByLock({
      lockPath: lockFilePath(getMcodeDir()),
      portMin: PORT_MIN,
      portMax: PORT_MAX,
      ownedIdentity: this.ownedServerIdentity,
      ownedProcess: this.currentOwnedProcess(),
      platform: this.platform,
    });
    if (result.clearOwnedIdentity) this.clearOwnedServer();
  }

  /** Stop the lock holder so a different server version can replace it. */
  async forceReplace(): Promise<void> {
    const plannedProcess = this.markCurrentExitAsPlanned();
    try {
      await this.stopServerHeldByLock();
    } catch (error) {
      this.clearPlannedExit(plannedProcess);
      throw error;
    }
  }

  /** Reuse a valid in-band server unless its version differs from this app. */
  private async tryReuseExistingServer(
    replacedProcesses: Set<ChildProcess>,
  ): Promise<{
    port: number;
    authToken: string;
  } | null> {
    const existing = await tryExistingServer(
      lockFilePath(getMcodeDir()),
      PORT_MIN,
      PORT_MAX,
    );
    if (!existing) return null;
    return this.useExistingServer(existing, replacedProcesses);
  }

  /** Apply a lock-owned server to this manager or replace a version mismatch. */
  private async useExistingServer(
    existing: ServerLock,
    replacedProcesses: Set<ChildProcess>,
  ): Promise<{ port: number; authToken: string } | null> {
    if (existing.version !== app.getVersion()) {
      console.log(
        `[server-manager] Version mismatch: running=${existing.version}, expected=${app.getVersion()}, replacing`,
      );
      const replacedProcess = this.serverProcess;
      await this.forceReplace();
      if (replacedProcess) replacedProcesses.add(replacedProcess);
      return null;
    }
    const ownsExistingServer =
      this.ownedServerIdentity !== null &&
      sameOwnedServerIdentity(existing, this.ownedServerIdentity);
    if (!ownsExistingServer) {
      this.clearOwnedServer();
      this.detachServerProcess();
    }
    this._port = existing.port;
    this._authToken = existing.authToken;
    this._ipcPath = existing.ipcPath;
    this._reusedExisting = !ownsExistingServer;
    return { port: this._port, authToken: this._authToken };
  }

  /** Find a port, spawn the child, and retain the server lock identity. */
  private async startNewServer(): Promise<{ port: number; authToken: string }> {
    this._port = await this.findStartupPort();
    const spawned = spawnServerProcess(this._port, this.platform);
    const generation = this.assignServerProcess(spawned.child);
    this.registerSpawnedServer(spawned.child, spawned.stderrStream, generation);
    try {
      await this.waitForReady(STARTUP_TIMEOUT_MS);
      const lock = await readServerLockWithRetry(
        lockFilePath(getMcodeDir()),
        LOCK_READ_ATTEMPTS,
        HEALTH_POLL_INTERVAL,
      );
      this.applyOwnedServerLock(lock, spawned.child, generation);
      return { port: this._port, authToken: this._authToken };
    } catch (error) {
      this.clearFailedStartup(spawned.child, spawned.stderrStream, generation);
      throw error;
    }
  }

  /** Prefer the previous valid port before scanning the bounded mode port band. */
  private async findStartupPort(): Promise<number> {
    const preferredPort = readPreferredPort(
      lockFilePath(getMcodeDir()),
      PORT_MIN,
      PORT_MAX,
    );
    if (preferredPort === null) return findAvailablePort(PORT_MIN, PORT_MAX);
    try {
      return await findAvailablePort(preferredPort, preferredPort + 1);
    } catch {
      return findAvailablePort(PORT_MIN, PORT_MAX);
    }
  }

  /** Register cleanup, stderr flushing, and unexpected-exit handling for a child. */
  private registerSpawnedServer(
    child: ChildProcess,
    stderrStream: WriteStream | undefined,
    generation: number,
  ): void {
    attachServerExitHandler({
      child,
      stderrStream,
      plannedExitProcesses: this.plannedExitProcesses,
      isCurrentProcess: () =>
        this.serverProcess === child &&
        this.serverProcessGeneration === generation,
      clearCurrentProcess: () => {
        this.detachServerProcess();
      },
      onChildExit: () => this.releaseOwnedServerProcess(child),
      onUnexpectedExit: (code) => this.onUnexpectedExit?.(code),
    });
  }

  /** Release references and the stderr stream when readiness never succeeds. */
  private clearFailedStartup(
    child: ChildProcess,
    stderrStream: WriteStream | undefined,
    generation: number,
  ): void {
    if (
      this.serverProcess !== child ||
      this.serverProcessGeneration !== generation
    ) {
      return;
    }
    this.detachServerProcess();
    stderrStream?.end();
  }

  /** Apply the lock data written by a newly ready server. */
  private applyOwnedServerLock(
    lock: ServerLock,
    child: ChildProcess,
    generation: number,
  ): void {
    if (!this.isSpawnedChildCurrentAndLive(child, generation)) {
      throw new Error("Server process exited before lock application");
    }
    if (!this.matchesSpawnedServerLock(lock, child)) {
      throw new Error("Server lock does not match the spawned server process");
    }
    this._authToken = lock.authToken;
    this._ipcPath = lock.ipcPath;
    this._reusedExisting = false;
    this.ownedServerIdentity = {
      pid: lock.pid,
      startedAt: lock.startedAt,
      authToken: lock.authToken,
    };
    this.ownedServerProcess = child;
  }

  /** Return whether a spawned child is the live process assigned to this generation. */
  private isSpawnedChildCurrentAndLive(
    child: ChildProcess,
    generation: number,
  ): boolean {
    return (
      this.serverProcess === child &&
      this.serverProcessGeneration === generation &&
      child.exitCode === null &&
      child.signalCode === null
    );
  }

  /** Return whether a lock proves that this exact spawned child reached readiness. */
  private matchesSpawnedServerLock(
    lock: ServerLock,
    child: ChildProcess,
  ): boolean {
    return (
      child.pid === lock.pid &&
      lock.port === this._port &&
      lock.version === app.getVersion() &&
      isPortInRange(lock.port, PORT_MIN, PORT_MAX)
    );
  }

  /** Assign a generation to a newly spawned child before attaching its exit handler. */
  private assignServerProcess(child: ChildProcess): number {
    this.serverProcessGeneration += 1;
    this.serverProcess = child;
    return this.serverProcessGeneration;
  }

  /** Detach the active child so delayed exits cannot affect a newer server generation. */
  private detachServerProcess(): void {
    this.serverProcessGeneration += 1;
    this.serverProcess = null;
  }

  /** Forget ownership when the lock no longer identifies this manager's child. */
  private clearOwnedServer(): void {
    this.ownedServerIdentity = null;
    this.ownedServerProcess = null;
  }

  /** Release force-stop authority when the original owned child exits. */
  private releaseOwnedServerProcess(child: ChildProcess): void {
    if (this.ownedServerProcess !== child) return;
    this.ownedServerProcess = null;
  }

  /** Return the live owned child that authorizes a forced process-tree stop. */
  private currentOwnedProcess(): ChildProcess | null {
    const child = this.ownedServerProcess;
    if (
      !child ||
      child.exitCode !== null ||
      child.signalCode !== null
    ) {
      return null;
    }
    return child;
  }

  /** Mark the active child as an intentional stop and return it for failure cleanup. */
  private markCurrentExitAsPlanned(): ChildProcess | null {
    const child = this.serverProcess;
    if (child) this.plannedExitProcesses.add(child);
    return child;
  }

  /** Clear a planned-exit marker after the replacement operation fails. */
  private clearPlannedExit(child: ChildProcess | null): void {
    if (child) this.plannedExitProcesses.delete(child);
  }

  /** Clear markers retained only while a version-replacement startup is pending. */
  private clearPlannedExits(processes: Set<ChildProcess>): void {
    for (const child of processes) this.plannedExitProcesses.delete(child);
  }

  /** Poll the server health endpoint until it becomes ready or its child exits. */
  private async waitForReady(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.serverProcess) throw this.createStartupFailureError();
      if (await this.isHealthy()) return;
      await delay(HEALTH_POLL_INTERVAL);
    }
    throw this.createStartupTimeoutError(timeoutMs);
  }

  /** Create an error for a child that exits before the server becomes ready. */
  private createStartupFailureError(): Error {
    const logExcerpt = this.readServerLogTail();
    return new Error(
      "Server process exited before becoming ready." +
        (logExcerpt
          ? `\n\nServer log:\n${logExcerpt}`
          : "\nNo server log available."),
    );
  }

  /** Create an error for a child that does not become ready before its deadline. */
  private createStartupTimeoutError(timeoutMs: number): Error {
    const logExcerpt = this.readServerLogTail();
    return new Error(
      `Server did not become ready within ${timeoutMs / 1000}s on port ${this._port}.` +
        (logExcerpt ? `\n\nServer log:\n${logExcerpt}` : ""),
    );
  }

  /** Read the final stderr log lines for an unsuccessful packaged startup. */
  private readServerLogTail(): string {
    try {
      if (!existsSync(SERVER_LOG_PATH)) return "";
      const content = readFileSync(SERVER_LOG_PATH, "utf-8");
      return content.split("\n").slice(-40).join("\n").trim();
    } catch {
      return "";
    }
  }
}
