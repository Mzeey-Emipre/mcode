import * as NodeChildProcess from "node:child_process";
import type { ProviderProcessPort } from "../host-ports.js";

const DEFAULT_IDLE_TTL_MS = 10 * 60 * 1_000;
const EVICTION_INTERVAL_MS = 60 * 1_000;

/** Arguments supplied to one private protocol adapter spawn. */
export interface SpawnArgs {
  sessionId: string;
  threadId: string;
  cwd: string;
  permissionMode: string;
  resumeFrom?: string;
  env: Record<string, string>;
}

/** Result of one private protocol adapter spawn. */
export interface SpawnResult<TState> {
  state: TState;
  pids: number[];
}

/** Private protocol operations used by the shared Provider session runtime. */
export interface ProtocolAdapter<TState> {
  spawn(args: SpawnArgs): Promise<SpawnResult<TState>>;
  isBusy(state: TState): boolean;
  interrupt(state: TState): Promise<void> | void;
  close(state: TState): Promise<void> | void;
  isStale(state: TState, args: { cwd: string; permissionMode: string }): boolean;
}

interface SessionRuntimeJobPort {
  readonly isWindowsJob: boolean;
  assign(pid: number): boolean;
  setDescription(pid: number, description: string): void;
}

interface SessionRuntimeEnvironmentPort {
  getEnv(): Record<string, string>;
}

interface SessionRuntimeLoggerPort {
  debug(message: string, context: Record<string, unknown>): void;
  info(message: string, context: Record<string, unknown>): void;
  warn(message: string, context: Record<string, unknown>): void;
}

interface PoolEntry<TState> {
  state: TState;
  pids: number[];
  lastUsedAt: number;
}

/** Owns the lifecycle for one Provider's persistent sessions. */
export class SessionRuntime<TState> {
  private readonly sessions = new Map<string, PoolEntry<TState>>();
  private readonly pendingSpawns = new Map<string, Promise<TState>>();
  private readonly stopsDuringSpawn = new Set<string>();
  private evictionTimer: ReturnType<typeof setInterval> | null = null;
  private readonly idleTtlMs: number;
  private shuttingDown = false;

  constructor(
    private readonly adapter: ProtocolAdapter<TState>,
    private readonly deps: {
      jobObject: SessionRuntimeJobPort;
      processes?: ProviderProcessPort;
      envService: SessionRuntimeEnvironmentPort;
      idleTtlMs?: number;
      logger?: SessionRuntimeLoggerPort;
    },
  ) {
    this.idleTtlMs = deps.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
  }

  /** Gets a live session and creates it lazily when it is absent or stale. */
  async acquire(args: {
    sessionId: string;
    threadId: string;
    cwd: string;
    permissionMode: string;
    resumeFrom?: string;
  }): Promise<TState> {
    if (this.shuttingDown) throw new Error("Provider session runtime is shutting down");
    this.ensureEvictionTimer();
    const existing = this.sessions.get(args.sessionId);
    if (existing) {
      if (this.adapter.isStale(existing.state, args)) await this.stop(args.sessionId);
      else {
        existing.lastUsedAt = Date.now();
        return existing.state;
      }
    }
    const pending = this.pendingSpawns.get(args.sessionId);
    if (pending) return pending;
    const spawn = this.spawn(args);
    this.pendingSpawns.set(args.sessionId, spawn);
    try {
      return await spawn;
    } finally {
      this.pendingSpawns.delete(args.sessionId);
    }
  }

  /** Returns the live state for one session. */
  get(sessionId: string): TState | undefined {
    return this.sessions.get(sessionId)?.state;
  }

  /** Records recent use so idle eviction preserves an active session. */
  recordUsage(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry) entry.lastUsedAt = Date.now();
  }

  /** Returns the number of live sessions. */
  get size(): number {
    return this.sessions.size;
  }

  /** Returns one bounded snapshot of live session states. */
  states(): TState[] {
    return [...this.sessions.values()].map((entry) => entry.state);
  }

  /** Evicts every non-busy session under memory pressure. */
  async evictNonBusy(reason: string): Promise<{ before: number; after: number; evicted: string[] }> {
    const before = this.sessions.size;
    const evicted: string[] = [];
    const sessions = Array.from(this.sessions);
    for (const [sessionId, entry] of sessions) {
      if (this.adapter.isBusy(entry.state)) continue;
      evicted.push(sessionId);
      this.deps.logger?.info("SessionRuntime evicting non-busy session", { sessionId, reason });
      await this.stop(sessionId);
    }
    return { before, after: this.sessions.size, evicted };
  }

  /** Stops one session and closes a spawn that completes after the stop request. */
  async stop(sessionId: string): Promise<void> {
    const pending = this.pendingSpawns.get(sessionId);
    if (pending) {
      this.stopsDuringSpawn.add(sessionId);
      await pending.catch(() => undefined);
      this.stopsDuringSpawn.delete(sessionId);
    }
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    this.sessions.delete(sessionId);
    await this.closeEntry(sessionId, entry);
  }

  /** Stops all sessions and rejects later acquisitions. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = null;
    }
    await Promise.all([
      ...[...this.pendingSpawns.keys()].map((sessionId) => this.stop(sessionId)),
      ...[...this.sessions.keys()].map((sessionId) => this.stop(sessionId)),
    ]);
  }

  private async spawn(args: {
    sessionId: string;
    threadId: string;
    cwd: string;
    permissionMode: string;
    resumeFrom?: string;
  }): Promise<TState> {
    const env = this.deps.envService.getEnv();
    const result = await this.adapter.spawn({ ...args, env });
    if (this.shuttingDown || this.stopsDuringSpawn.has(args.sessionId)) {
      await this.closeEntry(args.sessionId, { ...result, lastUsedAt: Date.now() });
      throw new Error(`Provider session stopped during spawn: ${args.sessionId}`);
    }
    if (this.deps.processes) {
      for (const pid of result.pids) {
        this.deps.processes.attach(pid, `mcode session ${args.sessionId}`);
      }
    } else if (this.deps.jobObject.isWindowsJob) {
      for (const pid of result.pids) {
        this.deps.jobObject.assign(pid);
        this.deps.jobObject.setDescription(pid, `mcode session ${args.sessionId}`);
      }
    }
    this.sessions.set(args.sessionId, { ...result, lastUsedAt: Date.now() });
    return result.state;
  }

  private ensureEvictionTimer(): void {
    if (this.evictionTimer) return;
    this.evictionTimer = setInterval(() => void this.evictIdle(), EVICTION_INTERVAL_MS);
    this.evictionTimer.unref?.();
  }

  private async evictIdle(): Promise<void> {
    const now = Date.now();
    const sessions = Array.from(this.sessions);
    for (const [sessionId, entry] of sessions) {
      if (now - entry.lastUsedAt > this.idleTtlMs && !this.adapter.isBusy(entry.state)) {
        this.deps.logger?.info("SessionRuntime evicting idle session", { sessionId });
        await this.stop(sessionId);
      }
    }
  }

  private async closeEntry(sessionId: string, entry: PoolEntry<TState>): Promise<void> {
    try {
      await this.adapter.interrupt(entry.state);
    } catch (error) {
      this.deps.logger?.warn("SessionRuntime interrupt failed", { sessionId, error: errorMessage(error) });
    }
    try {
      await this.adapter.close(entry.state);
    } catch (error) {
      this.deps.logger?.warn("SessionRuntime close failed", { sessionId, error: errorMessage(error) });
    }
    await this.hardKill(entry.pids);
  }

  private async hardKill(pids: number[]): Promise<void> {
    if (this.deps.processes) {
      await Promise.all(pids.map((pid) => this.deps.processes!.terminateTree(pid)));
      return;
    }
    await Promise.all(pids.map((pid) => new Promise<void>((resolve) => {
      if (this.deps.jobObject.isWindowsJob) {
        NodeChildProcess.execFile("taskkill", ["/T", "/F", "/PID", String(pid)], (error) => {
          if (error) this.deps.logger?.debug("taskkill failed (process may have exited)", { pid, error: errorMessage(error) });
          resolve();
        });
        return;
      }
      try {
        process.kill(pid);
      } catch (error) {
        this.deps.logger?.debug("process.kill failed (process may have exited)", { pid, error: errorMessage(error) });
      }
      resolve();
    })));
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
