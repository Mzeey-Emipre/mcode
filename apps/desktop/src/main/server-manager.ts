/**
 * Child process lifecycle manager for the Mcode server.
 * Spawns the server as a detached child process, polls for readiness,
 * and provides restart/shutdown capabilities.
 *
 * Uses detached child_process.spawn so the server outlives Electron
 * and manages its own lifecycle via the grace period.
 */

import { app } from "electron";
import {
  execFileSync,
  execSync,
  spawn,
  type ChildProcess,
} from "child_process";
import { createRequire } from "module";
import {
  createWriteStream,
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { readFile } from "fs/promises";
import { createServer, type AddressInfo } from "net";
import { Buffer } from "node:buffer";
import { resolve, join, dirname } from "path";
import { getMcodeDir } from "@mcode/shared";
import {
  SettingsSchema as BundledSettingsSchema,
  SERVER_HEAP_DEFAULT_MB,
  SERVER_HEAP_MAX_MB,
  SERVER_HEAP_MIN_MB,
} from "@mcode/contracts";
import { resolveServerBinary } from "./server-binary-resolver.js";
import { isDesktopDev } from "./is-desktop-dev.js";

/** Use snapshot-provided schema when available (V8 snapshot pre-initializes Zod). */
const SettingsSchema =
  globalThis.__v8Snapshot?.contracts?.SettingsSchema ?? BundledSettingsSchema;

/**
 * Resolve the server entry point and working directory based on whether the
 * app is packaged or running from source. Packaged and dev both run the same
 * bundled CJS entry (`dist/server/server.cjs`); dev builds it via
 * `apps/desktop/scripts/dev-electron.mjs` (tsc → esbuild watch).
 *
 * Returns the approved better-sqlite3 binding for every server child.
 */
function getServerPaths(): {
  entry: string;
  cwd: string;
  nativeBindingPath: string;
} {
  if (app.isPackaged) {
    // The server bundle and native deps are asarUnpack'd to real filesystem
    // paths. child_process.spawn() needs a real entry path and cwd - it does
    // not go through Electron's asar virtual filesystem layer.
    const unpackedRoot = resolve(process.resourcesPath, "app.asar.unpacked");
    const serverBundle = resolve(unpackedRoot, "dist", "server", "server.cjs");
    const nativeBindingPath = resolve(
      unpackedRoot,
      "node_modules",
      "better-sqlite3",
      "build",
      "Release",
      "better_sqlite3.node",
    );
    if (!existsSync(nativeBindingPath)) {
      throw new Error(
        `Packaged better-sqlite3 binding not found: ${nativeBindingPath}`,
      );
    }
    return {
      entry: serverBundle,
      cwd: dirname(serverBundle),
      nativeBindingPath,
    };
  }

  /** Matches both `src/main/` (Vitest) and bundled `dist/main/` (`__dirname`). */
  const serverBundle = resolve(
    __dirname,
    "..",
    "..",
    "dist",
    "server",
    "server.cjs",
  );
  const desktopRequire = createRequire(
    resolve(__dirname, "..", "..", "package.json"),
  );
  const betterSqliteDir = dirname(
    desktopRequire.resolve("better-sqlite3/package.json"),
  );
  const nativeBindingPath = resolve(
    betterSqliteDir,
    "build",
    "Release",
    "better_sqlite3.electron.node",
  );
  if (!existsSync(nativeBindingPath)) {
    throw new Error(
      `Workspace Electron better-sqlite3 binding not found: ${nativeBindingPath}`,
    );
  }
  return { entry: serverBundle, cwd: dirname(serverBundle), nativeBindingPath };
}

/**
 * Port range to scan for an available port.
 * Three tiers prevent clashes when multiple instances coexist:
 *  - Dev mode  (ELECTRON_RENDERER_URL set): 19500-19599
 *  - Source prod (from source, not packaged):  19600-19699
 *  - Packaged installed app (app.isPackaged):  19700-19799
 * The standalone server defaults to 19400 via MCODE_PORT.
 */
const PORT_MIN = app.isPackaged ? 19700 : isDesktopDev() ? 19500 : 19600;
const PORT_MAX = app.isPackaged ? 19800 : isDesktopDev() ? 19600 : 19700;

/** Interval (ms) between health-check polls during startup. */
const HEALTH_POLL_INTERVAL = 200;

/**
 * Maximum time (ms) to wait for the server's /health endpoint.
 * Cold starts include DB migrations, workspace enumeration, git watcher init,
 * and IPC socket binding - all before httpServer.listen() runs. 30 seconds
 * accommodates slow disks and large workspace counts.
 */
const STARTUP_TIMEOUT_MS = 30_000;

/** Server stderr log file path. Rotated on each spawn to keep size bounded. */
const SERVER_LOG_PATH = join(getMcodeDir(), "server-stderr.log");
/** Previous server stderr log retained across one respawn for crash diagnostics. */
const SERVER_ROTATED_LOG_PATH = join(getMcodeDir(), "server-stderr.1.log");

/** Maximum UTF-8 bytes forwarded from one packaged server stderr chunk. */
export const PACKAGED_SERVER_STDERR_FORWARD_MAX_BYTES = 8_192;

/** Forwards one bounded release-test server stderr chunk to the parent writer. */
export function forwardReleaseTestServerStderr(
  chunk: string | Uint8Array,
  write: (text: string) => void = (text) => {
    process.stderr.write(text);
  },
): void {
  const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
  const bytes = Buffer.from(text, "utf8");
  write(
    bytes.byteLength <= PACKAGED_SERVER_STDERR_FORWARD_MAX_BYTES
      ? text
      : bytes.subarray(0, PACKAGED_SERVER_STDERR_FORWARD_MAX_BYTES).toString("utf8"),
  );
}

/** Rotate the previous packaged-server stderr log before opening a fresh one. */
function rotateServerLog(): void {
  if (!existsSync(SERVER_LOG_PATH)) return;
  try {
    if (existsSync(SERVER_ROTATED_LOG_PATH)) {
      unlinkSync(SERVER_ROTATED_LOG_PATH);
    }
    renameSync(SERVER_LOG_PATH, SERVER_ROTATED_LOG_PATH);
  } catch (err) {
    console.warn(
      "[server-manager] Failed to rotate previous server stderr log",
      err,
    );
  }
}

/**
 * Determine the V8 max old space size for the server process.
 * Priority: MCODE_SERVER_HEAP_MB env var > settings.json > default.
 */
function readServerHeapMb(): number {
  // 1. Environment variable takes highest precedence
  const envVal = process.env.MCODE_SERVER_HEAP_MB;
  if (envVal !== undefined) {
    const parsed = Number(envVal);
    if (
      Number.isInteger(parsed) &&
      parsed >= SERVER_HEAP_MIN_MB &&
      parsed <= SERVER_HEAP_MAX_MB
    ) {
      return parsed;
    }
    console.warn(
      `[server-manager] MCODE_SERVER_HEAP_MB="${envVal}" is invalid ` +
        `(parsed: ${parsed}, allowed: ${SERVER_HEAP_MIN_MB}-${SERVER_HEAP_MAX_MB} integer). ` +
        "Falling through to settings.json.",
    );
  }

  // 2. Read from settings.json via the Zod schema
  try {
    const raw = readFileSync(join(getMcodeDir(), "settings.json"), "utf-8");
    const result = SettingsSchema().safeParse(JSON.parse(raw));
    if (result.success) {
      return result.data.server.memory.heapMb;
    }
    console.warn(
      "[server-manager] settings.json parse failed, using default heap",
    );
  } catch {
    // File missing or unreadable, fall through to default
  }

  return SERVER_HEAP_DEFAULT_MB;
}

/**
 * Find an available TCP port in the given range.
 * Creates a temporary server, lets the OS confirm the port is free,
 * then immediately closes it.
 */
async function findAvailablePort(min: number, max: number): Promise<number> {
  for (let port = min; port < max; port++) {
    const available = await new Promise<boolean>((resolve) => {
      const srv = createServer();
      srv.once("error", () => resolve(false));
      srv.listen(port, "127.0.0.1", () => {
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

/** Terminate a server and all provider subprocesses that it owns. */
function forceKillServerProcessTree(pid: number): void {
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/T", "/F", "/PID", String(pid)], {
        stdio: "ignore",
        timeout: 5_000,
      });
      return;
    }
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    const message =
      error instanceof Error ? error.message : String(error ?? "");
    if (code === "ESRCH" || message.includes("ESRCH")) return;
    throw error;
  }
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

interface OwnedServerIdentity {
  pid: number;
  startedAt: string;
  authToken: string;
}

function isServerLock(value: unknown): value is ServerLock {
  if (!value || typeof value !== "object") return false;
  const lock = value as Partial<ServerLock>;
  const pid = lock.pid;
  return (
    typeof lock.port === "number" &&
    Number.isFinite(lock.port) &&
    typeof lock.authToken === "string" &&
    typeof pid === "number" &&
    Number.isSafeInteger(pid) &&
    pid > 0 &&
    typeof lock.startedAt === "string" &&
    typeof lock.version === "string" &&
    typeof lock.ipcPath === "string"
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    const message =
      error instanceof Error ? error.message : String(error ?? "");
    return code !== "ESRCH" && !message.includes("ESRCH");
  }
}

/** Check whether a detached POSIX process group still exists. */
function isProcessGroupAlive(pid: number): boolean {
  if (process.platform === "win32") return isProcessAlive(pid);
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    const message =
      error instanceof Error ? error.message : String(error ?? "");
    return code !== "ESRCH" && !message.includes("ESRCH");
  }
}

function sameServerLockIdentity(left: ServerLock, right: ServerLock): boolean {
  return (
    left.port === right.port &&
    left.authToken === right.authToken &&
    left.pid === right.pid &&
    left.startedAt === right.startedAt &&
    left.version === right.version &&
    left.ipcPath === right.ipcPath
  );
}

function sameOwnedServerIdentity(
  lock: ServerLock,
  identity: OwnedServerIdentity,
): boolean {
  return (
    lock.pid === identity.pid &&
    lock.startedAt === identity.startedAt &&
    lock.authToken === identity.authToken
  );
}

/**
 * Check if an existing server is running by reading the lock file and
 * probing its health endpoint. Returns the lock info if healthy, null otherwise.
 */
async function tryExistingServer(
  portMin: number,
  portMax: number,
): Promise<ServerLock | null> {
  const lockPath = lockFilePath();
  try {
    const raw = readFileSync(lockPath, "utf-8");
    const lock: ServerLock = JSON.parse(raw);

    // Validate the lock file has the expected shape
    if (
      typeof lock.port !== "number" ||
      typeof lock.authToken !== "string" ||
      !lock.port
    ) {
      return null;
    }

    // Only reuse a server whose port falls within this mode's range.
    // Prevents dev instances from hijacking a packaged-app server (or vice versa).
    if (lock.port < portMin || lock.port >= portMax) {
      console.log(
        `[server-manager] Ignored existing server on port ${lock.port} (outside ${portMin}-${portMax})`,
      );
      return null;
    }
    if (!Number.isSafeInteger(lock.pid) || lock.pid <= 0) {
      console.log(
        `[server-manager] Ignored existing server with invalid PID ${lock.pid}`,
      );
      return null;
    }

    // Check PID liveness before wasting time on HTTP probe
    try {
      process.kill(lock.pid, 0); // throws if process doesn't exist
    } catch {
      console.log(
        `[server-manager] Stale lock file: PID ${lock.pid} not alive`,
      );
      try {
        unlinkSync(lockPath);
      } catch {
        /* ok */
      }
      return null;
    }

    // Probe the health endpoint to confirm the server is alive
    const res = await fetch(`http://localhost:${lock.port}/health`);
    if (res.ok) {
      console.log(
        `[server-manager] Found existing server on port ${lock.port} (pid ${lock.pid})`,
      );
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
  private ownedServerIdentity: OwnedServerIdentity | null = null;
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
        console.log(
          `[server-manager] Version mismatch: running=${existing.version}, expected=${app.getVersion()}, replacing`,
        );
        await this.forceReplace();
        // Fall through to spawn new server
      } else {
        const ownsExistingServer =
          this.ownedServerIdentity !== null &&
          sameOwnedServerIdentity(existing, this.ownedServerIdentity);
        if (!ownsExistingServer) this.ownedServerIdentity = null;
        this._port = existing.port;
        this._authToken = existing.authToken;
        this._ipcPath = existing.ipcPath ?? "";
        this._reusedExisting = !ownsExistingServer;
        return { port: this._port, authToken: this._authToken };
      }
    }

    const sentinelPath = join(getMcodeDir(), "server.starting");

    // Acquire startup lock to prevent duplicate server spawns
    try {
      writeFileSync(sentinelPath, String(process.pid), { flag: "wx" });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        console.log(
          "[server-manager] Startup lock held by another process, waiting for server",
        );
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 200));
          const existingNow = await tryExistingServer(PORT_MIN, PORT_MAX);
          if (existingNow) {
            const ownsExistingServer =
              this.ownedServerIdentity !== null &&
              sameOwnedServerIdentity(existingNow, this.ownedServerIdentity);
            if (!ownsExistingServer) this.ownedServerIdentity = null;
            this._port = existingNow.port;
            this._authToken = existingNow.authToken;
            this._ipcPath = existingNow.ipcPath ?? "";
            this._reusedExisting = !ownsExistingServer;
            return { port: this._port, authToken: this._authToken };
          }
        }
        // Timeout: other spawner may have crashed. Re-acquire the lock before spawning.
        try {
          writeFileSync(sentinelPath, String(process.pid), { flag: "wx" });
        } catch {
          // Another process grabbed it first - retry the whole start flow
          try {
            unlinkSync(sentinelPath);
          } catch {
            /* ok */
          }
        }
      }
    }

    try {
      // Port pinning: prefer the previous port if lock file exists
      let preferredPort: number | null = null;
      const lockPath = lockFilePath();
      if (existsSync(lockPath)) {
        try {
          const oldLock: ServerLock = JSON.parse(
            readFileSync(lockPath, "utf-8"),
          );
          if (oldLock.port >= PORT_MIN && oldLock.port < PORT_MAX) {
            preferredPort = oldLock.port;
          }
        } catch {
          /* corrupt lock, ignore */
        }
      }

      this._port = preferredPort
        ? await findAvailablePort(preferredPort, preferredPort + 1).catch(() =>
            findAvailablePort(PORT_MIN, PORT_MAX),
          )
        : await findAvailablePort(PORT_MIN, PORT_MAX);

      const heapMb = readServerHeapMb();
      console.log(
        `[server-manager] Server configured: --max-old-space-size=${heapMb}`,
      );

      const { entry, cwd, nativeBindingPath } = getServerPaths();

      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        // Run the Electron binary as a plain Node.js process so the server
        // script executes without launching another Electron window.
        ELECTRON_RUN_AS_NODE: "1",
        MCODE_PORT: String(this._port),
        MCODE_MODE: "desktop",
        MCODE_SINGLE_INSTANCE: "false",
        MCODE_DATA_DIR: getMcodeDir(),
        MCODE_TEMP_DIR: app.getPath("temp"),
        MCODE_VERSION: app.getVersion(),
      };

      if (isDesktopDev() && !process.env.MCODE_GIT_BRANCH) {
        try {
          const branch = execSync("git rev-parse --abbrev-ref HEAD", {
            encoding: "utf-8",
            timeout: 3000,
            cwd,
          }).trim();
          if (branch && branch !== "HEAD") {
            env.MCODE_GIT_BRANCH = branch;
          }
        } catch {
          // Not a git repo or git unavailable; shared mcode.db
        }
      } else if (process.env.MCODE_GIT_BRANCH) {
        env.MCODE_GIT_BRANCH = process.env.MCODE_GIT_BRANCH;
      }

      if (isDesktopDev() && !process.env.MCODE_GIT_TOPLEVEL) {
        try {
          const top = execSync("git rev-parse --show-toplevel", {
            encoding: "utf-8",
            timeout: 3000,
            cwd,
          }).trim();
          if (top) {
            env.MCODE_GIT_TOPLEVEL = top;
          }
        } catch {
          // Not a git repo or git unavailable
        }
      } else if (process.env.MCODE_GIT_TOPLEVEL) {
        env.MCODE_GIT_TOPLEVEL = process.env.MCODE_GIT_TOPLEVEL;
      }

      env.BETTER_SQLITE3_BINDING = nativeBindingPath;
      if (app.isPackaged) {
        env.MCODE_PACKAGED_RESOURCES_ROOT = process.resourcesPath;
      }

      // The renamed server binary lives in resources/bin/ which lacks Electron's
      // shared libraries (libffmpeg.so). Point LD_LIBRARY_PATH at the original
      // Electron binary directory so the dynamic linker finds them.
      if (process.platform === "linux" && app.isPackaged) {
        const electronDir = dirname(process.execPath);
        env.LD_LIBRARY_PATH = [electronDir, process.env.LD_LIBRARY_PATH]
          .filter(Boolean)
          .join(":");
      }

      // V8 flags go in the args array for child_process.spawn.
      const v8Flags = [
        `--max-old-space-size=${heapMb}`,
        "--max-semi-space-size=2",
        "--expose-gc",
      ];
      if (app.isPackaged) {
        v8Flags.push(
          "--report-on-fatalerror",
          `--report-directory=${getMcodeDir()}`,
          "--heapsnapshot-near-heap-limit=1",
        );
      }
      const args = [...v8Flags, entry];

      // In production, route stderr to a log file so crashes are diagnosable.
      // Dev mode inherits stdio for immediate console visibility.
      if (!isDesktopDev()) {
        rotateServerLog();
      }
      const stderrStream = isDesktopDev()
        ? undefined
        : createWriteStream(SERVER_LOG_PATH, { flags: "w" });
      const releaseTestStderrForwardingEnabled =
        app.isPackaged && process.env.MCODE_TERMINAL_RELEASE_TEST === "1";

      // The renamed binary is a copy of the Electron binary, so ELECTRON_RUN_AS_NODE=1 is still required.
      const serverBinary = resolveServerBinary({
        isPackaged: app.isPackaged,
        execPath: process.execPath,
        resourcesPath: process.resourcesPath,
        platform: process.platform,
        // Unsigned macOS packages cannot run the renamed copy through library validation.
        ...(app.isPackaged &&
        process.platform === "darwin" &&
        process.env.MCODE_TERMINAL_RELEASE_TEST === "1"
          ? { preferMainBinary: true }
          : {}),
      });

      let child;
      try {
        child = spawn(serverBinary, args, {
          cwd,
          env,
          detached: true,
          stdio: isDesktopDev()
            ? "inherit"
            : ["ignore", "ignore", stderrStream ? "pipe" : "ignore"],
        });
      } catch (err) {
        stderrStream?.destroy();
        throw err;
      }
      child.unref();
      this.serverProcess = child;

      // Pipe stderr to the log file when running packaged
      if (!isDesktopDev() && stderrStream && child.stderr) {
        child.stderr.pipe(stderrStream);
        if (releaseTestStderrForwardingEnabled) {
          child.stderr.on("data", (chunk: string | Uint8Array) =>
            forwardReleaseTestServerStderr(chunk),
          );
        }
      }

      child.on("exit", (code) => {
        console.error(`Server process exited with code ${code}`);
        stderrStream?.end();
        if (this.serverProcess === child) {
          this.serverProcess = null;
          this.onUnexpectedExit?.(code);
        }
      });

      await this.waitForReady(STARTUP_TIMEOUT_MS);

      // Read auth token from lock file (server writes it on startup).
      // Retry briefly in case the lock file write races the health endpoint.
      this._authToken = await this.readAuthTokenFromLock();

      return { port: this._port, authToken: this._authToken };
    } finally {
      // Release startup lock whether spawn succeeded or failed
      try {
        unlinkSync(sentinelPath);
      } catch {
        /* ok */
      }
    }
  }

  /**
   * Probe the server's /health endpoint once. Used by the self-healing
   * resume path to decide whether a silent restart is needed; a short
   * timeout keeps the post-sleep check from hanging on a dead socket.
   */
  async isHealthy(): Promise<boolean> {
    if (!this._port) return false;
    try {
      const res = await fetch(`http://localhost:${this._port}/health`, {
        signal: AbortSignal.timeout(3_000),
      });
      return res.ok;
    } catch {
      return false;
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
   * Gracefully tear down whoever holds {@link lockFilePath} for this app's port
   * band (either our detached child or a reused instance), release native file
   * locks before the NSIS updater replaces binaries.
   */
  async stopServerHeldByLock(): Promise<void> {
    const lockPath = lockFilePath();
    if (!existsSync(lockPath)) {
      this.ownedServerIdentity = null;
      return;
    }

    let parsedLock: unknown;
    try {
      parsedLock = JSON.parse(readFileSync(lockPath, "utf-8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT")
        return;
      throw new Error(`Unable to read server lock file ${lockPath}`, {
        cause: error,
      });
    }

    // Validate lock port before any probe or process action. Foreign port bands
    // belong to another desktop mode and must remain untouched.
    const parsedPort =
      typeof parsedLock === "object" && parsedLock !== null
        ? (parsedLock as { port?: unknown }).port
        : undefined;
    if (
      typeof parsedPort === "number" &&
      Number.isFinite(parsedPort) &&
      (parsedPort < PORT_MIN || parsedPort >= PORT_MAX)
    ) {
      return;
    }

    if (!isServerLock(parsedLock)) {
      throw new Error(`Invalid server lock file ${lockPath}`);
    }
    const lock = parsedLock;

    const ownedIdentity = this.ownedServerIdentity;
    if (ownedIdentity && !sameOwnedServerIdentity(lock, ownedIdentity)) {
      this.ownedServerIdentity = null;
      return;
    }

    const ownsServerProcess = ownedIdentity !== null;

    try {
      await fetch(`http://localhost:${lock.port}/shutdown`, {
        method: "POST",
        signal: AbortSignal.timeout(5_000),
        headers: {
          Authorization: `Bearer ${lock.authToken}`,
          "X-Mcode-Shutdown-Reason": "desktop-update-exit",
        },
      });
    } catch {
      /* server may already be down or hung */
    }

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (!isProcessAlive(lock.pid) && !isProcessGroupAlive(lock.pid)) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    const processAlive = isProcessAlive(lock.pid);
    const processGroupAlive = isProcessGroupAlive(lock.pid);

    if (processAlive || processGroupAlive) {
      if (!ownsServerProcess) {
        throw new Error(
          `Server process ${lock.pid} still running after graceful shutdown; refusing to terminate unrelated process`,
        );
      }
      let currentLock: unknown;
      try {
        currentLock = JSON.parse(readFileSync(lockPath, "utf-8"));
      } catch {
        return;
      }
      if (
        !isServerLock(currentLock) ||
        (ownedIdentity && !sameOwnedServerIdentity(currentLock, ownedIdentity))
      ) {
        this.ownedServerIdentity = null;
        return;
      }
      try {
        forceKillServerProcessTree(lock.pid);
      } catch (error) {
        throw new Error(`Failed to terminate server process tree ${lock.pid}`, {
          cause: error,
        });
      }

      if (process.platform !== "win32") {
        const forceKillDeadline = Date.now() + 10_000;
        while (
          Date.now() < forceKillDeadline &&
          isProcessGroupAlive(lock.pid)
        ) {
          await new Promise((r) => setTimeout(r, 200));
        }
        if (isProcessGroupAlive(lock.pid)) {
          throw new Error(
            `Server process tree ${lock.pid} still running after termination`,
          );
        }
      }
    }

    try {
      const currentLock = JSON.parse(readFileSync(lockPath, "utf-8"));
      if (!isServerLock(currentLock) || !sameServerLockIdentity(lock, currentLock)) {
        this.ownedServerIdentity = null;
        return;
      }
    } catch {
      return;
    }

    try {
      unlinkSync(lockPath);
    } catch {
      /* ok */
    }
    this.ownedServerIdentity = null;
  }

  /**
   * Force-stop the server for version replacement before spawning anew.
   * Delegates to {@link stopServerHeldByLock}.
   */
  async forceReplace(): Promise<void> {
    await this.stopServerHeldByLock();
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
        const raw = await readFile(lockFilePath(), "utf-8");
        const lock: unknown = JSON.parse(raw);
        if (isServerLock(lock) && lock.authToken) {
          this._ipcPath = lock.ipcPath ?? "";
          if (this.serverProcess?.pid === lock.pid) {
            this.ownedServerIdentity = {
              pid: lock.pid,
              startedAt: lock.startedAt,
              authToken: lock.authToken,
            };
          }
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
   * Poll the server's /health endpoint until it responds 200,
   * the timeout expires, or the child process exits early.
   */
  private async waitForReady(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      // Fail fast if the server process already exited (crash, missing native
      // module, etc.) instead of polling for the full timeout duration.
      if (!this.serverProcess) {
        const logExcerpt = this.readServerLogTail();
        throw new Error(
          "Server process exited before becoming ready." +
            (logExcerpt
              ? `\n\nServer log:\n${logExcerpt}`
              : "\nNo server log available."),
        );
      }

      try {
        const res = await fetch(`http://localhost:${this._port}/health`);
        if (res.ok) return;
      } catch {
        // Server not ready yet
      }
      await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL));
    }

    const logExcerpt = this.readServerLogTail();
    throw new Error(
      `Server did not become ready within ${timeoutMs / 1000}s on port ${this._port}.` +
        (logExcerpt ? `\n\nServer log:\n${logExcerpt}` : ""),
    );
  }

  /** Read the last ~40 lines of the server stderr log for diagnostics. */
  private readServerLogTail(): string {
    try {
      if (!existsSync(SERVER_LOG_PATH)) return "";
      const content = readFileSync(SERVER_LOG_PATH, "utf-8");
      const lines = content.split("\n");
      return lines.slice(-40).join("\n").trim();
    } catch {
      return "";
    }
  }
}
