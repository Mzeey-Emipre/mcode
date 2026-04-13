/**
 * Child process lifecycle manager for the Mcode server.
 * Spawns the server as a detached child process, polls for readiness,
 * and provides restart/shutdown capabilities.
 *
 * Uses detached child_process.spawn so the server outlives Electron
 * and manages its own lifecycle via the grace period.
 */

import { app } from "electron";
import { spawn, type ChildProcess } from "child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { createServer, type AddressInfo } from "net";
import { resolve, join, dirname } from "path";
import { getMcodeDir } from "@mcode/shared";
import { SettingsSchema as BundledSettingsSchema } from "@mcode/contracts";

/** Use snapshot-provided schema when available (V8 snapshot pre-initializes Zod). */
const SettingsSchema = globalThis.__v8Snapshot?.contracts?.SettingsSchema ?? BundledSettingsSchema;

/**
 * Resolve the server entry point and working directory based on whether the
 * app is packaged or running from source. In packaged mode, the server is a
 * single CJS bundle at `dist/server/server.cjs`; in dev mode it uses the
 * tsx bootstrap at `src/entry.mjs`.
 *
 * Also returns the native binding path for better-sqlite3 when packaged so
 * the server child process can find it outside the asar archive.
 */
function getServerPaths(): {
  entry: string;
  cwd: string;
  nativeBindingPath?: string;
} {
  if (app.isPackaged) {
    // The server bundle and native deps are asarUnpack'd to real filesystem
    // paths. child_process.spawn() needs a real entry path and cwd - it does
    // not go through Electron's asar virtual filesystem layer.
    const unpackedRoot = resolve(process.resourcesPath, "app.asar.unpacked");
    const serverBundle = resolve(unpackedRoot, "dist", "server", "server.cjs");
    const nativeBindingPath = [
      resolve(unpackedRoot, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.electron.node"),
      resolve(unpackedRoot, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node"),
    ].find((candidate) => existsSync(candidate));
    return { entry: serverBundle, cwd: dirname(serverBundle), nativeBindingPath };
  }

  const serverDir = resolve(__dirname, "../../../server");
  return { entry: resolve(serverDir, "src/entry.mjs"), cwd: serverDir };
}

/**
 * Port range to scan for an available port.
 * Three tiers prevent clashes when multiple instances coexist:
 *  - Dev mode  (ELECTRON_RENDERER_URL set): 19500-19599
 *  - Source prod (from source, not packaged):  19600-19699
 *  - Packaged installed app (app.isPackaged):  19700-19799
 * The standalone server defaults to 19400 via MCODE_PORT.
 */
const isDev = !!process.env.ELECTRON_RENDERER_URL;
const PORT_MIN = app.isPackaged ? 19700 : isDev ? 19500 : 19600;
const PORT_MAX = app.isPackaged ? 19800 : isDev ? 19600 : 19700;

/** Interval (ms) between health-check polls during startup. */
const HEALTH_POLL_INTERVAL = 200;

/** Default V8 max old space size in MB. Tuned for the < 100MB idle target. */
const DEFAULT_HEAP_MB = 96;

/** Minimum allowed heap size in MB. */
const MIN_HEAP_MB = 64;

/** Maximum allowed heap size in MB. */
const MAX_HEAP_MB = 8192;

/**
 * Determine the V8 max old space size for the server process.
 * Priority: MCODE_SERVER_HEAP_MB env var > settings.json > default (96).
 */
function readServerHeapMb(): number {
  // 1. Environment variable takes highest precedence
  const envVal = process.env.MCODE_SERVER_HEAP_MB;
  if (envVal !== undefined) {
    const parsed = Number(envVal);
    if (Number.isInteger(parsed) && parsed >= MIN_HEAP_MB && parsed <= MAX_HEAP_MB) {
      return parsed;
    }
    console.warn(
      `[server-manager] MCODE_SERVER_HEAP_MB="${envVal}" is invalid ` +
        `(parsed: ${parsed}, allowed: ${MIN_HEAP_MB}-${MAX_HEAP_MB} integer). ` +
        `Falling back to default ${DEFAULT_HEAP_MB} MB.`,
    );
    return DEFAULT_HEAP_MB;
  }

  // 2. Read from settings.json via the Zod schema
  try {
    const raw = readFileSync(join(getMcodeDir(), "settings.json"), "utf-8");
    const result = SettingsSchema().safeParse(JSON.parse(raw));
    if (result.success) {
      return result.data.server.memory.heapMb;
    }
    console.warn("[server-manager] settings.json parse failed, using default heap");
  } catch {
    // File missing or unreadable, fall through to default
  }

  return DEFAULT_HEAP_MB;
}

/**
 * Find an available TCP port in the given range.
 * Creates a temporary server, lets the OS confirm the port is free,
 * then immediately closes it.
 */
async function findAvailablePort(min: number, max: number): Promise<number> {
  for (let port = min; port <= max; port++) {
    const available = await new Promise<boolean>((resolve) => {
      const srv = createServer();
      srv.once("error", () => resolve(false));
      srv.listen(port, () => {
        const addr = srv.address() as AddressInfo;
        srv.close(() => resolve(addr.port === port));
      });
    });
    if (available) return port;
  }
  throw new Error(`No available port found in range ${min}-${max}`);
}

/** Path to the server lock file for service discovery across instances. */
function lockFilePath(): string {
  return join(getMcodeDir(), "server.lock");
}

/** Lock file schema written by the server on startup. */
interface ServerLock {
  port: number;
  authToken: string;
  pid: number;
  startedAt: string;
  version: string;
  ipcPath: string;
}

/**
 * Check if an existing server is running by reading the lock file and
 * probing its health endpoint. Returns the lock info if healthy, null otherwise.
 */
async function tryExistingServer(portMin: number, portMax: number): Promise<ServerLock | null> {
  const lockPath = lockFilePath();
  try {
    const raw = readFileSync(lockPath, "utf-8");
    const lock: ServerLock = JSON.parse(raw);

    // Validate the lock file has the expected shape
    if (typeof lock.port !== "number" || typeof lock.authToken !== "string" || !lock.port) {
      return null;
    }

    // Only reuse a server whose port falls within this mode's range.
    // Prevents dev instances from hijacking a packaged-app server (or vice versa).
    if (lock.port < portMin || lock.port >= portMax) {
      console.log(`[server-manager] Ignored existing server on port ${lock.port} (outside ${portMin}-${portMax})`);
      return null;
    }

    // Check PID liveness before wasting time on HTTP probe
    try {
      process.kill(lock.pid, 0); // throws if process doesn't exist
    } catch {
      console.log(`[server-manager] Stale lock file: PID ${lock.pid} not alive`);
      try { unlinkSync(lockPath); } catch { /* ok */ }
      return null;
    }

    // Probe the health endpoint to confirm the server is alive
    const res = await fetch(`http://localhost:${lock.port}/health`);
    if (res.ok) {
      console.log(`[server-manager] Found existing server on port ${lock.port} (pid ${lock.pid})`);
      return lock;
    }
  } catch {
    // Lock file missing, unreadable, stale, or server unreachable
  }
  return null;
}

/**
 * Manages the lifecycle of the Mcode server child process.
 * Handles spawning, health-check polling, restart, and shutdown.
 *
 * If another server instance is already running (detected via lock file),
 * reuses it instead of spawning a new one to avoid SQLite lock contention.
 */
export class ServerManager {
  private serverProcess: ChildProcess | null = null;
  private _port = 0;
  private _authToken = "";
  private _ipcPath = "";
  private _reusedExisting = false;

  /**
   * Optional callback invoked when the server process exits unexpectedly
   * (i.e. not via {@link shutdown}). Receives the exit code (or null).
   */
  onUnexpectedExit: ((code: number | null) => void) | null = null;

  /** The port the server is listening on. */
  get port(): number {
    return this._port;
  }

  /** The auth token required to connect to the server. */
  get authToken(): string {
    return this._authToken;
  }

  /** Whether the server was reused from another Electron instance (no owned process). */
  get reusedExisting(): boolean {
    return this._reusedExisting;
  }

  /** IPC path for the server's fast-path push transport. */
  get ipcPath(): string {
    return this._ipcPath;
  }

  /**
   * Start the server. If another instance is already running (lock file),
   * reuses it. Otherwise spawns a new utility process.
   * Returns the assigned port and auth token.
   */
  async start(): Promise<{ port: number; authToken: string }> {
    // Check for an existing server before spawning a new one.
    // Avoids SQLite lock contention when multiple Electron instances
    // (dev, source-prod, packaged) share the same data directory.
    const existing = await tryExistingServer(PORT_MIN, PORT_MAX);
    if (existing) {
      if (existing.version && existing.version !== app.getVersion()) {
        console.log(`[server-manager] Version mismatch: running=${existing.version}, expected=${app.getVersion()}, replacing`);
        await this.forceReplace();
        // Fall through to spawn new server
      } else {
        this._port = existing.port;
        this._authToken = existing.authToken;
        this._ipcPath = existing.ipcPath ?? "";
        this._reusedExisting = true;
        return { port: this._port, authToken: this._authToken };
      }
    }

    const sentinelPath = join(getMcodeDir(), "server.starting");

    // Acquire startup lock to prevent duplicate server spawns
    try {
      writeFileSync(sentinelPath, String(process.pid), { flag: "wx" });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        console.log("[server-manager] Another process is starting the server, waiting...");
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 200));
          const existingNow = await tryExistingServer(PORT_MIN, PORT_MAX);
          if (existingNow) {
            this._port = existingNow.port;
            this._authToken = existingNow.authToken;
            this._ipcPath = existingNow.ipcPath ?? "";
            this._reusedExisting = true;
            return { port: this._port, authToken: this._authToken };
          }
        }
        // Timeout: other spawner may have crashed. Clean up and take over.
        try { unlinkSync(sentinelPath); } catch { /* ok */ }
      }
    }

    try {
      // Port pinning: prefer the previous port if lock file exists
      let preferredPort: number | null = null;
      const lockPath = lockFilePath();
      if (existsSync(lockPath)) {
        try {
          const oldLock: ServerLock = JSON.parse(readFileSync(lockPath, "utf-8"));
          if (oldLock.port >= PORT_MIN && oldLock.port < PORT_MAX) {
            preferredPort = oldLock.port;
          }
        } catch { /* corrupt lock, ignore */ }
      }

      this._port = preferredPort
        ? await findAvailablePort(preferredPort, preferredPort + 1).catch(() =>
            findAvailablePort(PORT_MIN, PORT_MAX),
          )
        : await findAvailablePort(PORT_MIN, PORT_MAX);

      const heapMb = readServerHeapMb();
      console.log(`Starting server with --max-old-space-size=${heapMb}`);

      const { entry, cwd, nativeBindingPath } = getServerPaths();

      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        MCODE_PORT: String(this._port),
        MCODE_MODE: "desktop",
        MCODE_DATA_DIR: getMcodeDir(),
        MCODE_TEMP_DIR: app.getPath("temp"),
        MCODE_VERSION: app.getVersion(),
      };

      if (nativeBindingPath) {
        env.BETTER_SQLITE3_BINDING = nativeBindingPath;
      }

      // V8 flags go in the args array for child_process.spawn.
      // Module loader flags (--import tsx) are supported here, unlike utilityProcess.
      const v8Flags = [`--max-old-space-size=${heapMb}`, "--max-semi-space-size=2", "--expose-gc"];
      const entryArgs = entry.endsWith(".mjs")
        ? ["--import", "tsx", entry]
        : [entry];
      const args = [...v8Flags, ...entryArgs];

      const child = spawn(process.execPath, args, {
        cwd,
        env,
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      this.serverProcess = child;

      child.on("exit", (code) => {
        console.error(`Server process exited with code ${code}`);
        if (this.serverProcess === child) {
          this.serverProcess = null;
          this.onUnexpectedExit?.(code);
        }
      });

      await this.waitForReady(10_000);

      // Read auth token from lock file (server writes it on startup).
      // Retry briefly in case the lock file write races the health endpoint.
      this._authToken = await this.readAuthTokenFromLock();

      return { port: this._port, authToken: this._authToken };
    } finally {
      // Release startup lock whether spawn succeeded or failed
      try { unlinkSync(sentinelPath); } catch { /* ok */ }
    }
  }

  /**
   * Force-replace the current server and start a fresh one.
   * Uses {@link forceReplace} to gracefully shut down the old server,
   * then waits briefly before spawning a new one.
   */
  async restart(): Promise<void> {
    if (!this._reusedExisting) {
      await this.forceReplace();
    }
    await new Promise((r) => setTimeout(r, 500));
    await this.start();
  }

  /**
   * Detach from the server process reference.
   * Intentional: the server outlives Electron and shuts itself down
   * via the grace-period timer when all sessions disconnect.
   */
  shutdown(): void {
    if (this._reusedExisting || !this.serverProcess) return;
    this.serverProcess = null;
  }

  /**
   * Force-stop the server for version replacement.
   * Sends POST /shutdown for graceful teardown, falls back to SIGKILL.
   */
  async forceReplace(): Promise<void> {
    const lockPath = lockFilePath();
    if (!existsSync(lockPath)) return;

    let lock: ServerLock;
    try {
      lock = JSON.parse(readFileSync(lockPath, "utf-8"));
    } catch {
      return;
    }

    // 1. Graceful HTTP shutdown
    try {
      await fetch(`http://localhost:${lock.port}/shutdown`, {
        method: "POST",
        headers: { Authorization: `Bearer ${lock.authToken}` },
      });
    } catch { /* server may already be down */ }

    // 2. Poll for exit (200ms intervals, 10s timeout)
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        process.kill(lock.pid, 0); // throws if dead
        await new Promise((r) => setTimeout(r, 200));
      } catch {
        break; // process exited
      }
    }

    // 3. Force kill if still alive
    try {
      process.kill(lock.pid, 0);
      process.kill(lock.pid, "SIGKILL");
    } catch { /* already dead */ }

    // 4. Clean up stale lock
    try { unlinkSync(lockPath); } catch { /* ok */ }
  }

  /**
   * Read the auth token from the server lock file with retry.
   * The lock file may not exist immediately after /health returns 200
   * if the write races the listen callback under heavy I/O.
   */
  private async readAuthTokenFromLock(): Promise<string> {
    const maxAttempts = 10;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const raw = readFileSync(lockFilePath(), "utf-8");
        const lock: ServerLock = JSON.parse(raw);
        if (lock.authToken) {
          this._ipcPath = lock.ipcPath ?? "";
          return lock.authToken;
        }
      } catch {
        // File not ready yet
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("Server lock file not available after health check passed");
  }

  /**
   * Poll the server's /health endpoint until it responds 200
   * or the timeout expires.
   */
  private async waitForReady(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://localhost:${this._port}/health`);
        if (res.ok) return;
      } catch {
        // Server not ready yet
      }
      await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL));
    }

    throw new Error(
      `Server did not become ready within ${timeoutMs}ms on port ${this._port}`,
    );
  }
}
