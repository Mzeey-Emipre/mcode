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
  public isAlive = false;

  /** Thread ID assigned after a successful `thread/start` or `thread/resume`. */
  public threadId: string | null = null;

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
    this.isAlive = true;
    this.rpc = new CodexRpcClient(child.stdin!, child.stdout!);

    this.wireStderr();
    this.wireExit();

    try {
      await this.runHandshake();
    } catch (err) {
      await this.kill();
      throw err;
    }

    this.rpc.on("notification", (notification) => {
      this.emit("notification", notification);
    });
  }

  /**
   * Gracefully stops the child process.
   *
   * Sends a best-effort `turn/interrupt`, disposes the RPC client, then
   * terminates the process. On Windows uses `taskkill /T /F`; on other
   * platforms sends SIGTERM then SIGKILL after 3 seconds.
   */
  async kill(): Promise<void> {
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

    this.isAlive = false;
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
          void this.kill();
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
      this.isAlive = false;
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
        this.threadId = resumeResult.threadId;
        logger.info("Resumed Codex thread", { threadId: this.threadId });
      } catch (err) {
        const msg = String(err).toLowerCase();
        if (msg.includes("not found") || msg.includes("missing") || msg.includes("expired")) {
          logger.warn("thread/resume failed, falling back to thread/start", {
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

      const startResult = await this.rpc.sendRequest<ThreadStartParams, ThreadStartResult>(
        "thread/start",
        startParams,
        15000,
      );
      this.threadId = startResult.threadId;
      logger.info("Started Codex thread", { threadId: this.threadId });
    }
  }
}
