import * as NodeChildProcess from "node:child_process";
import * as NodeNet from "node:net";
import { logger } from "@mcode/shared";

/** Isolation boundary: never share a server across working directories. */
export type OpenCodePoolKey = Readonly<{ binaryPath: string; cwd: string; hostname: string }>;

/** Stable text form of a pool key for map lookups. */
export function openCodePoolKeyText(key: OpenCodePoolKey): string {
  return `${key.binaryPath}\u0000${key.cwd}\u0000${key.hostname}`;
}

/** One pooled `serve` child with its reference count and liveness. */
export interface OpenCodePoolEntry {
  key: OpenCodePoolKey;
  port: number;
  baseUrl: string;
  pid: number | null;
  refs: number;
  lastUsedAt: number;
  ready: boolean;
}

/** Minimal child-process surface the pool needs for exit watching and kills. */
export interface OpenCodePoolProcess {
  pid?: number;
  on(event: "exit", listener: (code: number | null, signal: string | null) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  off(event: "exit", listener: (code: number | null, signal: string | null) => void): void;
  off(event: "error", listener: (error: Error) => void): void;
  kill(signal?: number | NodeJS.Signals): boolean;
}

/** Injectable pool seams: spawning, health, termination, ports, and time. */
export interface OpenCodePoolDeps {
  spawn(binaryPath: string, args: string[], cwd: string, env: Record<string, string>): OpenCodePoolProcess;
  waitForHealth(baseUrl: string, timeoutMs: number, signal: AbortSignal): Promise<void>;
  terminateTree(pid: number): Promise<void>;
  findFreePort(hostname: string): Promise<number>;
  now(): number;
  env(): Record<string, string>;
}

/** Idle time after the last release before an unreferenced server is closed. */
export const OPENCODE_POOL_IDLE_TTL_MS = 5 * 60 * 1_000;
/** Longest wait for a fresh serve to answer health before startup fails. */
export const OPENCODE_POOL_READY_TIMEOUT_MS = 20_000;

async function defaultWaitForHealth(baseUrl: string, timeoutMs: number, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let delay = 100;
  for (;;) {
    if (signal.aborted) throw new Error("OpenCode serve startup aborted");
    try {
      const res = await fetch(`${baseUrl}/global/health`);
      if (res.ok) return;
    } catch {
      // Not ready yet; keep polling below the deadline.
    }
    if (Date.now() >= deadline) throw new Error(`OpenCode serve did not become ready at ${baseUrl}`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, delay);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("OpenCode serve startup aborted"));
      }, { once: true });
    });
    delay = Math.min(delay * 2, 1_000);
  }
}

async function defaultFindFreePort(hostname: string): Promise<number> {
  const host = hostname === "0.0.0.0" ? "127.0.0.1" : hostname;
  return new Promise<number>((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

/**
 * Pools one `opencode serve` child per binary, working directory, and
 * hostname. Tracks reference counts, closes idle entries after the TTL,
 * watches for unexpected exits, and proves process-tree termination on close.
 */
export class OpenCodeServerPool {
  private readonly entries = new Map<string, OpenCodePoolEntry>();
  private readonly children = new Map<string, OpenCodePoolProcess>();
  private readonly pending = new Map<string, Promise<OpenCodePoolEntry>>();
  private evictionTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: OpenCodePoolDeps) {}

  static withDefaults(deps: Pick<OpenCodePoolDeps, "terminateTree"> & { platform: string } & Partial<Omit<OpenCodePoolDeps, "terminateTree">>): OpenCodeServerPool {
    const { platform, ...rest } = deps;
    return new OpenCodeServerPool({
      spawn: (binaryPath, args, cwd, env) => NodeChildProcess.spawn(binaryPath, args, {
        cwd,
        env: { ...env },
        stdio: "ignore",
        windowsHide: true,
        // On Windows the executable is a `.cmd` shim; only a shell resolves it.
        ...(platform === "win32" ? { shell: true } : {}),
      }),
      waitForHealth: defaultWaitForHealth,
      findFreePort: defaultFindFreePort,
      now: () => Date.now(),
      env: () => ({ ...process.env }) as Record<string, string>,
      ...rest,
    });
  }

  get size(): number {
    return this.entries.size;
  }

  entryFor(key: OpenCodePoolKey): OpenCodePoolEntry | undefined {
    return this.entries.get(openCodePoolKeyText(key));
  }

  /** Acquire (or spawn) the server for one working directory. Shares across threads. */
  async acquire(key: OpenCodePoolKey): Promise<OpenCodePoolEntry> {
    this.ensureEvictionTimer();
    const text = openCodePoolKeyText(key);
    const existing = this.entries.get(text);
    if (existing) {
      existing.refs += 1;
      existing.lastUsedAt = this.deps.now();
      return existing;
    }
    const inFlight = this.pending.get(text);
    if (inFlight) {
      const entry = await inFlight;
      entry.refs += 1;
      entry.lastUsedAt = this.deps.now();
      return entry;
    }
    const started = this.start(key);
    this.pending.set(text, started);
    try {
      const entry = await started;
      entry.refs += 1;
      entry.lastUsedAt = this.deps.now();
      return entry;
    } finally {
      this.pending.delete(text);
    }
  }

  /** Release one reference; the entry stays warm until the TTL or shutdown. */
  release(key: OpenCodePoolKey): void {
    const text = openCodePoolKeyText(key);
    const entry = this.entries.get(text);
    if (!entry) return;
    entry.refs = Math.max(0, entry.refs - 1);
    entry.lastUsedAt = this.deps.now();
  }

  /** Close one entry with proven tree termination, regardless of ref count. */
  async close(key: OpenCodePoolKey): Promise<void> {
    const text = openCodePoolKeyText(key);
    const entry = this.entries.get(text);
    if (!entry) return;
    this.entries.delete(text);
    const child = this.children.get(text);
    this.children.delete(text);
    await this.terminateEntry(entry, child);
  }

  /** Close idle (refs at zero past TTL) entries with proven termination. */
  async closeIdle(now = this.deps.now(), ttlMs = OPENCODE_POOL_IDLE_TTL_MS): Promise<string[]> {
    const closed: string[] = [];
    for (const [text, entry] of this.entries) {
      if (entry.refs > 0) continue;
      if (now - entry.lastUsedAt <= ttlMs) continue;
      this.entries.delete(text);
      const child = this.children.get(text);
      this.children.delete(text);
      await this.terminateEntry(entry, child);
      closed.push(text);
    }
    return closed;
  }

  async shutdown(): Promise<void> {
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = null;
    }
    await Promise.all([...this.entries.keys()].map(async (text) => {
      const entry = this.entries.get(text);
      if (!entry) return;
      this.entries.delete(text);
      const child = this.children.get(text);
      this.children.delete(text);
      await this.terminateEntry(entry, child);
    }));
  }

  private async start(key: OpenCodePoolKey): Promise<OpenCodePoolEntry> {
    const port = await this.deps.findFreePort(key.hostname);
    const baseUrl = `http://${key.hostname}:${port}`;
    const child = this.deps.spawn(key.binaryPath, ["serve", "--port", String(port), "--hostname", key.hostname], key.cwd, this.deps.env());
    logger.info("OpenCode serve spawn", { binaryPath: key.binaryPath, cwd: key.cwd, port });
    const text = openCodePoolKeyText(key);
    const entry: OpenCodePoolEntry = {
      key, port, baseUrl, pid: child.pid ?? null, refs: 0, lastUsedAt: this.deps.now(), ready: false,
    };
    this.entries.set(text, entry);
    this.children.set(text, child);
    const onExit = () => {
      // Unexpected exits clean up without orphan processes; late waiters fail fast.
      if (this.entries.get(text) === entry) this.entries.delete(text);
      this.children.delete(text);
    };
    child.on("exit", onExit);
    const controller = new AbortController();
    const guard = setTimeout(() => controller.abort(), OPENCODE_POOL_READY_TIMEOUT_MS + 5_000);
    try {
      await this.awaitServeReady(child, baseUrl, controller.signal);
    } catch (error) {
      child.off("exit", onExit);
      this.entries.delete(text);
      this.children.delete(text);
      await this.terminateEntry(entry, child);
      throw error;
    } finally {
      clearTimeout(guard);
    }
    entry.ready = true;
    entry.lastUsedAt = this.deps.now();
    return entry;
  }

  /**
   * Wait for the serve health endpoint while also watching the child for an
   * early `error` (e.g. missing binary). Without the `error` listener a spawn
   * failure throws an unhandled event that crashes the server process.
   */
  private awaitServeReady(
    child: OpenCodePoolProcess,
    baseUrl: string,
    signal: AbortSignal,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        reject(new Error(`OpenCode serve failed to start: ${error.message}`));
      };
      child.on("error", onError);
      this.deps.waitForHealth(baseUrl, OPENCODE_POOL_READY_TIMEOUT_MS, signal).then(
        () => {
          child.off("error", onError);
          resolve();
        },
        (error: unknown) => {
          child.off("error", onError);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  private async terminateEntry(entry: OpenCodePoolEntry, child: OpenCodePoolProcess | undefined): Promise<void> {
    // Proven tree termination goes first. A best-effort kill of the direct
    // child beforehand would orphan grandchildren on Windows (the tracked pid
    // is the shell wrapper), making the later snapshot-based verification
    // vacuously succeed while the real server keeps running.
    if (entry.pid != null) {
      try {
        await this.deps.terminateTree(entry.pid);
        return;
      } catch (error) {
        logger.warn("OpenCode serve tree termination failed; trying direct kill", {
          pid: entry.pid,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    try {
      child?.kill("SIGTERM");
    } catch {
      // Best effort; an exited process is not an orphan.
    }
  }

  private ensureEvictionTimer(): void {
    if (this.evictionTimer) return;
    this.evictionTimer = setInterval(() => void this.closeIdle(), 60_000);
    this.evictionTimer.unref?.();
  }
}
