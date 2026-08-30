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
import { resolveSubagentDisplayName } from "@mcode/contracts";
import { logger } from "@mcode/shared";
import { CodexRpcClient } from "./codex-rpc-client.js";
import { mapDecisionToCodexResponse } from "./codex-permission-mapper.js";
import type {
  ThreadStartParams,
  ThreadStartResult,
  ThreadResumeParams,
  ThreadResumeResult,
  ThreadItemsListParams,
  ThreadItemsListResult,
  TurnInputPart,
  CodexTurnOptions,
  TurnStartParams,
  TurnStartResult,
  TurnInterruptParams,
  TurnInterruptResult,
  ThreadGoal,
  ThreadGoalSetParams,
  ThreadGoalSetResult,
  ThreadGoalGetParams,
  ThreadGoalGetResult,
  ThreadGoalClearParams,
  ThreadGoalClearResult,
  ThreadGoalStatus,
  AccountRateLimitsReadResult,
  SkillsListParams,
  SkillsListResult,
  PluginListParams,
  PluginListResult,
  PluginReadParams,
  PluginReadResult,
  ConfigReadParams,
  ConfigReadResult,
  SandboxMode,
  AskForApproval,
  ReasoningEffort,
} from "./codex-types.js";

function flattenProcessEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

type CodexAppServerCommand = { cliPath: string; needsShell: boolean };

async function resolveCodexAppServerCommand(cliPath: string): Promise<CodexAppServerCommand> {
  const resolvedCliPath = await resolveCodexAppServerPath(cliPath);
  return {
    cliPath: resolvedCliPath,
    needsShell: process.platform === "win32" && resolvedCliPath.toLowerCase().endsWith(".cmd"),
  };
}

async function resolveCodexAppServerPath(cliPath: string): Promise<string> {
  if (isAbsolute(cliPath)) return cliPath;
  try {
    return await which(cliPath);
  } catch {
    return cliPath;
  }
}

function waitForCodexAppServerSpawn(child: ChildProcess): Promise<Error | null> {
  return new Promise<Error | null>((resolve) => {
    child.once("error", (error) => resolve(error));
    child.once("spawn", () => resolve(null));
  });
}

function shouldRotateCodexThreadId(
  currentThreadId: string | null,
  parentThreadId: string | undefined,
  nextThreadId: string,
): boolean {
  return (!currentThreadId || !parentThreadId) && nextThreadId !== currentThreadId;
}

function createCodexTurnStartParams(
  threadId: string,
  input: string | TurnInputPart[],
  turnOptions: CodexTurnOptions | undefined,
): TurnStartParams {
  const params: TurnStartParams = {
    threadId,
    input: typeof input === "string" ? [{ type: "text", text: input }] : input,
  };
  if (turnOptions?.model) params.model = turnOptions.model;
  if (turnOptions?.effort) params.effort = turnOptions.effort;
  if (turnOptions?.serviceTier) params.serviceTier = turnOptions.serviceTier;
  return params;
}

function fulfilledCodexResult<T>(result: PromiseSettledResult<T>): T | undefined {
  return result.status === "fulfilled" ? result.value : undefined;
}

function createCodexChildThreadMetadata(
  identity: string | undefined,
  model: string | undefined,
  reasoningEffort: ReasoningEffort | undefined,
  parentMessage: string | undefined,
): CodexChildThreadMetadata | null {
  if (!identity && !model && !reasoningEffort && !parentMessage) return null;
  return {
    ...(identity ? { identity } : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(parentMessage ? { parentMessage } : {}),
  };
}

type CodexThreadStartedNotification = {
  threadId: string | undefined;
  parentThreadId: string | undefined;
};

function codexThreadStartedNotification(
  params: Record<string, unknown> | undefined,
): CodexThreadStartedNotification {
  const thread = params?.thread as { id?: string; parentThreadId?: string } | undefined;
  return {
    threadId: thread?.id ?? (typeof params?.threadId === "string" ? params.threadId : undefined),
    parentThreadId: thread?.parentThreadId ?? (typeof params?.parentThreadId === "string" ? params.parentThreadId : undefined),
  };
}

function codexThreadIdFromStartedNotification(params: Record<string, unknown> | undefined): string | null {
  return codexThreadStartedNotification(params).threadId ?? null;
}

function codexThreadIdFromResponse(
  result: ThreadResumeResult | ThreadStartResult | null,
): string | undefined {
  const response = result as { threadId?: string; thread?: { id?: string } } | null;
  return response?.threadId ?? response?.thread?.id;
}

function createMetadataFromChildThreadResults(
  resumed: ThreadResumeResult | undefined,
  listedItems: ThreadItemsListResult | undefined,
): CodexChildThreadMetadata | null {
  const thread = resumed?.thread;
  const identity = resolveSubagentDisplayName({
    agentName: thread?.name,
    subagentName: thread?.agentNickname,
    subagentType: thread?.agentRole,
  });
  const parentMessage = listedItems ? parentMessageFromChildItems(listedItems.data) : undefined;
  const model = typeof resumed?.model === "string" ? resumed.model : undefined;
  return createCodexChildThreadMetadata(identity, model, resumed?.reasoningEffort ?? undefined, parentMessage);
}

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
  processAttachment?: {
    attach(pid: number, description: string): void;
  };
  /**
   * Supplies env for the child `codex` process. When unset, `process.env` is copied.
   */
  getSpawnEnv?: () => Record<string, string>;
  /** Config overrides passed to `codex app-server` as repeated `-c key=value`. */
  configOverrides?: readonly string[];
  /** Completes the handshake after initialization without creating a thread. */
  catalogOnly?: boolean;
  /** Capability-derived Mcode runtime guidance appended to native instructions. */
  developerInstructions?: string;
}

/** Adds optional developer instructions to a native Codex thread payload. */
export function addCodexDeveloperInstructions<T extends ThreadStartParams | ThreadResumeParams>(
  params: T,
  developerInstructions?: string,
  configuredInstructions?: string | null,
): T {
  const composedInstructions = composeCodexDeveloperInstructions(configuredInstructions, developerInstructions);
  return composedInstructions ? { ...params, developerInstructions: composedInstructions } : params;
}

/** Composes configured Codex instructions with Mcode runtime guidance. */
export function composeCodexDeveloperInstructions(
  configuredInstructions?: string | null,
  developerInstructions?: string | null,
): string | undefined {
  const configured = configuredInstructions?.trim() ? configuredInstructions : undefined;
  const runtime = developerInstructions?.trim() ? developerInstructions : undefined;
  if (!runtime) return configured;
  if (!configured) return runtime;
  if (containsCodexInstructionBlock(configured, runtime)) return configured;
  return `${configured}\n\n${runtime}`;
}

function containsCodexInstructionBlock(text: string, block: string): boolean {
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const index = text.indexOf(block, searchFrom);
    if (index < 0) return false;
    const end = index + block.length;
    const startsAtBoundary = index === 0 || text[index - 1] === "\n";
    const endsAtBoundary = end === text.length || text[end] === "\n" || (text[end] === "\r" && text[end + 1] === "\n");
    if (startsAtBoundary && endsAtBoundary) return true;
    searchFrom = index + 1;
  }
  return false;
}

function getConfiguredDeveloperInstructions(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error("Codex config/read returned an invalid response");
  }
  const config = (result as Record<string, unknown>).config;
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new Error("Codex config/read returned an invalid response");
  }
  const configuredInstructions = (config as Record<string, unknown>).developer_instructions;
  if (configuredInstructions === undefined || configuredInstructions === null) return undefined;
  if (typeof configuredInstructions !== "string") {
    throw new Error("Codex config/read returned an invalid response");
  }
  return configuredInstructions;
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
  const diagnosticMethod = boundProtocolIdentifier(method);
  const params = msg.params ?? {};
  const autoApprove = approvalPolicy === "never";

  if (autoApprove) {
    logger.info("Codex serverRequest auto-approved", { id: msg.id, method: diagnosticMethod });
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
        method: diagnosticMethod,
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
    method: diagnosticMethod,
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
  "mcpServer/oauthLogin/", // OAuth lifecycle stays provider-internal; startup status is user-visible.
  "fuzzyFileSearch/",  // fuzzyFileSearch/sessionUpdated, fuzzyFileSearch/sessionCompleted
  "windows",           // windows/worldWritableWarning, windowsSandbox/setupCompleted
  "app/",              // app/list/updated (EXPERIMENTAL)
  "fs/",               // fs/changed
  "thread/realtime/",  // realtime audio/SDP (EXPERIMENTAL)
] as const;

  /** Maximum time to drain an exact child turn's terminal notification after interrupt acknowledgement. */
const CHILD_INTERRUPT_DRAIN_TIMEOUT_MS = 5_000;
/** Stable failure returned when an acknowledged child interrupt has no terminal notification. */
const CHILD_INTERRUPT_DRAIN_TIMEOUT_ERROR = "Child interruption timed out waiting for terminal completion.";

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
 * Startup budget for establishing or resuming a Codex thread after the app-server
 * is initialized. Newer Codex builds can spend longer here while loading session
 * state, but turn execution remains governed by the separate turn watchdogs.
 */
const THREAD_HANDSHAKE_TIMEOUT_MS = 30_000;

/** Maximum non-benign stderr lines retained for app-server diagnostics. */
const STDERR_TAIL_MAX_LINES = 50;
/** Maximum UTF-8 bytes retained across non-benign stderr diagnostics. */
const STDERR_TAIL_MAX_BYTES = 16 * 1024;
/** Maximum code points retained for protocol identifiers in diagnostics. */
const MAX_PROTOCOL_IDENTIFIER_LENGTH = 256;

/** Bounds an untrusted protocol identifier before retaining it in diagnostics. */
function boundProtocolIdentifier(value: string): string {
  let bounded = "";
  let length = 0;
  for (const character of value) {
    if (length >= MAX_PROTOCOL_IDENTIFIER_LENGTH) break;
    bounded += character;
    length += 1;
  }
  return bounded;
}

/** Decoded child-process exit details used in user-facing and structured diagnostics. */
interface ExitDiagnostics {
  /** Raw exit code reported by Node. */
  rawCode: number | null;
  /** Signal reported by Node. */
  signal: string | null;
  /** Signed int32 representation for unsigned Windows-style exit codes. */
  signedInt32?: number;
  /** Hex representation for numeric exit codes. */
  hexCode?: string;
}

/** Bounded, payload-free context captured at an unexpected app-server exit. */
export interface CodexTransportBreadcrumb {
  /** Failure boundary that produced this snapshot. */
  readonly cause: "unexpected_exit";
  /** Child PID when Node exposed one. */
  readonly pid: number | null;
  /** Latest server-initiated request ID, when one was waiting. */
  readonly activeRequestId: number | null;
  /** Latest Codex turn ID observed for this process, when available. */
  readonly activeTurnId: string | null;
  /** Last inbound protocol method and wall-clock timestamp. */
  readonly lastActivity: Readonly<{ method: string; timestamp: number }> | null;
  /** Raw child exit code and signal. */
  readonly exit: Readonly<{ code: number | null; signal: string | null }>;
  /** Bounded, non-benign stderr tail. */
  readonly stderrTail: readonly string[];
}

/** Retains a bounded tail of non-benign stderr lines for Codex crash diagnostics. */
class StderrTail {
  private readonly lines: string[] = [];
  private totalBytes = 0;

  add(line: string): void {
    const boundedLine = this.boundLine(line);
    const bytes = Buffer.byteLength(boundedLine, "utf8");
    this.lines.push(boundedLine);
    this.totalBytes += bytes;
    this.evict();
  }

  latest(): string | null {
    return this.lines.at(-1) ?? null;
  }

  snapshot(): string[] {
    return [...this.lines];
  }

  private evict(): void {
    // The `lines.length > 1` floor is safe: boundLine caps any single line at
    // STDERR_TAIL_MAX_BYTES on insertion, so total retention never exceeds
    // max(STDERR_TAIL_MAX_BYTES, one bounded line).
    while (
      this.lines.length > STDERR_TAIL_MAX_LINES
      || (this.totalBytes > STDERR_TAIL_MAX_BYTES && this.lines.length > 1)
    ) {
      const removed = this.lines.shift();
      if (removed != null) this.totalBytes -= Buffer.byteLength(removed, "utf8");
    }
  }

  private boundLine(line: string): string {
    if (Buffer.byteLength(line, "utf8") <= STDERR_TAIL_MAX_BYTES) {
      return line;
    }

    let bytes = 0;
    let out = "";
    for (const char of line) {
      const next = Buffer.byteLength(char, "utf8");
      if (bytes + next > STDERR_TAIL_MAX_BYTES) break;
      out += char;
      bytes += next;
    }
    return out;
  }
}

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

const CHILD_THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function parentMessageFromChildPreview(preview: unknown): string | undefined {
  if (typeof preview !== "string") return undefined;
  const message = preview.trim();
  if (!message) return undefined;
  if (!message.startsWith("Message Type:")) return message;
  const payload = message.match(/\r?\nPayload:\s*\r?\n([\s\S]*)$/i)?.[1]?.trim();
  return payload || undefined;
}

function parentMessageFromChildItems(items: ThreadItemsListResult["data"]): string | undefined {
  let fallbackMessage: string | undefined;
  for (const entry of items ?? []) {
    if (entry.item?.type !== "userMessage") continue;
    const message = entry.item.content
      ?.filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("");
    if (!message?.trim().startsWith("Message Type:")) {
      fallbackMessage ??= parentMessageFromChildPreview(message);
      continue;
    }
    const parentMessage = parentMessageFromChildPreview(message);
    if (parentMessage) return parentMessage;
  }
  return fallbackMessage;
}

/** Authoritative display identity and model configuration for a native sub-agent thread. */
export interface CodexChildThreadMetadata {
  identity?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  parentMessage?: string;
}

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

/** Maximum code points of stderr excerpt embedded in the user-facing fatal message. */
const STDERR_EXCERPT_MAX_CHARS = 256;

/**
 * Bounds and sanitizes a stderr line for embedding in the user-facing fatal
 * message. Backticks are stripped because the web CliErrorBanner extracts
 * backtick-quoted substrings as copyable commands, and child stderr can carry
 * agent-generated content. The full line stays in the structured log fields.
 */
function excerptForMessage(line: string): string {
  const stripped = line.replaceAll("`", "'");
  let codePoints = 0;
  let out = "";
  for (const char of stripped) {
    if (codePoints >= STDERR_EXCERPT_MAX_CHARS) {
      return out + "…";
    }
    out += char;
    codePoints += 1;
  }
  return out;
}

/** Decodes raw child-process exit metadata for crash diagnostics. */
function decodeExitDiagnostics(code: number | null, signal: string | null): ExitDiagnostics {
  if (code == null) {
    return { rawCode: code, signal };
  }
  return {
    rawCode: code,
    signal,
    signedInt32: code > 0x7fffffff ? code | 0 : undefined,
    hexCode: `0x${(code >>> 0).toString(16).padStart(8, "0")}`,
  };
}

/** Formats the unexpected-exit message shown to users and error banners. */
function formatUnexpectedExitMessage(exit: ExitDiagnostics, latestStderr: string | null): string {
  const parts = [
    `raw code=${exit.rawCode}`,
    `signal=${exit.signal}`,
    ...(exit.signedInt32 != null ? [`signed int32=${exit.signedInt32}`] : []),
    ...(exit.hexCode ? [`hex=${exit.hexCode}`] : []),
  ];
  const stderr = latestStderr
    ? `latest stderr: ${excerptForMessage(latestStderr)}`
    : "no stderr was captured";
  return `Codex app-server exited unexpectedly (${parts.join(", ")}; ${stderr})`;
}

/**
 * Boot-time cold-start warm-up: spawns a throwaway `codex app-server`, runs
 * `initialize`, and kills it. The first `initialize` on a cold machine pays
 * for paging the large Rust binary into the OS file cache plus a TLS/auth
 * round trip to chatgpt.com (~1.7s+, worse on slow networks); paying it at
 * app boot means the user's first real session starts warm.
 *
 * Fire-and-forget safe: never throws. `initialized` is true only when
 * `initialize` was acknowledged within the timeout. When the local app-server
 * supports it, `rateLimitsPayload` carries the `account/rateLimits/read`
 * snapshot for the provider-owned usage cache.
 */
export interface CodexAppServerWarmupResult {
  initialized: boolean;
  rateLimitsPayload?: unknown;
}

/** Starts a throwaway app-server process and reads an initial account limit snapshot. */
export async function warmCodexAppServer(
  cliPath: string,
  timeoutMs = 20_000,
  getSpawnEnv?: () => Record<string, string>,
): Promise<CodexAppServerWarmupResult> {
  const deadline = performance.now() + Math.max(0, timeoutMs);
  const remainingBudgetMs = (): number => Math.max(0, deadline - performance.now());
  let resolvedCliPath = cliPath;
  if (!isAbsolute(cliPath)) {
    const discoveryBudgetMs = remainingBudgetMs();
    if (discoveryBudgetMs <= 0) return { initialized: false };

    let discoveryTimer: ReturnType<typeof setTimeout> | undefined;
    const discovery = Promise.resolve()
      .then(() => which(cliPath))
      .catch(() => null);
    const discoveryTimeout = new Promise<null>((resolve) => {
      discoveryTimer = setTimeout(() => resolve(null), discoveryBudgetMs);
    });

    let discoveredCliPath: string | null;
    try {
      discoveredCliPath = await Promise.race([discovery, discoveryTimeout]);
    } finally {
      if (discoveryTimer !== undefined) clearTimeout(discoveryTimer);
    }
    if (discoveredCliPath === null || remainingBudgetMs() <= 0) return { initialized: false };
    resolvedCliPath = discoveredCliPath;
  }
  if (remainingBudgetMs() <= 0) return { initialized: false };
  const needsShell =
    process.platform === "win32" && resolvedCliPath.toLowerCase().endsWith(".cmd");

  return await new Promise<CodexAppServerWarmupResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(resolvedCliPath, ["app-server"], {
        stdio: ["pipe", "pipe", "ignore"],
        shell: needsShell,
        env: getSpawnEnv ? getSpawnEnv() : flattenProcessEnvironment(process.env),
        windowsHide: true,
      });
    } catch {
      resolve({ initialized: false });
      return;
    }

    let settled = false;
    let initialized = false;
    let latestRateLimitsPayload: unknown;
    const finish = (result: CodexAppServerWarmupResult) => {
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
      resolve(result);
    };

    const timer = setTimeout(
      () => finish({ initialized, rateLimitsPayload: latestRateLimitsPayload }),
      remainingBudgetMs(),
    );
    child.once("error", () => finish({ initialized, rateLimitsPayload: latestRateLimitsPayload }));
    child.once("exit", () => finish({ initialized, rateLimitsPayload: latestRateLimitsPayload }));

    let buffer = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as {
            id?: number;
            method?: string;
            params?: unknown;
            result?: unknown;
          };
          if (msg.method === "account/rateLimits/updated") {
            latestRateLimitsPayload = msg.params;
            continue;
          }
          if (msg.id === 1) {
            initialized = true;
            logger.info("Codex app-server warm-up completed", { cliPath });
            child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }) + "\n");
            child.stdin!.write(
              JSON.stringify({
                jsonrpc: "2.0",
                id: 2,
                method: "account/rateLimits/read",
                params: {},
              }) + "\n",
            );
            return;
          }
          if (msg.id === 2) {
            finish({ initialized: true, rateLimitsPayload: msg.result ?? latestRateLimitsPayload });
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

  /** Bounded non-benign stderr tail shared by handshake and exit diagnostics. */
  private readonly stderrTail = new StderrTail();
  /** Most recent immutable crash context, available without changing fatal listener arity. */
  private _lastTransportBreadcrumb: CodexTransportBreadcrumb | null = null;
  /** Most recent immutable crash context, if the child exited unexpectedly. */
  public get lastTransportBreadcrumb(): CodexTransportBreadcrumb | null {
    return this._lastTransportBreadcrumb;
  }
  private activeRequestId: number | null = null;
  private activeTurnId: string | null = null;
  private lastActivity: { method: string; timestamp: number } | null = null;

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
    this._lastTransportBreadcrumb = null;
    const command = await resolveCodexAppServerCommand(this.options.cliPath);
    const child = this.spawnAppServer(command);
    const spawnError = await waitForCodexAppServerSpawn(child);
    if (spawnError) {
      this._isAlive = false;
      const msg = `Failed to spawn codex app-server: ${spawnError.message}`;
      this.emit("fatal", msg);
      throw new Error(msg);
    }

    if (this.options.processAttachment && child.pid) {
      this.options.processAttachment.attach(child.pid, "Mcode Agent: Codex");
    }
    this.child = child;
    this._isAlive = true;
    this.rpc = new CodexRpcClient(child.stdin!, child.stdout!);
    this.wireRpc();
    this.wireStderr();
    this.wireExit();

    try {
      await this.runHandshake();
    } catch (err) {
      await this.kill();
      throw enrichHandshakeError(err, this.stderrTail.latest());
    }
  }

  private spawnAppServer(command: CodexAppServerCommand): ChildProcess {
    const configArgs = (this.options.configOverrides ?? []).flatMap((override) => ["-c", override]);
    return spawn(command.cliPath, ["app-server", ...configArgs], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: command.needsShell,
      cwd: this.options.workingDirectory,
      env: this.options.getSpawnEnv ? this.options.getSpawnEnv() : flattenProcessEnvironment(process.env),
      windowsHide: true,
    });
  }

  private wireRpc(): void {
    this.rpc.on("notification", (notification) => this.handleNotification(notification));
    this.rpc.on("serverRequest", (request) => this.handleServerRequest(request));
  }

  private handleNotification(notification: unknown): void {
    const message = notification as { method?: string; params?: Record<string, unknown> };
    const method = message.method ?? "";
    const diagnosticMethod = boundProtocolIdentifier(method);
    this.lastActivity = { method: diagnosticMethod, timestamp: Date.now() };
    if (method === "account/rateLimits/updated" || method === "account/updated") {
      this.emit("activity");
      this.emit("notification", notification);
      return;
    }
    if (this.handleThreadStartedNotification(message.params, method, diagnosticMethod)) return;
    this.trackTurnNotification(message.params, method);
    if (this.isSilencedLifecycleNotification(method)) {
      this.emit("activity");
      logger.debug("Codex lifecycle notification", { method: diagnosticMethod });
      return;
    }
    this.emit("notification", notification);
  }

  private handleThreadStartedNotification(
    params: Record<string, unknown> | undefined,
    method: string,
    diagnosticMethod: string,
  ): boolean {
    if (method !== "thread/started") return false;
    const threadStarted = codexThreadStartedNotification(params);
    this.rotateThreadIdFromNotification(threadStarted);
    this.emit("activity");
    logger.debug("Codex lifecycle notification", { method: diagnosticMethod });
    return true;
  }

  private rotateThreadIdFromNotification(threadStarted: CodexThreadStartedNotification): void {
    if (!threadStarted.threadId || !shouldRotateCodexThreadId(this._threadId, threadStarted.parentThreadId, threadStarted.threadId)) return;
    logger.info("Codex thread ID rotated via thread/started", { old: this._threadId, new: threadStarted.threadId });
    this._threadId = threadStarted.threadId;
    this.emit("threadIdChanged", threadStarted.threadId);
  }

  private trackTurnNotification(params: Record<string, unknown> | undefined, method: string): void {
    if (method === "turn/completed") {
      this.activeTurnId = null;
      return;
    }
    if (method !== "turn/started") return;
    const turn = params?.turn as { id?: string } | undefined;
    const turnId = turn?.id ?? (typeof params?.turnId === "string" ? params.turnId : undefined);
    if (turnId) this.activeTurnId = boundProtocolIdentifier(turnId);
  }

  private isSilencedLifecycleNotification(method: string): boolean {
    return method !== "thread/settings/updated"
      && !method.startsWith("thread/goal/")
      && LIFECYCLE_NOTIFICATION_PREFIXES.some((prefix) => method.startsWith(prefix));
  }

  private handleServerRequest(msg: unknown): void {
    const request = msg as { id?: number; method?: string; params?: Record<string, unknown> };
    this.lastActivity = { method: typeof request.method === "string" ? boundProtocolIdentifier(request.method) : "", timestamp: Date.now() };
    this.activeRequestId = typeof request.id === "number" ? request.id : null;
    this.emit("activity");
    void routeCodexServerRequest({
      msg: request,
      approvalPolicy: this.options.approvalPolicy,
      approvalHandler: this.options.approvalHandler,
      sendResponse: (id, result) => this.rpc.sendResponse(id, result),
    }).finally(() => {
      if (this.activeRequestId === request.id) this.activeRequestId = null;
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
    await this.interruptActiveThread();
    this.rpc?.dispose();
    await this.terminateChild();
    this._isAlive = false;
  }

  private async interruptActiveThread(): Promise<void> {
    const threadId = this.threadId;
    if (!this.rpc || !threadId) return;
    try {
      await this.rpc.sendRequest("turn/interrupt", { threadId }, 3000);
    } catch {
      // The process may have already stopped before the best-effort interrupt arrives.
    }
  }

  private async terminateChild(): Promise<void> {
    if (!this.child) return;
    if (process.platform === "win32") {
      await this.terminateWindowsChild(this.child);
      return;
    }
    await this.terminatePosixChild(this.child);
  }

  private async terminateWindowsChild(child: ChildProcess): Promise<void> {
    if (child.pid == null) {
      logger.warn("CodexAppServer: child process has no PID, cannot taskkill", { cliPath: this.cliPath });
      return;
    }
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    try {
      await promisify(execFile)("taskkill", ["/T", "/F", "/PID", String(child.pid)]);
    } catch {
      // taskkill fails when the child already exited.
    }
  }

  private async terminatePosixChild(child: ChildProcess): Promise<void> {
    child.kill("SIGTERM");
    const exited = await Promise.race([
      new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
    ]);
    if (!exited && this.isAlive) child.kill("SIGKILL");
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
    const threadId = this.threadId;
    if (!threadId) throw new Error("sendTurn called before thread was established");
    logger.debug("Codex turn/start sent", { threadId, model: turnOptions?.model });
    const params = createCodexTurnStartParams(threadId, input, turnOptions);
    const result = await this.rpc.sendRequest<TurnStartParams, TurnStartResult>("turn/start", params, 60000);
    const turnId = result?.turnId ?? result?.turn?.id ?? null;
    this.recordStartedTurn(threadId, turnId);
    return turnId;
  }

  private recordStartedTurn(threadId: string, turnId: string | null): void {
    if (!turnId) return;
    const diagnosticTurnId = boundProtocolIdentifier(turnId);
    this.activeTurnId = diagnosticTurnId;
    logger.debug("Codex turn/start acknowledged", { threadId, turnId: diagnosticTurnId });
  }

  /** Reads authoritative child settings and its persisted parent message. */
  async getChildThreadMetadata(childThreadId: string): Promise<CodexChildThreadMetadata | null> {
    if (!CHILD_THREAD_ID_PATTERN.test(childThreadId)) return null;
    const [resume, items] = await Promise.allSettled([
      this.rpc.sendRequest<ThreadResumeParams, ThreadResumeResult>(
        "thread/resume",
        { threadId: childThreadId, excludeTurns: true },
        3_000,
      ),
      this.rpc.sendRequest<ThreadItemsListParams, ThreadItemsListResult>(
        "thread/items/list",
        { threadId: childThreadId, limit: 100, sortDirection: "asc" },
        10_000,
      ),
    ]);
    return this.childThreadMetadataFromResults(resume, items);
  }

  private childThreadMetadataFromResults(
    resume: PromiseSettledResult<ThreadResumeResult>,
    items: PromiseSettledResult<ThreadItemsListResult>,
  ): CodexChildThreadMetadata | null {
    if (resume.status === "rejected" && items.status === "rejected") throw resume.reason;
    return createMetadataFromChildThreadResults(fulfilledCodexResult(resume), fulfilledCodexResult(items));
  }

  /** Set or update the native Codex thread goal. */
  async setGoal(objective: string): Promise<ThreadGoal> {
    return this.updateGoal({ objective, status: "active" });
  }

  /** Update native Codex goal metadata on the current thread. */
  async updateGoal(params: {
    objective?: string | null;
    status?: ThreadGoalStatus | null;
    tokenBudget?: number | null;
  }): Promise<ThreadGoal> {
    if (!this.threadId) {
      throw new Error("updateGoal called before thread was established");
    }
    const result = await this.rpc.sendRequest<ThreadGoalSetParams, ThreadGoalSetResult>(
      "thread/goal/set",
      {
        threadId: this.threadId,
        ...params,
      },
      10000,
    );
    return result.goal;
  }

  /** Read the native Codex goal for the current thread. */
  async getGoal(): Promise<ThreadGoal | null> {
    if (!this.threadId) {
      throw new Error("getGoal called before thread was established");
    }
    const result = await this.rpc.sendRequest<ThreadGoalGetParams, ThreadGoalGetResult>(
      "thread/goal/get",
      { threadId: this.threadId },
      10000,
    );
    return result.goal;
  }

  /** Clear the native Codex goal for the current thread. */
  async clearGoal(): Promise<boolean> {
    if (!this.threadId) {
      throw new Error("clearGoal called before thread was established");
    }
    const result = await this.rpc.sendRequest<ThreadGoalClearParams, ThreadGoalClearResult>(
      "thread/goal/clear",
      { threadId: this.threadId },
      10000,
    );
    return result.cleared;
  }

  /** Reads the current ChatGPT account rate-limit snapshot from the app-server. */
  async readRateLimits(): Promise<AccountRateLimitsReadResult> {
    if (!this._isAlive || !this.rpc) {
      throw new Error("readRateLimits called before codex app-server was ready");
    }
    return this.rpc.sendRequest<Record<string, never>, AccountRateLimitsReadResult>(
      "account/rateLimits/read",
      {},
      10000,
    );
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
   * Reads the native Codex skill catalog from an already-running app-server.
   * Callers own fallback behavior; this method never starts a process.
   */
  async listSkills(cwds?: string[], forceReload = false): Promise<SkillsListResult> {
    if (!this._isAlive || !this.rpc) {
      throw new Error("listSkills called before codex app-server was ready");
    }
    const params: SkillsListParams = {
      ...(cwds && cwds.length > 0 ? { cwds } : {}),
      ...(forceReload ? { forceReload } : {}),
    };
    return this.rpc.sendRequest<SkillsListParams, SkillsListResult>("skills/list", params, 10000);
  }

  /** Reads installed plugin summaries for the effective working-directory context. */
  async listPlugins(cwds?: string[]): Promise<PluginListResult> {
    if (!this._isAlive || !this.rpc) {
      throw new Error("listPlugins called before codex app-server was ready");
    }
    const params: PluginListParams = cwds && cwds.length > 0 ? { cwds } : {};
    return this.rpc.sendRequest<PluginListParams, PluginListResult>("plugin/list", params, 10000);
  }

  /** Reads plugin detail only when its list summary omits composer metadata. */
  async readPlugin(params: PluginReadParams): Promise<PluginReadResult> {
    if (!this._isAlive || !this.rpc) {
      throw new Error("readPlugin called before codex app-server was ready");
    }
    return this.rpc.sendRequest<PluginReadParams, PluginReadResult>("plugin/read", params, 2_000);
  }

  /** Reads effective Codex configuration for one working directory. */
  async readConfig(cwd?: string): Promise<ConfigReadResult> {
    if (!this._isAlive || !this.rpc) {
      throw new Error("readConfig called before codex app-server was ready");
    }
    return this.rpc.sendRequest<ConfigReadParams, ConfigReadResult>(
      "config/read",
      { includeLayers: false, ...(cwd ? { cwd } : {}) },
      10000,
    );
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

  /** Interrupt one exact native child turn without changing this app-server session. */
  async interruptChildTurn(nativeThreadId: string, nativeTurnId: string): Promise<void> {
    if (!this.rpc) throw new Error("Child interruption requested before codex app-server was ready");
    let finishDrain!: () => void;
    let failDrain!: (error: Error) => void;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const drain = new Promise<void>((resolve, reject) => {
      finishDrain = resolve;
      failDrain = reject;
    });
    const onNotification = (notification: unknown): void => {
      const message = notification as {
        method?: unknown;
        params?: { threadId?: unknown; turnId?: unknown; turn?: { id?: unknown } };
      };
      if (message.method !== "turn/completed"
        || message.params?.threadId !== nativeThreadId
        || (message.params.turn?.id ?? message.params.turnId) !== nativeTurnId) return;
      finishDrain();
    };
    this.on("notification", onNotification);
    drainTimer = setTimeout(
      () => failDrain(new Error(CHILD_INTERRUPT_DRAIN_TIMEOUT_ERROR)),
      CHILD_INTERRUPT_DRAIN_TIMEOUT_MS,
    );
    try {
      await this.rpc.sendRequest<TurnInterruptParams, TurnInterruptResult>(
        "turn/interrupt",
        { threadId: nativeThreadId, turnId: nativeTurnId },
        5_000,
      );
      await drain;
    } finally {
      this.off("notification", onNotification);
      if (drainTimer) clearTimeout(drainTimer);
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
            this.stderrTail.add(line);
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
      this.stderrTail.add(line);
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
        const exit = decodeExitDiagnostics(code, signal);
        const stderrTail = this.stderrTail.snapshot();
        const latestStderr = this.stderrTail.latest();
        const msg = formatUnexpectedExitMessage(exit, latestStderr);
        const breadcrumb = Object.freeze({
          cause: "unexpected_exit" as const,
          pid: this.child.pid ?? null,
          activeRequestId: this.activeRequestId,
          activeTurnId: this.activeTurnId,
          lastActivity: this.lastActivity ? Object.freeze({ ...this.lastActivity }) : null,
          exit: Object.freeze({ code, signal }),
          stderrTail: Object.freeze(stderrTail),
        }) satisfies CodexTransportBreadcrumb;
        this._lastTransportBreadcrumb = breadcrumb;
        logger.error(msg, { cliPath, exit, stderrTail, breadcrumb });
        this.emit("fatal", msg);
      }
    });
  }

  /** Runs the JSON-RPC handshake sequence in order. */
  private async runHandshake(): Promise<void> {
    await performInitialize({
      rpc: this.rpc,
      timeoutMs: INITIALIZE_HANDSHAKE.timeoutMs,
      attempts: INITIALIZE_HANDSHAKE.attempts,
      backoffMs: INITIALIZE_HANDSHAKE.backoffMs,
      getLastStderr: () => this.stderrTail.latest(),
    });
    this.rpc.sendNotification("initialized", {});
    if (this.options.catalogOnly) return;
    await this.requestCodexModelList();
    const instructions = await this.resolveDeveloperInstructions(
      this.options.workingDirectory,
      this.options.developerInstructions,
    );
    await this.resumeCodexThread(instructions);
    if (!this.threadId) await this.startCodexThread(instructions);
  }

  private async requestCodexModelList(): Promise<void> {
    try {
      await this.rpc.sendRequest("model/list", {}, 10000);
    } catch (error) {
      logger.warn("Codex model/list failed", { error: String(error) });
    }
  }

  private async resumeCodexThread(instructions: string | undefined): Promise<void> {
    const resumeThreadId = this.options.resumeThreadId;
    if (!resumeThreadId) return;
    logger.info("Codex thread/resume attempted", { resumeThreadId });
    try {
      const result = await this.rpc.sendRequest<ThreadResumeParams, ThreadResumeResult>(
        "thread/resume",
        this.resumeThreadParams(resumeThreadId, instructions),
        THREAD_HANDSHAKE_TIMEOUT_MS,
      );
      this._threadId = codexThreadIdFromResponse(result) ?? null;
      logger.info("Codex thread resumed", { resumeThreadId, assignedThreadId: this.threadId });
    } catch (error) {
      const recoverable = isRecoverableCodexResumeError(error);
      logger.warn("Codex thread/resume failed", { resumeThreadId, error: String(error), recoverable });
      if (!recoverable) throw error;
      this._resumeFailed = true;
    }
  }

  private resumeThreadParams(resumeThreadId: string, instructions: string | undefined): ThreadResumeParams {
    const params: ThreadResumeParams = { threadId: resumeThreadId };
    if (this.options.model) params.model = this.options.model;
    if (this.options.sandbox) params.sandbox = this.options.sandbox;
    if (this.options.approvalPolicy) params.approvalPolicy = this.options.approvalPolicy;
    if (this.options.workingDirectory) params.cwd = this.options.workingDirectory;
    return addCodexDeveloperInstructions(params, instructions);
  }

  private async startCodexThread(instructions: string | undefined): Promise<void> {
    const tracker = this.trackStartedCodexThread();
    let startResult: ThreadStartResult | null = null;
    try {
      startResult = await this.rpc.sendRequest<ThreadStartParams, ThreadStartResult>(
        "thread/start",
        addCodexDeveloperInstructions(this.startThreadParams(), instructions),
        THREAD_HANDSHAKE_TIMEOUT_MS,
      );
      logger.debug("Codex thread/start response", { result: startResult });
      this._threadId = codexThreadIdFromResponse(startResult) || await tracker.threadStarted;
      if (!this._threadId) {
        throw new Error("thread/start completed but no threadId received (response: " + JSON.stringify(startResult) + ")");
      }
      logger.info("Started Codex thread", { threadId: this.threadId });
    } finally {
      tracker.stop();
    }
  }

  private startThreadParams(): ThreadStartParams {
    const params: ThreadStartParams = {};
    if (this.options.workingDirectory) params.cwd = this.options.workingDirectory;
    if (this.options.model) params.model = this.options.model;
    if (this.options.sandbox) params.sandbox = this.options.sandbox;
    if (this.options.approvalPolicy) params.approvalPolicy = this.options.approvalPolicy;
    return params;
  }

  private trackStartedCodexThread(): { threadStarted: Promise<string | null>; stop: () => void } {
    let resolveThreadStarted!: (threadId: string | null) => void;
    const threadStarted = new Promise<string | null>((resolve) => { resolveThreadStarted = resolve; });
    const timeout = setTimeout(() => resolveThreadStarted(null), 3000);
    const capture = (notification: unknown): void => {
      const message = notification as { method?: string; params?: Record<string, unknown> };
      if (message.method !== "thread/started") return;
      logger.debug("Codex thread/started notification", { params: message.params });
      resolveThreadStarted(codexThreadIdFromStartedNotification(message.params));
    };
    this.rpc.on("notification", capture);
    return {
      threadStarted,
      stop: () => {
        clearTimeout(timeout);
        this.rpc.off("notification", capture);
      },
    };
  }

  /** Resolves configured instructions before adding request-level runtime guidance. */
  private async resolveDeveloperInstructions(
    workingDirectory: string,
    developerInstructions?: string,
  ): Promise<string | undefined> {
    if (!developerInstructions?.trim()) return undefined;
    try {
      const configResult = await this.readConfig(workingDirectory);
      const configuredInstructions = getConfiguredDeveloperInstructions(configResult);
      return composeCodexDeveloperInstructions(configuredInstructions, developerInstructions);
    } catch (error) {
      if (developerInstructions?.trim()) {
        logger.warn("Codex config/read failed; omitting developer instructions", { error: String(error) });
      }
      return undefined;
    }
  }
}
