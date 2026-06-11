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
import { isAbsolute } from "path";
import which from "which";
import { logger } from "@mcode/shared";
import { flattenProcessEnv } from "../../services/shell-env-utils.js";
import { CodexRpcClient } from "./codex-rpc-client.js";
import { mapDecisionToCodexResponse } from "./codex-permission-mapper.js";
import type {
  ThreadStartParams,
  ThreadStartResult,
  ThreadResumeParams,
  ThreadResumeResult,
  TurnInputPart,
  CodexTurnOptions,
  TurnStartParams,
  TurnStartResult,
  SandboxMode,
  AskForApproval,
} from "./codex-types.js";

/** Incoming approval request from the codex app-server, passed to approvalHandler. */
export interface CodexApprovalRequest {
  /** JSON-RPC id to use in the eventual sendResponse call. */
  rpcId: number;
  /** Method name, e.g. "item/commandExecution/requestApproval". */
  method: string;
  /** Opaque params payload forwarded from the server. */
  params: Record<string, unknown>;
}

/**
 * Handler invoked for each server-initiated approval request in supervised mode.
 * Returning a resolved value sends that value back as the RPC response.
 * Throwing routes to the shared mapper with decision="deny" so the turn unblocks.
 */
export type CodexApprovalHandler = (request: CodexApprovalRequest) => Promise<unknown>;

/** Options passed to the CodexAppServer constructor. */
export interface CodexAppServerOptions {
  /** Path to the codex binary, or `"codex"` to rely on PATH resolution. */
  cliPath: string;
  /** Working directory for the spawned process. */
  workingDirectory: string;
  /** Model identifier to pass to `thread/start`. */
  model?: string;
  /** Sandbox mode for the codex app-server. */
  sandbox?: SandboxMode;
  /** Approval policy (`"never"` auto-approves all). */
  approvalPolicy?: AskForApproval;
  /**
   * If set, attempt `thread/resume` with this thread ID before falling back
   * to `thread/start`.
   */
  resumeThreadId?: string;
  /**
   * Optional hook invoked when the codex app-server issues a server-initiated
   * approval RPC. Replaces the default auto-deny fallback in supervised mode.
   * Ignored when approvalPolicy === "never" (full-access still auto-approves).
   */
  approvalHandler?: CodexApprovalHandler;
  /**
   * Optional Windows Job Object to attach the spawned child to.
   * When set, the codex process dies with the server on crash.
   */
  jobObject?: import("../../services/job-object.js").JobObject;
  /**
   * Supplies env for the child `codex` process. When unset, `process.env` is copied.
   */
  getSpawnEnv?: () => Record<string, string>;
}

/**
 * Pure routing logic for a single codex serverRequest. Exported for unit
 * testing so we can assert the full decision table without spawning a child
 * process. The live code in CodexAppServer simply wraps this with the
 * real sendResponse.
 */
export async function routeCodexServerRequest(args: {
  msg: { id?: number; method?: string; params?: Record<string, unknown> };
  approvalPolicy: AskForApproval | undefined;
  approvalHandler: CodexApprovalHandler | undefined;
  sendResponse: (id: number, result: unknown) => void;
}): Promise<void> {
  const { msg, approvalPolicy, approvalHandler, sendResponse } = args;
  if (typeof msg.id !== "number") return;

  const method = msg.method ?? "";
  const params = msg.params ?? {};
  const autoApprove = approvalPolicy === "never";

  if (autoApprove) {
    logger.info("Codex serverRequest auto-approved", { id: msg.id, method });
    if (method === "item/permissions/requestApproval") {
      sendResponse(msg.id, {
        permissions: {
          fileSystem: { read: [], write: [] },
          network: { enabled: true },
        },
        scope: "session",
      });
    } else if (method === "applyPatchApproval" || method === "execCommandApproval") {
      sendResponse(msg.id, { decision: "approved_for_session" });
    } else {
      sendResponse(msg.id, { decision: "acceptForSession" });
    }
    return;
  }

  if (approvalHandler) {
    try {
      const result = await approvalHandler({ rpcId: msg.id, method, params });
      sendResponse(msg.id, result);
    } catch (err) {
      logger.error("Codex approvalHandler rejected; sending safe-deny", {
        id: msg.id,
        method,
        error: String(err),
      });
      sendResponse(msg.id, mapDecisionToCodexResponse(method, "deny", params));
    }
    return;
  }

  // No handler in supervised mode: route through the shared mapper with
  // decision="deny" so legacy methods get "denied", v2 methods get "decline",
  // and permissions requests get an empty-permissions turn-scoped response.
  logger.info("Codex serverRequest denied (no approvalHandler and policy is not auto-approve)", {
    id: msg.id,
    method,
  });
  sendResponse(msg.id, mapDecisionToCodexResponse(method, "deny", params));
}

/**
 * Notification method prefixes that are silently consumed at debug level
 * and never forwarded to the turn mapper.
 *
 * Source: codex-rs/app-server-protocol/schema/typescript/ServerNotification.ts
 * in https://github.com/openai/codex
 *
 * Intentionally excluded prefixes that DO reach the mapper:
 *   `turn/` – excluded because `turn/completed` must reach the mapper
 *   `item/` – excluded because `item/completed`, `item/agentMessage/delta`,
 *             and `item/commandExecution/outputDelta` must reach the mapper
 *   `error` – excluded because it must reach the mapper
 */
const LIFECYCLE_NOTIFICATION_PREFIXES = [
  "thread/",           // thread lifecycle (started, status/changed, archived, name/updated, etc.)
  "codex/event/",      // legacy codex events
  "account/",          // account/rateLimits/updated, account/updated, account/login/completed
  "hook/",             // hook/started, hook/completed
  "rawResponseItem/",  // rawResponseItem/completed - low-level response items
  "serverRequest/",    // serverRequest/resolved - approval flow bookkeeping
  "mcpServer/",        // mcpServer/startupStatus/updated, mcpServer/oauthLogin/completed
  "fuzzyFileSearch/",  // fuzzyFileSearch/sessionUpdated, fuzzyFileSearch/sessionCompleted
  "windows",           // windows/worldWritableWarning, windowsSandbox/setupCompleted
  "app/",              // app/list/updated (EXPERIMENTAL)
  "fs/",               // fs/changed
  "thread/realtime/",  // realtime audio/SDP (EXPERIMENTAL)
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
 * Cold-start tolerance for the `initialize` handshake. The `codex app-server`
 * can take 10s+ to answer `initialize` on a cold start (auth refresh, sandbox
 * setup), so a single hard 10s budget produced spurious "Timed out waiting for
 * initialize" failures on a first message. Adjusting cold-start tolerance is a
 * one-line change here.
 */
const INITIALIZE_HANDSHAKE = {
  /** Per-attempt timeout. Raised from 10s so a slow-but-healthy server connects. */
  timeoutMs: 30_000,
  /** Total attempts: one initial try plus one retry. */
  attempts: 2,
  /** Base backoff between attempts; multiplied by the attempt number. */
  backoffMs: 500,
} as const;

/**
 * Minimal RPC surface needed to run the `initialize` step. Lets the handshake
 * be unit-tested against a fake client without spawning a real `codex` CLI.
 */
export interface InitializeCapableRpc {
  sendRequest<TParams, TResult>(method: string, params: TParams, timeoutMs?: number): Promise<TResult>;
}

/**
 * Runs the JSON-RPC `initialize` step with cold-start tolerance: a raised
 * per-attempt timeout and one retry with linear backoff. If every attempt
 * fails, the most recent non-benign stderr line (when present) is folded into
 * the thrown error so the chat banner shows the real cause (e.g. "not
 * authenticated", "unsupported version") rather than a bare timeout.
 *
 * Exported for unit testing; the live code wraps it with the real RPC client.
 *
 * @throws When all attempts fail. The message includes the classified stderr reason when one was seen.
 */
export async function performInitialize(args: {
  rpc: InitializeCapableRpc;
  timeoutMs: number;
  attempts: number;
  backoffMs: number;
  getLastStderr: () => string | null;
  sleep?: (ms: number) => Promise<void>;
}): Promise<void> {
  const { rpc, timeoutMs, attempts, backoffMs, getLastStderr } = args;
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await rpc.sendRequest(
        "initialize",
        {
          clientInfo: { name: "mcode", version: "1.0.0" },
          capabilities: { experimentalApi: true },
        },
        timeoutMs,
      );
      // Surface cold-start recovery so the field can tell "slow but healthy"
      // (succeeded on a later attempt) apart from "fast and healthy".
      if (attempt > 1) {
        logger.info("Codex initialize succeeded after retry", { attempt, attempts });
      }
      return;
    } catch (err) {
      lastErr = err;
      logger.warn("Codex initialize attempt failed", { attempt, attempts, error: String(err) });
      if (attempt < attempts) await sleep(backoffMs * attempt);
    }
  }

  throw enrichHandshakeError(lastErr, getLastStderr());
}

/** JSON-RPC / app-server codes that mean the stored thread or rollout is gone. */
const RECOVERABLE_RESUME_ERROR_CODES = new Set([
  "THREAD_NOT_FOUND",
  "ROLL_OUT_NOT_FOUND",
  "ROLLOUT_NOT_FOUND",
]);

/** Case-insensitive message phrases for stale thread/resume (not generic "not found"). */
const RECOVERABLE_RESUME_ERROR_PHRASES = [
  "no rollout found",
  "rollout not found",
  "thread not found",
  "no such thread",
  "unknown thread",
  "thread does not exist",
] as const;

/**
 * Returns true when `thread/resume` failed because the stored Codex thread or
 * rollout is missing locally. The handshake should fall back to `thread/start`.
 */
export function isRecoverableCodexResumeError(error: unknown): boolean {
  if (typeof error === "object" && error !== null) {
    const record = error as { code?: unknown; type?: unknown };
    for (const key of ["code", "type"] as const) {
      const raw = record[key];
      if (typeof raw === "string" && RECOVERABLE_RESUME_ERROR_CODES.has(raw.toUpperCase())) {
        return true;
      }
    }
  }
  const message =
    typeof error === "object" && error !== null && "message" in error
    && typeof (error as { message?: unknown }).message === "string"
      ? (error as { message: string }).message
      : String(error);
  const lower = message.toLowerCase();
  return RECOVERABLE_RESUME_ERROR_PHRASES.some((phrase) => lower.includes(phrase));
}

/**
 * Appends the most recent classified stderr line to a handshake failure when
 * present, so auth/version/setup errors are legible instead of bare timeouts.
 */
export function enrichHandshakeError(err: unknown, stderr: string | null): Error {
  const base = err instanceof Error ? err.message : String(err);
  if (!stderr || base.includes(stderr)) {
    return err instanceof Error ? err : new Error(base);
  }
  return new Error(`${base} (codex app-server reported: ${stderr})`);
}

/**
 * Boot-time cold-start warm-up: spawns a throwaway `codex app-server`, runs
 * `initialize`, and kills it. The first `initialize` on a cold machine pays
 * for paging the large Rust binary into the OS file cache plus a TLS/auth
 * round trip to chatgpt.com (~1.7s+, worse on slow networks); paying it at
 * app boot means the user's first real session starts warm.
 *
 * Fire-and-forget safe: never throws, resolves `true` only when `initialize`
 * was acknowledged within the timeout.
 */
export async function warmCodexAppServer(cliPath: string, timeoutMs = 20_000): Promise<boolean> {
  let resolvedCliPath = cliPath;
  if (!isAbsolute(cliPath)) {
    try {
      resolvedCliPath = await which(cliPath);
    } catch {
      return false;
    }
  }
  const needsShell =
    process.platform === "win32" && resolvedCliPath.toLowerCase().endsWith(".cmd");

  return await new Promise<boolean>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(resolvedCliPath, ["app-server"], {
        stdio: ["pipe", "pipe", "ignore"],
        shell: needsShell,
        env: flattenProcessEnv(process.env),
        windowsHide: true,
      });
    } catch {
      resolve(false);
      return;
    }

    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // taskkill reaps the whole tree on Windows; with shell:true a plain
      // kill() would only hit cmd.exe and orphan the codex child.
      if (process.platform === "win32" && child.pid != null) {
        void import("child_process").then(({ execFile }) => {
          execFile("taskkill", ["/T", "/F", "/PID", String(child.pid)], () => {});
        });
      } else {
        child.kill("SIGKILL");
      }
      resolve(ok);
    };

    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("error", () => finish(false));
    child.once("exit", () => finish(false));

    let buffer = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as { id?: number };
          if (msg.id === 1) {
            logger.info("Codex app-server warm-up completed", { cliPath });
            finish(true);
            return;
          }
        } catch {
          // ignore non-JSON output
        }
      }
    });

    child.once("spawn", () => {
      child.stdin!.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            clientInfo: { name: "mcode", version: "1.0.0" },
            capabilities: { experimentalApi: true },
          },
        }) + "\n",
      );
    });
  });
}

/**
 * Manages the lifecycle of a `codex app-server` child process.
 *
 * Emits:
 * - `notification(data: unknown)` - JSON-RPC notification forwarded from the RPC client
 * - `activity()` - a server-initiated request arrived (liveness signal for turn watchdogs)
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

  /** `true` when a `thread/resume` was attempted but failed, forcing a fresh `thread/start`. */
  private _resumeFailed = false;
  /** Whether the session lost context because `thread/resume` failed. */
  public get resumeFailed(): boolean { return this._resumeFailed; }

  /** The CLI path used to spawn the process, for stale-path detection. */
  public readonly cliPath: string;

  private rpc!: CodexRpcClient;
  private child!: ChildProcess;
  private killRequested = false;
  /** Shared in-flight teardown so concurrent `kill()` callers await the same work. */
  private teardownPromise: Promise<void> | null = null;

  /**
   * Most recent non-benign stderr line from the child. Surfaced into the
   * handshake failure error so a genuine setup problem (auth, version) is
   * legible instead of appearing as a bare initialize timeout.
   */
  private lastStderr: string | null = null;

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

    // Resolve bare command names to absolute paths so spawn works without shell.
    // On Windows, which() respects PATHEXT (.EXE before .CMD), so native binaries
    // are preferred over cmd shims. If we end up with a .cmd path, we fall back to
    // shell:true — Node's CreateProcess can't execute .cmd files directly.
    let resolvedCliPath = cliPath;
    let needsShell = false;
    if (!isAbsolute(cliPath)) {
      try {
        resolvedCliPath = await which(cliPath);
      } catch {
        // which() failed — bare name will be passed to spawn as-is.
        // spawn will fail with a clear ENOENT if the binary is not on PATH.
        resolvedCliPath = cliPath;
      }
    }
    // Check for .cmd extension after resolving — applies to both absolute
    // and which()-resolved paths. Node's CreateProcess cannot execute .cmd
    // files directly; they require cmd.exe as the interpreter.
    if (process.platform === "win32" && resolvedCliPath.toLowerCase().endsWith(".cmd")) {
      needsShell = true;
    }

    const child = spawn(resolvedCliPath, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: needsShell,
      cwd: workingDirectory,
      env: this.options.getSpawnEnv ? this.options.getSpawnEnv() : flattenProcessEnv(process.env),
      windowsHide: true,
    });

    // Attach error listener immediately to catch spawn failures (ENOENT, EACCES)
    // before assigning state or creating the RPC client.
    const spawnError = await new Promise<Error | null>((resolve) => {
      child.once("error", (err) => resolve(err));
      // If the process spawns successfully, the "spawn" event fires first.
      // Use setImmediate to yield one tick - if no error by then, spawn succeeded.
      child.once("spawn", () => resolve(null));
    });
    if (spawnError) {
      this._isAlive = false;
      const msg = `Failed to spawn codex app-server: ${spawnError.message}`;
      this.emit("fatal", msg);
      throw new Error(msg);
    }

    // Attach to the server's Job Object for crash cleanup.
    // Must happen after spawn succeeds but before any async handshake steps.
    if (this.options.jobObject && child.pid) {
      this.options.jobObject.assign(child.pid);
      this.options.jobObject.setDescription(child.pid, "Mcode Agent: Codex");
    }

    this.child = child;
    this._isAlive = true;
    this.rpc = new CodexRpcClient(child.stdin!, child.stdout!);

    this.rpc.on("notification", (notification) => {
      const method = (notification as { method?: string }).method ?? "";

      // Capture thread/started notifications to update the thread ID if it changes
      // mid-session (e.g. context compaction). Without this, subsequent turns would
      // use a stale thread ID and lose context.
      if (method === "thread/started") {
        const params = (notification as { params?: Record<string, unknown> }).params;
        // Accept both nested `thread.id` and flat `threadId` shapes
        const thread = params?.thread as { id?: string } | undefined;
        const newThreadId = thread?.id ?? (typeof params?.threadId === "string" ? params.threadId : undefined);
        if (newThreadId && newThreadId !== this._threadId) {
          logger.info("Codex thread ID rotated via thread/started", {
            old: this._threadId,
            new: newThreadId,
          });
          this._threadId = newThreadId;
          // Notify consumers so the new thread ID is persisted (e.g. to the DB).
          // Without this, app restarts would try to resume the stale thread ID.
          this.emit("threadIdChanged", newThreadId);
        }
        this.emit("activity");
        logger.debug("Codex lifecycle notification", { method });
        return;
      }

      if (LIFECYCLE_NOTIFICATION_PREFIXES.some((p) => method.startsWith(p))) {
        // Swallowed from the mapper, but still proof of life: thread/status
        // and similar lifecycle traffic must reset turn-level watchdogs.
        this.emit("activity");
        logger.debug("Codex lifecycle notification", { method });
        return;
      }
      this.emit("notification", notification);
    });

    // Handle server-initiated approval requests via the shared router. Without
    // a response the codex process blocks forever, causing the session to
    // appear stale. The router implements the full decision table (auto-approve
    // for policy="never", handler-driven supervised mode, silent-deny fallback).
    this.rpc.on("serverRequest", (msg: unknown) => {
      const request = msg as { id?: number; method?: string; params?: Record<string, unknown> };
      // Let turn-level watchdogs treat an inbound approval request as liveness:
      // the server is healthy, it is just waiting on a user decision.
      this.emit("activity");
      void routeCodexServerRequest({
        msg: request,
        approvalPolicy: this.options.approvalPolicy,
        approvalHandler: this.options.approvalHandler,
        sendResponse: (id, result) => this.rpc.sendResponse(id, result),
      });
    });

    this.wireStderr();
    this.wireExit();

    try {
      await this.runHandshake();
    } catch (err) {
      await this.kill();
      throw enrichHandshakeError(err, this.lastStderr);
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
    if (this.teardownPromise) return this.teardownPromise;
    this.killRequested = true;
    this.teardownPromise = this.performKill();
    try {
      await this.teardownPromise;
    } finally {
      this.teardownPromise = null;
    }
  }

  /** Runs interrupt, RPC dispose, and process termination once per server instance. */
  private async performKill(): Promise<void> {
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
          this._isAlive = false;
          return;
        }
        try {
          await execFileAsync("taskkill", ["/T", "/F", "/PID", String(this.child.pid)]);
        } catch {
          // process may already be gone
        }
      } else {
        this.child.kill("SIGTERM");
        // Wait up to 3s for graceful exit before escalating to SIGKILL
        const exited = await Promise.race([
          new Promise<boolean>((resolve) => this.child.once("exit", () => resolve(true))),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
        ]);
        if (!exited && this.isAlive) {
          this.child.kill("SIGKILL");
        }
      }
    }

    this._isAlive = false;
  }

  /**
   * Sends a `turn/start` RPC to begin a new agent turn.
   * Returns the turn id from the RPC result when present; events stream via `notification`.
   *
   * @param input - Plain text message or structured input parts (text + images).
   * @param turnOptions - Optional per-turn overrides (model, effort, serviceTier).
   * @returns Codex turn id from the `turn/start` response, if the server returned one.
   * @throws When the RPC call fails or times out.
   */
  async sendTurn(
    input: string | TurnInputPart[],
    turnOptions?: CodexTurnOptions,
  ): Promise<string | null> {
    if (!this.threadId) {
      throw new Error("sendTurn called before thread was established");
    }
    // The codex app-server requires input to be a sequence, never a bare string.
    const parts: TurnInputPart[] = typeof input === "string"
      ? [{ type: "text", text: input }]
      : input;
    logger.debug("Codex turn/start sent", { threadId: this.threadId, model: turnOptions?.model });
    // 60s on the RPC ack lets the codex CLI handle cold spin-up after long
    // idle periods (auth refresh, sandbox setup) without surfacing a spurious
    // timeout to the user. Long-running turn work is governed separately by
    // TURN_TIMEOUT_MS in codex-provider.ts (resets on every notification).
    const result = await this.rpc.sendRequest<TurnStartParams, TurnStartResult>("turn/start", {
      threadId: this.threadId,
      input: parts,
      ...(turnOptions?.model && { model: turnOptions.model }),
      ...(turnOptions?.effort && { effort: turnOptions.effort }),
      ...(turnOptions?.serviceTier && { serviceTier: turnOptions.serviceTier }),
    }, 60000);
    const turnId = result?.turnId ?? result?.turn?.id ?? null;
    if (turnId) {
      logger.debug("Codex turn/start acknowledged", { threadId: this.threadId, turnId });
    }
    return turnId;
  }

  /**
   * Cheap liveness probe: true when the app-server still answers RPCs.
   * `model/list` is the lightest request the protocol guarantees post-init.
   * Used by turn watchdogs to distinguish "long-running but healthy" from
   * "wedged" before giving up on a silent turn.
   */
  async ping(timeoutMs = 10_000): Promise<boolean> {
    if (!this._isAlive || !this.rpc) return false;
    try {
      await this.rpc.sendRequest("model/list", {}, timeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Best-effort interrupt for the in-flight turn without killing the app-server.
   * Used before starting a new turn so stale `turn/completed` waits cannot resolve early.
   */
  async interruptTurn(): Promise<void> {
    if (!this.threadId || !this.rpc) return;
    try {
      await this.rpc.sendRequest("turn/interrupt", { threadId: this.threadId }, 5000);
    } catch {
      // Non-fatal: first turn or idle session may have nothing to interrupt.
    }
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

      // Fatal classification applies only before a thread is established.
      // Once the session is live, stderr carries tool output and agent-generated
      // content; a build or curl that prints "ECONNRESET" must not kill the
      // whole app-server. Post-handshake transport failures surface via the
      // child exit event and RPC stream-close rejection instead.
      if (this._threadId === null) {
        for (const pattern of FATAL_PATTERNS) {
          if (line.includes(pattern)) {
            this.lastStderr = line;
            const msg = `Codex app-server fatal stderr: ${line}`;
            logger.error(msg, { cliPath: this.cliPath });
            this.emit("fatal", msg);
            this.kill().catch((err: unknown) => {
              logger.error("CodexAppServer: kill after fatal stderr failed", { error: String(err) });
            });
            return;
          }
        }
      }

      // Record the most recent non-benign line so a handshake failure can name
      // the real cause. Tool output, Rust tracing, and agent-generated content
      // are often muxed onto stderr; warn-level logs were drowning useful signal
      // in .mcode-dev, so the line itself stays at debug.
      this.lastStderr = line;
      logger.debug("Codex stderr", { line });
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
    const { workingDirectory, model, sandbox, approvalPolicy, resumeThreadId } =
      this.options;

    // Step 1: initialize (cold-start tolerant: raised budget + one retry)
    await performInitialize({
      rpc: this.rpc,
      timeoutMs: INITIALIZE_HANDSHAKE.timeoutMs,
      attempts: INITIALIZE_HANDSHAKE.attempts,
      backoffMs: INITIALIZE_HANDSHAKE.backoffMs,
      getLastStderr: () => this.lastStderr,
    });

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
      logger.info("Codex thread/resume attempted", { resumeThreadId });
      try {
        // thread/resume supports model + sandbox + approvalPolicy overrides so the
        // resumed thread picks up the current user settings.
        const resumeResult = await this.rpc.sendRequest<ThreadResumeParams, ThreadResumeResult>(
          "thread/resume",
          {
            threadId: resumeThreadId,
            ...(model && { model }),
            ...(sandbox && { sandbox }),
            ...(approvalPolicy && { approvalPolicy }),
            ...(workingDirectory && { cwd: workingDirectory }),
          },
          15000,
        );
        // Accept both flat `threadId` and nested `thread.id` shapes,
        // same as the thread/start path. The codex app-server returns the
        // thread ID at result.thread.id, not result.threadId.
        const r = resumeResult as { threadId?: string; thread?: { id?: string } };
        this._threadId = r.threadId ?? r.thread?.id ?? null;
        logger.info("Codex thread resumed", { resumeThreadId, assignedThreadId: this.threadId });
      } catch (err) {
        const errorStr = String(err);
        const recoverable = isRecoverableCodexResumeError(err);
        logger.warn("Codex thread/resume failed", { resumeThreadId, error: errorStr, recoverable });
        if (recoverable) {
          this._resumeFailed = true;
          // fall through to thread/start below
        } else {
          throw err; // non-recoverable
        }
      }
    }

    if (!this.threadId) {
      const startParams: ThreadStartParams = {
        ...(workingDirectory && { cwd: workingDirectory }),
        ...(model && { model }),
        ...(sandbox && { sandbox }),
        ...(approvalPolicy && { approvalPolicy }),
      };

      // Some codex app-server versions carry the threadId in the `thread/started`
      // notification rather than in the RPC response result. The notification may
      // arrive in a separate I/O chunk AFTER the response, so we keep the promise
      // alive beyond the sendRequest await rather than using a simple variable.
      let resolveThreadStarted!: (id: string | null) => void;
      const threadStartedPromise = new Promise<string | null>((resolve) => {
        resolveThreadStarted = resolve;
      });
      const startedTimeout = setTimeout(() => resolveThreadStarted(null), 3000);

      const captureStarted = (n: unknown) => {
        const notification = n as { method?: string; params?: Record<string, unknown> };
        if (notification.method === "thread/started") {
          logger.debug("Codex thread/started notification", { params: notification.params });
          // Accept both flat `threadId` and nested `thread.id` shapes
          const p = notification.params;
          const thread = p?.thread as { id?: string } | undefined;
          const id = (typeof p?.threadId === "string" ? p.threadId : undefined) ?? thread?.id;
          resolveThreadStarted(typeof id === "string" ? id : null);
        }
      };
      this.rpc.on("notification", captureStarted);

      let startResult: ThreadStartResult | null = null;
      let startError: unknown;
      try {
        startResult = await this.rpc.sendRequest<ThreadStartParams, ThreadStartResult>(
          "thread/start",
          startParams,
          15000,
        );
        logger.debug("Codex thread/start response", { result: startResult });
      } catch (err) {
        startError = err;
      } finally {
        const cleanup = () => {
          clearTimeout(startedTimeout);
          this.rpc.off("notification", captureStarted);
        };
        if (startError) {
          cleanup();
        } else {
          // Prefer the RPC response; if missing, wait for the notification.
          // The codex app-server returns the threadId at result.thread.id,
          // not result.threadId. Accept both shapes for forward compatibility.
          const r = startResult as { threadId?: string; thread?: { id?: string } } | null;
          const responseThreadId = r?.threadId ?? r?.thread?.id;
          if (responseThreadId) {
            this._threadId = responseThreadId;
            cleanup();
          } else {
            this._threadId = await threadStartedPromise;
            cleanup();
          }
        }
      }

      if (startError) {
        throw startError;
      }

      if (!this._threadId) {
        throw new Error(
          "thread/start completed but no threadId received (response: "
          + JSON.stringify(startResult) + ")",
        );
      }

      logger.info("Started Codex thread", { threadId: this.threadId });
    }
  }
}
