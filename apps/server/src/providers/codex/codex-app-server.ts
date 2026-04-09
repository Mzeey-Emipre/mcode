/**
 * Persistent child process manager for the `codex app-server` CLI subprocess.
 *
 * Spawns `codex app-server`, completes the JSON-RPC 2.0 handshake sequence
 * (initialize → initialized → model/list → thread/resume or thread/start),
 * and forwards server notifications to consumers via EventEmitter.
 */

import { spawn } from "child_process";
import type { ChildProcess } from "child_process";
import { createInterface } from "readline";
import { EventEmitter } from "events";
import { logger } from "@mcode/shared";
import { CodexRpcClient } from "./codex-rpc-client.js";
import type {
  ThreadStartParams,
  ThreadStartResult,
  ThreadResumeParams,
  ThreadResumeResult,
  TurnInputPart,
} from "./codex-types.js";

/** Options passed to the CodexAppServer constructor. */
export interface CodexAppServerOptions {
  /** Path to the codex binary, or `"codex"` to rely on PATH resolution. */
  cliPath: string;
  /** Working directory for the spawned process. */
  workingDirectory: string;
  /** Model identifier to pass to `thread/start`. */
  model?: string;
  /** Sandbox mode to pass to `thread/start`. */
  sandboxMode?: string;
  /** Model reasoning effort to pass to `thread/start`. */
  modelReasoningEffort?: string;
  /**
   * If set, attempt `thread/resume` with this thread ID before falling back
   * to `thread/start`.
   */
  resumeThreadId?: string;
}

/**
 * Notification method prefixes that are lifecycle events from the app-server.
 * These are silently consumed at debug level and never forwarded to the turn mapper.
 * Turn events use dot-notation (`turn.event`, `turn.completed`, `turn.failed`);
 * lifecycle notifications use slash-notation and are safe to filter by prefix.
 */
const LIFECYCLE_NOTIFICATION_PREFIXES = [
  "thread/",
  "codex/event/",
] as const;

/** Benign substrings found in stderr that are safe to ignore at debug level. */
const BENIGN_PATTERNS = [
  "Debugger",
  "ExperimentalWarning",
  "punycode",
  "state db missing",
  "state db record_discrepancy",
  "Reading prompt from stdin",
] as const;

/** Fatal substrings in stderr that indicate an unrecoverable process failure. */
const FATAL_PATTERNS = [
  "failed to connect to websocket",
  "ECONNREFUSED",
  "ECONNRESET",
] as const;

/** ANSI escape code regex, used to strip color codes from stderr lines. */
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/**
 * Manages the lifecycle of a `codex app-server` child process.
 *
 * Emits:
 * - `notification(data: unknown)` - JSON-RPC notification forwarded from the RPC client
 * - `fatal(error: string)` - unrecoverable error from stderr, unexpected exit, or handshake failure
 * - `exit(code: number | null, signal: string | null)` - child process exit
 */
export class CodexAppServer extends EventEmitter {
  /** `true` after spawn, `false` after exit or kill. */
  private _isAlive = false;
  /** Whether the child process is currently alive. */
  public get isAlive(): boolean { return this._isAlive; }

  /** Thread ID assigned after a successful `thread/start` or `thread/resume`. */
  private _threadId: string | null = null;
  /** Thread ID assigned after a successful `thread/start` or `thread/resume`. */
  public get threadId(): string | null { return this._threadId; }

  /** The CLI path used to spawn the process, for stale-path detection. */
  public readonly cliPath: string;

  private rpc!: CodexRpcClient;
  private child!: ChildProcess;
  private killRequested = false;

  private readonly options: CodexAppServerOptions;

  /**
   * Creates a new CodexAppServer instance. Call `start()` to spawn the process.
   *
   * @param options - Configuration for the child process and handshake sequence.
   */
  constructor(options: CodexAppServerOptions) {
    super();
    this.options = options;
    this.cliPath = options.cliPath;
  }

  /**
   * Spawns `codex app-server` and runs the full handshake sequence.
   *
   * Wires stderr and exit handlers before the handshake begins. If any
   * handshake step fails (except the best-effort `model/list`), the child
   * process is killed and the error is re-thrown to the caller.
   *
   * @throws When spawn fails or a required handshake RPC returns an error.
   */
  async start(): Promise<void> {
    const { cliPath, workingDirectory } = this.options;

    const child = spawn(cliPath, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
      cwd: workingDirectory,
      env: { ...process.env },
    });

    this.child = child;
    this._isAlive = true;
    this.rpc = new CodexRpcClient(child.stdin!, child.stdout!);

    this.rpc.on("notification", (notification) => {
      const method = (notification as { method?: string }).method ?? "";
      if (LIFECYCLE_NOTIFICATION_PREFIXES.some((p) => method.startsWith(p))) {
        logger.debug("Codex lifecycle notification", { method });
        return;
      }
      this.emit("notification", notification);
    });

    this.wireStderr();
    this.wireExit();

    try {
      await this.runHandshake();
    } catch (err) {
      await this.kill();
      throw err;
    }
  }

  /**
   * Gracefully stops the child process.
   *
   * Sends a best-effort `turn/interrupt`, disposes the RPC client, then
   * terminates the process. On Windows uses `taskkill /T /F`; on other
   * platforms sends SIGTERM then SIGKILL after 3 seconds.
   */
  async kill(): Promise<void> {
    if (this.killRequested) return;
    this.killRequested = true;

    if (this.rpc) {
      try {
        await this.rpc.sendRequest("turn/interrupt", { threadId: this.threadId }, 3000);
      } catch {
        // best effort - ignore
      }
      this.rpc.dispose();
    }

    if (this.child) {
      if (process.platform === "win32") {
        const { execFile } = await import("child_process");
        const { promisify } = await import("util");
        const execFileAsync = promisify(execFile);
        if (this.child.pid == null) {
          logger.warn("CodexAppServer: child process has no PID, cannot taskkill", { cliPath: this.cliPath });
          return;
        }
        try {
          await execFileAsync("taskkill", ["/T", "/F", "/PID", String(this.child.pid)]);
        } catch {
          // process may already be gone
        }
      } else {
        this.child.kill("SIGTERM");
        await new Promise<void>((resolve) => setTimeout(resolve, 3000));
        if (this.isAlive) {
          this.child.kill("SIGKILL");
        }
      }
    }

    this._isAlive = false;
  }

  /**
   * Sends a `turn/start` RPC to begin a new agent turn.
   * Returns after the server acknowledgment - events stream via the `notification` event.
   *
   * @param input - Plain text message or structured input parts (text + images).
   * @throws When the RPC call fails or times out.
   */
  async sendTurn(input: string | TurnInputPart[]): Promise<void> {
    if (!this.threadId) {
      throw new Error("sendTurn called before thread was established");
    }
    // The codex app-server requires input to be a sequence, never a bare string.
    const parts: TurnInputPart[] = typeof input === "string"
      ? [{ type: "text", text: input }]
      : input;
    await this.rpc.sendRequest("turn/start", {
      threadId: this.threadId,
      input: parts,
    }, 30000);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Attaches a readline interface to stderr and classifies each line. */
  private wireStderr(): void {
    const rl = createInterface({ input: this.child.stderr! });

    rl.on("line", (raw: string) => {
      const line = raw.replace(ANSI_RE, "").trim();

      if (line === "") return;

      if (BENIGN_PATTERNS.some((p) => line.includes(p))) {
        logger.debug("Codex stderr (benign)", { line });
        return;
      }

      for (const pattern of FATAL_PATTERNS) {
        if (line.includes(pattern)) {
          const msg = `Codex app-server fatal stderr: ${line}`;
          logger.error(msg, { cliPath: this.cliPath });
          this.emit("fatal", msg);
          this.kill().catch((err: unknown) => {
            logger.error("CodexAppServer: kill after fatal stderr failed", { error: String(err) });
          });
          return;
        }
      }

      logger.warn("Codex stderr", { line });
    });
  }

  /** Wires the child process exit event to update state and emit events. */
  private wireExit(): void {
    const { cliPath } = this.options;

    this.child.on("exit", (code, signal) => {
      this._isAlive = false;
      this.emit("exit", code, signal);

      if (!this.killRequested) {
        const msg = `Codex app-server exited unexpectedly (code=${code}, signal=${signal})`;
        logger.error(msg, { cliPath });
        this.emit("fatal", msg);
      }
    });
  }

  /** Runs the JSON-RPC handshake sequence in order. */
  private async runHandshake(): Promise<void> {
    const { workingDirectory, model, sandboxMode, modelReasoningEffort, resumeThreadId } =
      this.options;

    // Step 1: initialize
    await this.rpc.sendRequest(
      "initialize",
      {
        clientInfo: { name: "mcode", version: "1.0.0" },
        capabilities: { experimentalApi: true },
      },
      10000,
    );

    // Step 2: initialized notification (no response expected)
    this.rpc.sendNotification("initialized", {});

    // Step 3: model/list (best-effort)
    try {
      await this.rpc.sendRequest("model/list", {}, 10000);
    } catch (err) {
      logger.warn("Codex model/list failed", { error: String(err) });
    }

    // Step 4: thread/resume or thread/start
    if (resumeThreadId) {
      try {
        const resumeResult = await this.rpc.sendRequest<ThreadResumeParams, ThreadResumeResult>(
          "thread/resume",
          { threadId: resumeThreadId },
          15000,
        );
        this._threadId = resumeResult.threadId;
        logger.info("Resumed Codex thread", { threadId: this.threadId });
      } catch (err) {
        const msg = String(err).toLowerCase();
        if (msg.includes("not found") || msg.includes("missing") || msg.includes("expired")) {
          logger.warn("thread/resume failed; falling back to thread/start", {
            error: String(err),
          });
          // fall through to thread/start below
        } else {
          throw err; // non-recoverable
        }
      }
    }

    if (!this.threadId) {
      const startParams: ThreadStartParams = {
        workingDirectory,
        ...(model && { model }),
        ...(sandboxMode && { sandboxMode }),
        ...(modelReasoningEffort && { modelReasoningEffort }),
      };

      // Some codex app-server versions carry the threadId in the `thread/started`
      // notification rather than (or in addition to) the RPC response result.
      // Listen on the raw RPC stream directly so we capture it before the
      // lifecycle notification filter in CodexAppServer.start() drops it.
      let notificationThreadId: string | null = null;
      const captureStarted = (n: unknown) => {
        const notification = n as { method?: string; params?: { threadId?: string } };
        if (
          notification.method === "thread/started" &&
          typeof notification.params?.threadId === "string"
        ) {
          notificationThreadId = notification.params.threadId;
        }
      };
      this.rpc.on("notification", captureStarted);

      try {
        const startResult = await this.rpc.sendRequest<ThreadStartParams, ThreadStartResult>(
          "thread/start",
          startParams,
          15000,
        );
        // Prefer the response result; fall back to the notification if the
        // result is empty or missing the field.
        this._threadId = (startResult as { threadId?: string } | null)?.threadId
          ?? notificationThreadId;
      } finally {
        this.rpc.off("notification", captureStarted);
      }

      if (!this._threadId) {
        throw new Error(
          "thread/start completed but no threadId received in response or thread/started notification",
        );
      }

      logger.info("Started Codex thread", { threadId: this.threadId });
    }
  }
}
