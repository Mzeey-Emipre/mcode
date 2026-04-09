/**
 * Utility process lifecycle manager for the Mcode server.
 * Spawns the server as an Electron utilityProcess, polls for readiness,
 * and provides restart/shutdown capabilities.
 *
 * Uses utilityProcess instead of child_process.fork to enable
 * MessagePort transfer for direct renderer streaming.
 */

import { app, utilityProcess, type UtilityProcess, MessageChannelMain } from "electron";
import { existsSync, readFileSync } from "fs";
import { createServer, type AddressInfo } from "net";
import { randomUUID } from "crypto";
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
 * the server utility process can find it outside the asar archive.
 */
function getServerPaths(): {
  entry: string;
  cwd: string;
  nativeBindingPath?: string;
} {
  if (app.isPackaged) {
    // The server bundle and native deps are asarUnpack'd to real filesystem
    // paths. utilityProcess.fork() needs a real entry path and cwd - it does
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
}

/**
 * Check if an existing server is running by reading the lock file and
 * probing its health endpoint. Returns the lock info if healthy, null otherwise.
 */
async function tryExistingServer(): Promise<ServerLock | null> {
  try {
    const raw = readFileSync(lockFilePath(), "utf-8");
    const lock: ServerLock = JSON.parse(raw);

    // Validate the lock file has the expected shape
    if (typeof lock.port !== "number" || typeof lock.authToken !== "string" || !lock.port) {
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
 * Manages the lifecycle of the Mcode server utility process.
 * Handles spawning, health-check polling, restart, and shutdown.
 * Supports MessagePort transfer for direct streaming to renderer.
 *
 * If another server instance is already running (detected via lock file),
 * reuses it instead of spawning a new one to avoid SQLite lock contention.
 */
export class ServerManager {
  private serverProcess: UtilityProcess | null = null;
  private _port = 0;
  private _authToken = "";
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

  /**
   * Start the server. If another instance is already running (lock file),
   * reuses it. Otherwise spawns a new utility process.
   * Returns the assigned port and auth token.
   */
  async start(): Promise<{ port: number; authToken: string }> {
    // Check for an existing server before spawning a new one.
    // Avoids SQLite lock contention when multiple Electron instances
    // (dev, source-prod, packaged) share the same data directory.
    const existing = await tryExistingServer();
    if (existing) {
      this._port = existing.port;
      this._authToken = existing.authToken;
      this._reusedExisting = true;
      return { port: this._port, authToken: this._authToken };
    }

    this._port = await findAvailablePort(PORT_MIN, PORT_MAX);
    this._authToken = randomUUID();

    const heapMb = readServerHeapMb();
    console.log(`Starting server with --max-old-space-size=${heapMb}`);

    const { entry, cwd, nativeBindingPath } = getServerPaths();

    // V8 flags are processed at engine level before JS runs, so they work
    // in utilityProcess. Module loader flags (--import) do NOT work here;
    // tsx registration is handled by the entry.mjs bootstrap instead.
    const child = utilityProcess.fork(entry, [], {
      cwd,
      execArgv: [
        `--max-old-space-size=${heapMb}`,
        "--max-semi-space-size=2",
        "--expose-gc",
      ],
      env: {
        ...process.env,
        MCODE_PORT: String(this._port),
        MCODE_AUTH_TOKEN: this._authToken,
        MCODE_MODE: "desktop",
        MCODE_DATA_DIR: getMcodeDir(),
        MCODE_TEMP_DIR: app.getPath("temp"),
        MCODE_VERSION: app.getVersion(),
        ...(nativeBindingPath ? { BETTER_SQLITE3_BINDING: nativeBindingPath } : {}),
      },
      stdio: "pipe",
    });
    this.serverProcess = child;

    // Forward server stdout/stderr to the main process console
    child.stdout?.on("data", (data: Buffer) => {
      process.stdout.write(`[server] ${data.toString()}`);
    });
    child.stderr?.on("data", (data: Buffer) => {
      process.stderr.write(`[server] ${data.toString()}`);
    });

    child.on("exit", (code) => {
      console.error(`Server process exited with code ${code}`);
      if (this.serverProcess === child) {
        this.serverProcess = null;
        this.onUnexpectedExit?.(code);
      }
    });

    await this.waitForReady(10_000);
    return { port: this._port, authToken: this._authToken };
  }

  /**
   * Kill the current server and start a fresh one.
   * Waits for the old process to fully terminate before spawning.
   */
  async restart(): Promise<void> {
    this.shutdown();
    // Allow a brief window for the OS to reclaim the port
    await new Promise((r) => setTimeout(r, 500));
    await this.start();
  }

  /**
   * Create a MessagePort pair and send one end to the server utility process.
   * Returns the renderer-facing port for forwarding to the BrowserWindow.
   * Not available when reusing an external server (no utility process to message).
   */
  createStreamPort(): Electron.MessagePortMain {
    if (!this.serverProcess) {
      throw new Error("Cannot create stream port: server not running");
    }
    const { port1, port2 } = new MessageChannelMain();
    this.serverProcess.postMessage({ type: "stream-port" }, [port2]);
    return port1;
  }

  /**
   * Gracefully terminate the server process.
   * No-op when reusing an external server (we don't own it).
   * Sends kill() and retries after 5 seconds if the process has not exited.
   * utilityProcess.kill() does not accept signal arguments.
   */
  shutdown(): void {
    if (this._reusedExisting) return;
    if (!this.serverProcess) return;

    const proc = this.serverProcess;
    this.serverProcess = null;

    proc.kill();
    const forceKill = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        // Already dead
      }
    }, 5000);

    proc.once("exit", () => clearTimeout(forceKill));
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
