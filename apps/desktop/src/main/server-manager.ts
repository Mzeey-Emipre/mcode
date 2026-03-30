/**
 * Child process lifecycle manager for the Mcode server.
 * Spawns the server as a forked Node process, polls for readiness,
 * and provides restart/shutdown capabilities.
 */

import { fork, type ChildProcess } from "child_process";
import { readFileSync } from "fs";
import { createServer, type AddressInfo } from "net";
import { randomUUID } from "crypto";
import { resolve, join } from "path";
import { app } from "electron";
import { getMcodeDir } from "@mcode/shared";
import { SettingsSchema } from "@mcode/contracts";

/** Absolute path to the server package directory. */
const SERVER_DIR = resolve(__dirname, "../../../server");

/** Absolute path to the server entry point. */
const SERVER_ENTRY = resolve(SERVER_DIR, "src/index.ts");

/**
 * Port range to scan for an available port.
 * Dev mode (ELECTRON_RENDERER_URL set) uses 19500+ to avoid
 * colliding with a prod instance running on 19400.
 */
const isDev = !!process.env.ELECTRON_RENDERER_URL;
const PORT_MIN = isDev ? 19500 : 19400;
const PORT_MAX = isDev ? 19600 : 19500;

/** Interval (ms) between health-check polls during startup. */
const HEALTH_POLL_INTERVAL = 200;

/** Default V8 max old space size in MB. */
const DEFAULT_HEAP_MB = 512;

/** Minimum allowed heap size in MB. */
const MIN_HEAP_MB = 64;

/** Maximum allowed heap size in MB. */
const MAX_HEAP_MB = 8192;

/**
 * Determine the V8 max old space size for the server child process.
 * Priority: MCODE_SERVER_HEAP_MB env var > settings.json > default (512).
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
    const result = SettingsSchema.safeParse(JSON.parse(raw));
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

/**
 * Manages the lifecycle of the Mcode server child process.
 * Handles spawning, health-check polling, restart, and shutdown.
 */
export class ServerManager {
  private serverProcess: ChildProcess | null = null;
  private _port = 0;
  private _authToken = "";

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
   * Spawn the server process and wait for it to become healthy.
   * Returns the assigned port and auth token.
   */
  async start(): Promise<{ port: number; authToken: string }> {
    this._port = await findAvailablePort(PORT_MIN, PORT_MAX);
    this._authToken = randomUUID();

    const heapMb = readServerHeapMb();
    console.log(`Starting server with --max-old-space-size=${heapMb}`);

    this.serverProcess = fork(SERVER_ENTRY, [], {
      cwd: SERVER_DIR,
      execArgv: ["--import", "tsx", `--max-old-space-size=${heapMb}`],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        MCODE_PORT: String(this._port),
        MCODE_AUTH_TOKEN: this._authToken,
        MCODE_MODE: "desktop",
        MCODE_DATA_DIR: getMcodeDir(),
        MCODE_TEMP_DIR: app.getPath("temp"),
        MCODE_VERSION: app.getVersion(),
      },
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });

    // Forward server stdout/stderr to the main process console
    this.serverProcess.stdout?.on("data", (data: Buffer) => {
      process.stdout.write(`[server] ${data.toString()}`);
    });
    this.serverProcess.stderr?.on("data", (data: Buffer) => {
      process.stderr.write(`[server] ${data.toString()}`);
    });

    this.serverProcess.on("exit", (code) => {
      const unexpected = this.serverProcess !== null;
      console.error(`Server process exited with code ${code}`);
      this.serverProcess = null;
      if (unexpected) {
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
   * Gracefully terminate the server process.
   * Sends SIGTERM first, escalating to SIGKILL after 5 seconds.
   */
  shutdown(): void {
    if (!this.serverProcess) return;

    const proc = this.serverProcess;
    this.serverProcess = null;

    proc.kill("SIGTERM");
    const forceKill = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
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
