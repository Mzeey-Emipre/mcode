/**
 * SessionRuntime — the uniform persistent-CLI-session lifecycle shared by every
 * Provider, parameterised over an opaque per-session state `TState`.
 *
 * Candidate B of the agent provider overhaul concentrates the lifecycle that
 * the four Providers (Claude, Cursor, Codex, Copilot) had each hand-rolled and
 * drifted on: a session pool, a lazy 60s idle-eviction timer with a real
 * `lastUsedAt + isBusy` guard, Windows `JobObject` attachment, env snapshot via
 * `EnvService`, lazy spawn, and a graceful-interrupt-then-hard-`taskkill /T /F`
 * close. The runtime owns all of it; the {@link ProtocolAdapter} supplies only
 * the protocol-specific I/O. Composition, not inheritance: each Provider holds
 * its own `SessionRuntime<TState>` and implements its own `ProtocolAdapter`.
 *
 * Convergence is the point. Before this, Codex/Copilot evicted on TTL alone
 * (no busy guard), only Cursor used `taskkill /T /F`, and Codex/Copilot did not
 * directly attach spawned PIDs to the JobObject. By moving JobObject attachment
 * and the hard kill into the runtime — acting on the PIDs the adapter surfaces
 * from `spawn` — every Provider gets the same correctness.
 */
import { execFile } from "node:child_process";
import { logger } from "@mcode/shared";
import type { JobObject } from "./job-object";
import type { EnvService } from "./env-service";

/** Default idle TTL before an unused, non-busy session is evicted. */
const DEFAULT_IDLE_TTL_MS = 10 * 60 * 1000;
/** How often the lazy eviction timer sweeps the pool. */
const EVICTION_INTERVAL_MS = 60 * 1000;

/** Arguments the runtime hands to {@link ProtocolAdapter.spawn}. */
export interface SpawnArgs {
  sessionId: string;
  threadId: string;
  cwd: string;
  permissionMode: string;
  /** SDK session id to resume from; undefined starts a fresh session. */
  resumeFrom?: string;
  /** Merged child environment, snapshotted by the runtime via EnvService. */
  env: Record<string, string>;
}

/**
 * Result of spawning a session: the opaque state plus any child PIDs the
 * runtime should attach to the Windows JobObject and `taskkill` on hard close.
 * Providers whose SDK hides the subprocess PID return an empty `pids` array;
 * JobObject/taskkill are then best-effort no-ops for that session.
 */
export interface SpawnResult<TState> {
  state: TState;
  pids: number[];
}

/** The protocol-specific I/O for one Provider. The Provider class implements this. */
export interface ProtocolAdapter<TState> {
  /** Spawn a fresh session for `sessionId`. */
  spawn(args: SpawnArgs): Promise<SpawnResult<TState>>;
  /** Eviction guard: true while the session has work in flight (mid-turn). */
  isBusy(state: TState): boolean;
  /** Protocol-level graceful interrupt (queue close / interruptTurn / disconnect / cancel). */
  interrupt(state: TState): Promise<void> | void;
  /** Provider-level teardown that is not the OS kill (close handles, drain). */
  close(state: TState): Promise<void> | void;
  /** Whether a pooled session must be discarded before reuse (dead process, or cwd/permissionMode mismatch). */
  isStale(state: TState, args: { cwd: string; permissionMode: string }): boolean;
}

/** Internal pool entry: opaque state plus the bookkeeping the runtime owns. */
interface PoolEntry<TState> {
  state: TState;
  pids: number[];
  lastUsedAt: number;
}

/**
 * Owns the lifecycle for one Provider's sessions. Per-Provider instance so
 * `TState` stays type-isolated.
 */
export class SessionRuntime<TState> {
  private readonly sessions = new Map<string, PoolEntry<TState>>();
  /**
   * In-flight spawns keyed by sessionId. Dedups overlapping `acquire` calls for
   * the same session: the first miss creates the spawn promise, later callers
   * await it instead of spawning a second process.
   */
  private readonly pendingSpawns = new Map<string, Promise<TState>>();
  private evictionTimer: ReturnType<typeof setInterval> | null = null;
  private readonly idleTtlMs: number;

  constructor(
    private readonly adapter: ProtocolAdapter<TState>,
    private readonly deps: { jobObject: JobObject; envService: EnvService; idleTtlMs?: number },
  ) {
    this.idleTtlMs = deps.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
  }

  /**
   * Get the live session for `sessionId`, spawning lazily if absent and
   * discarding a stale one first. Starts the eviction timer on first use and
   * stamps `lastUsedAt`.
   */
  async acquire(args: {
    sessionId: string;
    threadId: string;
    cwd: string;
    permissionMode: string;
    resumeFrom?: string;
  }): Promise<TState> {
    this.ensureEvictionTimer();

    const existing = this.sessions.get(args.sessionId);
    if (existing) {
      if (this.adapter.isStale(existing.state, { cwd: args.cwd, permissionMode: args.permissionMode })) {
        await this.stop(args.sessionId);
      } else {
        existing.lastUsedAt = Date.now();
        return existing.state;
      }
    }

    // Dedup concurrent spawns: a second overlapping `acquire` for the same
    // sessionId must not call `adapter.spawn` again and start a second process.
    const inFlight = this.pendingSpawns.get(args.sessionId);
    if (inFlight) return inFlight;

    const spawnPromise = (async () => {
      const env = this.deps.envService.getEnv();
      const { state, pids } = await this.adapter.spawn({ ...args, env });

      // Converged JobObject attachment: every Provider's spawned PIDs join the
      // Windows job so a server crash tears the whole tree down.
      if (this.deps.jobObject.isWindowsJob) {
        for (const pid of pids) {
          this.deps.jobObject.assign(pid);
          this.deps.jobObject.setDescription(pid, `mcode session ${args.sessionId}`);
        }
      }

      this.sessions.set(args.sessionId, { state, pids, lastUsedAt: Date.now() });
      return state;
    })();

    this.pendingSpawns.set(args.sessionId, spawnPromise);
    try {
      return await spawnPromise;
    } finally {
      this.pendingSpawns.delete(args.sessionId);
    }
  }

  /** The live state for `sessionId`, or undefined. */
  get(sessionId: string): TState | undefined {
    return this.sessions.get(sessionId)?.state;
  }

  /** Stamp `lastUsedAt` so an in-progress session is not evicted. */
  recordUsage(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry) entry.lastUsedAt = Date.now();
  }

  /** Number of live sessions (diagnostics/tests). */
  get size(): number {
    return this.sessions.size;
  }

  /** Snapshot of live pooled session states. */
  states(): TState[] {
    return [...this.sessions.values()].map((entry) => entry.state);
  }

  /**
   * Evict every pooled session that is not busy, regardless of idle age.
   * Used under active memory pressure to shrink provider session pools while
   * preserving in-flight turns.
   */
  async evictNonBusy(reason: string): Promise<{ before: number; after: number; evicted: string[] }> {
    const before = this.sessions.size;
    const evicted: string[] = [];
    for (const [sessionId, entry] of [...this.sessions]) {
      if (this.adapter.isBusy(entry.state)) continue;
      evicted.push(sessionId);
      logger.info("SessionRuntime evicting non-busy session", { sessionId, reason });
      await this.stop(sessionId);
    }
    return { before, after: this.sessions.size, evicted };
  }

  /**
   * Stop one session: graceful protocol interrupt, then provider close, then
   * the converged hard kill (`taskkill /T /F` on Windows) for any surfaced PID.
   */
  async stop(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    this.sessions.delete(sessionId);
    try {
      await this.adapter.interrupt(entry.state);
    } catch (err) {
      logger.warn("SessionRuntime interrupt failed", { sessionId, error: errMsg(err) });
    }
    try {
      await this.adapter.close(entry.state);
    } catch (err) {
      logger.warn("SessionRuntime close failed", { sessionId, error: errMsg(err) });
    }
    await this.hardKill(entry.pids);
  }

  /** Stop every session and clear the eviction timer. */
  async shutdown(): Promise<void> {
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = null;
    }
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.stop(id)));
  }

  private ensureEvictionTimer(): void {
    if (this.evictionTimer) return;
    this.evictionTimer = setInterval(() => {
      void this.evictIdle();
    }, EVICTION_INTERVAL_MS);
    // Do not keep the process alive solely for eviction sweeps.
    this.evictionTimer.unref?.();
  }

  /**
   * Evict sessions idle beyond the TTL. The converged guard: a session is never
   * evicted while `adapter.isBusy(state)` is true, regardless of idle time.
   */
  private async evictIdle(): Promise<void> {
    const now = Date.now();
    const toEvict: string[] = [];
    for (const [sessionId, entry] of this.sessions) {
      if (now - entry.lastUsedAt <= this.idleTtlMs) continue;
      if (this.adapter.isBusy(entry.state)) continue;
      toEvict.push(sessionId);
    }
    for (const sessionId of toEvict) {
      logger.info("SessionRuntime evicting idle session", { sessionId });
      await this.stop(sessionId);
    }
  }

  /**
   * Converged hard kill. On Windows, `taskkill /T /F /PID` via `execFile` tears
   * down the whole process tree (Node's `child.kill()` misses grandchildren on
   * Windows). Elsewhere, `process.kill`. No-op for sessions without a PID.
   */
  private async hardKill(pids: number[]): Promise<void> {
    await Promise.all(
      pids.map(
        (pid) =>
          new Promise<void>((resolve) => {
            if (process.platform === "win32") {
              execFile("taskkill", ["/T", "/F", "/PID", String(pid)], (err) => {
                if (err) logger.debug("taskkill failed (process may have exited)", { pid, error: errMsg(err) });
                resolve();
              });
            } else {
              try {
                process.kill(pid);
              } catch (err) {
                logger.debug("process.kill failed (process may have exited)", { pid, error: errMsg(err) });
              }
              resolve();
            }
          }),
      ),
    );
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
