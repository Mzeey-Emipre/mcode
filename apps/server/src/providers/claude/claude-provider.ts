/**
 * Claude Agent SDK provider adapter.
 * Implements IAgentProvider using the v1 query() API with a prompt queue pattern.
 * Migrated from apps/desktop/src/main/sidecar/client.ts.
 */

import { injectable, inject } from "tsyringe";
import { EventEmitter } from "events";
import { readFile } from "fs/promises";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { Query, SDKUserMessage, PostCompactHookInput, StopHookInput, CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { logger } from "@mcode/shared";
import { AgentEventType, isVirtualBrowserContextAttachment } from "@mcode/contracts";
import type {
  IAgentProvider,
  IGoalCapable,
  ISessionEvictable,
  TurnRequest,
  ProviderId,
  ReasoningLevel,
  OrchestrationMode,
  ContextWindowMode,
  AgentEvent,
  AttachmentMeta,
  GoalState,
  GoalLookupResult,
  ProviderModelInfo,
  ProviderBillingMode,
  ProviderUsageInfo,
  QuotaCategory,
  PermissionDecision,
  PermissionRequest,
  CompletionOptions,
} from "@mcode/contracts";
import { buildReasoningOptions } from "./build-reasoning-options.js";
import { createTurnEventSink } from "../../features/agents/turns/turn-event-sink.js";
import { listClaudeModels } from "./list-models.js";
import { resolveSdkModelSlug } from "./resolve-slug.js";
import { clampContextWindowToMode, resolveAutoCompactWindow } from "./context-window.js";
import { readAnthropicOauthToken } from "@mcode/shared/usage";
import { AnthropicOAuthUsageSource } from "./usage/oauth-usage-source.js";
import { AnthropicHeaderUsageSource } from "./usage/header-usage-source.js";
import { CompositeUsageSource } from "./usage/composite-usage-source.js";
import { EnvService } from "../../services/env-service.js";
import { JobObject } from "../../services/job-object.js";
import { ScopedPreGrantService } from "../../services/scoped-pre-grant.js";
import { SessionRuntime } from "../../services/session-runtime.js";
import { InternalThreadControlMcpRuntime } from "../../services/thread-control-mcp-runtime.js";
import { buildMcodeInstructionPlan, renderMcodeInstructions } from "@mcode/thread-orchestration";

/** Merges exact internal and Browser MCP grants used by one Claude session. */
export function mergeClaudeMcpServers(
  base: Record<string, unknown>,
  browserGrant: { mcpUrl: string; token: string } | null,
): Record<string, unknown> {
  return {
    ...base,
    ...(browserGrant
      ? {
          "mcode-browser": {
            type: "http" as const,
            url: browserGrant.mcpUrl,
            headers: { Authorization: `Bearer ${browserGrant.token}` },
          },
        }
      : {}),
  };
}
import type { ProtocolAdapter, SpawnArgs, SpawnResult } from "../../services/session-runtime.js";
import { listDirectChildren } from "../../services/process-kill.js";
import { CleanForker } from "../../features/handoff/index.js";
import {
  browserAutomationPermissionCapability,
  BrowserAutomationSessionLease,
  type BrowserAutomationSessionLeaseGrant,
  type BrowserAutomationSessionLeaseScope,
  type BrowserAutomationSessionLeaseStage,
} from "../../features/browser-automation/index.js";
import type { SessionForker } from "@mcode/contracts";
import { parseClaudeGoalCommandResult } from "./claude-goal-command-parser.js";

/**
 * Default model slug used for side-channel and fallback paths.
 * Kept in one place so all paths stay in sync when upgrading the default.
 */
const DEFAULT_CLAUDE_MODEL = "claude-sonnet-4-5";

/** Shallow snapshot of `process.env` for temporary Claude SDK subprocess alignment. */
function snapshotProcessEnv(): Record<string, string | undefined> {
  return { ...process.env };
}

/** Restores `process.env` after {@link snapshotProcessEnv}. */
function restoreProcessEnv(backup: Record<string, string | undefined>): void {
  for (const k of Object.keys(process.env)) {
    if (!(k in backup)) {
      delete process.env[k];
    }
  }
  for (const [k, v] of Object.entries(backup)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
}

/** Max queued messages before push() warns and drops. */
const MAX_QUEUE_DEPTH = 20;

interface ClaudeGoalEntry {
  readonly objective: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

type ClaudeNativeGoalSupport = "unknown" | "supported" | "unsupported";

/**
 * Per-session state owned by the {@link SessionRuntime}. Holds the live SDK
 * `query`, its prompt-queue handles, and the per-turn bookkeeping the stream
 * loop and eviction guard read. The runtime owns eviction timing and JobObject/
 * kill; `lastUsedAt` is retained here because the stream loop and
 * `resolvePermission` stamp it so SDK activity and user attention count.
 */
interface ClaudeSessionState {
  /** Session id this state belongs to; lets adapter methods reference provider maps. */
  sessionId: string;
  /** Working directory the SDK subprocess was spawned with. */
  cwd: string;
  query: Query;
  pushMessage: (msg: SDKUserMessage, turnExecutionId?: string) => void;
  closeQueue: () => void;
  model: string;
  /**
   * Permission mode the SDK subprocess was spawned with ("full" or "supervised").
   * Compared against incoming requests; when it differs, the subprocess is torn
   * down and a new one is spawned with the new mode because permissionMode is
   * fixed at spawn in the Claude Agent SDK CLI.
   */
  permissionMode: string;
  /**
   * Context window mode the SDK subprocess was spawned with. The 1M window is
   * encoded into the model slug (`<id>[1m]`), so changing this between turns
   * requires a fresh subprocess — the same teardown-and-respawn pattern used
   * for permissionMode.
   */
  contextWindowMode: ContextWindowMode | undefined;
  /** Session-scoped dynamic workflow orchestration state. */
  orchestrationMode: OrchestrationMode;
  lastUsedAt: number;
  /** When true, the finally block in startStreamLoop should not emit an "ended" event. */
  suppressEnded?: boolean;
  /**
   * Set when a resume of this session's transcript hit an unrecoverable API
   * state (see {@link isUnrecoverableThinkingBlockError}). A poisoned entry is
   * never reused: the next send tears it down and spawns a fresh session.
   */
  poisoned?: boolean;
  /** Tool-use IDs whose matching tool_result has not yet been received.
   *  While this set is non-empty, `isBusy` returns true so the runtime's idle
   *  eviction skips the session regardless of how long the SDK has been quiet. */
  pendingToolUses: Set<string>;
  /**
   * True once the first tool call for this sendMessage query has been registered.
   * Distinguishes pre-tool preamble text (pendingToolUses=0, no tool fired yet)
   * from post-tool assistant text. Intentionally survives SDK `result` events
   * because the Claude SDK can emit `result` between internal rounds while the
   * same user turn continues.
   */
  hasFiredToolThisTurn: boolean;
  /** Non-secret browser lease lifecycle metadata for this main session. */
  browserLease?: Pick<BrowserAutomationSessionLeaseGrant, "leaseId" | "credentialId" | "expiresAt">;
  /** Workspace fixed to this SDK query at spawn. */
  workspaceId: string;
  /** Browser permission class fixed to this SDK query at spawn. */
  browserPermissionCapability: "observe" | "interact" | "privileged";
}

/**
 * Create an async iterable prompt queue backed by a simple push/pull bridge.
 * Messages pushed via `push()` are yielded by the iterable. Calling `close()`
 * terminates the iterator, signaling the SDK to shut down the subprocess.
 */
export function createPromptQueue(): {
  push: (msg: SDKUserMessage, turnExecutionId?: string) => void;
  close: () => void;
  setOnPromptConsumed: (handler: (turnExecutionId?: string) => void) => void;
  iterable: AsyncIterable<SDKUserMessage>;
} {
  const pending: Array<{ message: SDKUserMessage; turnExecutionId?: string }> = [];
  let waiting: ((result: IteratorResult<SDKUserMessage>) => void) | null =
    null;
  let done = false;
  let onPromptConsumed: ((turnExecutionId?: string) => void) | undefined;

  const push = (msg: SDKUserMessage, turnExecutionId?: string): void => {
    const queued = { message: msg, turnExecutionId };
    if (done) {
      throw new Error(
        "Prompt queue is closed; message cannot be delivered to the SDK",
      );
    }
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      onPromptConsumed?.(queued.turnExecutionId);
      resolve({ value: queued.message, done: false });
    } else {
      if (pending.length >= MAX_QUEUE_DEPTH) {
        throw new Error(
          `Prompt queue full (depth=${pending.length}), cannot enqueue message`,
        );
      }
      pending.push(queued);
    }
  };

  const setOnPromptConsumed = (handler: (turnExecutionId?: string) => void): void => {
    onPromptConsumed = handler;
  };

  const close = (): void => {
    done = true;
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve({
        value: undefined as unknown as SDKUserMessage,
        done: true,
      });
    }
  };

  const iterable: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<SDKUserMessage>> {
          if (pending.length > 0) {
            const queued = pending.shift()!;
            onPromptConsumed?.(queued.turnExecutionId);
            return Promise.resolve({
              value: queued.message,
              done: false,
            });
          }
          if (done) {
            return Promise.resolve({
              value: undefined as unknown as SDKUserMessage,
              done: true,
            });
          }
          return new Promise((resolve) => {
            waiting = resolve;
          });
        },
      };
    },
  };

  return { push, close, setOnPromptConsumed, iterable };
}

/** Convert a plain string message into an SDKUserMessage. */
function toUserMessage(text: string, sessionId: string): SDKUserMessage {
  return {
    type: "user" as const,
    message: {
      role: "user" as const,
      content: text,
    },
    parent_tool_use_id: null,
    session_id: sessionId,
  };
}

/**
 * Checks whether the SDK used a different model than the one requested.
 * Returns the actual model ID if a fallback fired, or null if the requested
 * model ran as expected.
 *
 * @param modelUsage - `SDKResultSuccess.modelUsage` record (keys are model IDs)
 * @param requestedModel - the model ID that was passed to the SDK
 */
export function detectFallbackModel(
  modelUsage: Record<string, unknown>,
  requestedModel: string,
): string | null {
  const usedModels = Object.keys(modelUsage);
  // SDK resolves aliases to dated snapshot IDs (e.g. "claude-sonnet-4-6" → "claude-sonnet-4-6-20250514").
  // Only treat a key as the same model when the suffix after the hyphen is exactly 8 digits (YYYYMMDD),
  // preventing sibling families like "claude-opus-4-6-*" from matching a request for "claude-opus-4".
  const datedSnapshotSuffix = /^\d{8}$/;
  const requestedModelRan = usedModels.some(
    (m) =>
      m === requestedModel ||
      (m.startsWith(requestedModel + "-") &&
        datedSnapshotSuffix.test(m.slice(requestedModel.length + 1))),
  );
  // Only report a fallback when the requested model is completely absent from usage.
  // The SDK may report multiple models (e.g. primary + tool-routing model) in a single
  // turn; that is NOT a fallback as long as the requested model was used.
  if (requestedModelRan) return null;

  return usedModels[0] ?? null;
}

/**
 * Detects the Anthropic API 400 that bricks a resumable session: with extended
 * thinking on, `thinking`/`redacted_thinking` blocks must be replayed unmodified
 * on every subsequent request. When a stored assistant turn's thinking block is
 * altered (e.g. by SDK-side context compaction during a long tool-use run), the
 * API rejects every resume of that transcript with this message, so the thread
 * is permanently stuck until the session is abandoned.
 *
 * @param resultText - the SDK result payload's `result` string (the error text
 *   lives there, not in the `errors` array, for this class of failure)
 */
export function isUnrecoverableThinkingBlockError(resultText: unknown): boolean {
  if (typeof resultText !== "string") return false;
  return /`?(?:thinking|redacted_thinking)`?[^]*?blocks in the latest assistant message cannot be modified/.test(
    resultText,
  );
}

/** Max time to wait on a resume side-channel before falling back to sessionless. */
const SIDE_CHANNEL_RESUME_PROBE_MS = 20_000;

/** Bytes of subprocess stderr retained per session for crash diagnostics. */
const STDERR_CAPTURE_LIMIT = 8_000;

/**
 * Per-turn payload staged from `sendTurn`/`doSendMessage` to `spawn`. The
 * runtime's `acquire` only hands back state, so the prompt, resume flag, and
 * SDK options for a freshly-spawned session's first turn are carried here keyed
 * by sessionId. Mirrors the Codex provider's `pendingSpawnTurns`.
 */
interface PendingSpawnTurn {
  turnExecutionId: string;
  prompt: SDKUserMessage;
  /** Whether this spawn should resume an existing SDK session id. */
  resume: boolean;
  /** SDK session id to resume from (only consulted when `resume` is true). */
  resumeId: string;
  /** Raw uuid (threadId) used as the `sessionId` option on a fresh (non-resume) spawn. */
  uuid: string;
  /** Fully-built SDK query options sans the resume/sessionId discriminator. */
  baseOptions: Record<string, unknown>;
  /**
   * Bare model id (no `[1m]` suffix) stored on the session state so
   * detectFallbackModel compares against the dated snapshot ids the SDK reports.
   */
  resolvedModel: string;
  /** Context window mode the session was spawned with; gates the in-place reuse check. */
  contextWindowMode: ContextWindowMode | undefined;
  /** Orchestration mode encoded into the session's flag settings. */
  orchestrationMode: OrchestrationMode;
}

interface PendingBrowserAccess {
  scope: BrowserAutomationSessionLeaseScope;
  stage?: BrowserAutomationSessionLeaseStage;
  grant?: BrowserAutomationSessionLeaseGrant;
}

/** Claude Agent SDK adapter implementing IAgentProvider with prompt queue pattern. */
@injectable()
export class ClaudeProvider extends EventEmitter implements IAgentProvider, IGoalCapable, ISessionEvictable, ProtocolAdapter<ClaudeSessionState> {
  readonly id: ProviderId = "claude";
  /** Claude supports one-shot text completion via sdkQuery with maxTurns: 1. */
  readonly supportsCompletion = true;
  readonly sessionForkOnResume = "clean" as const;
  readonly maxInputCharactersPerTurn = 180_000;
  /** Path B (+ B-prime) forker; calls this provider's runSideChannelQuery. */
  readonly forker: SessionForker = new CleanForker(this);

  /** Owns the session pool, idle eviction (with busy guard), and JobObject/kill. */
  private readonly runtime: SessionRuntime<ClaudeSessionState>;
  /** Per-turn payload staged for `spawn` to run a fresh session's first turn. */
  private pendingSpawnTurns = new Map<string, PendingSpawnTurn>();
  /** Browser lease staged only until a fresh normal SDK query starts. */
  private pendingBrowserAccess = new Map<string, PendingBrowserAccess>();
  private sdkSessionIds = new Map<string, string>();
  /**
   * Tail of the most recent stderr emitted by each session's Claude Code
   * subprocess, capped at {@link STDERR_CAPTURE_LIMIT}. The SDK's process-exit
   * error carries only the exit code (no stderr), so without this a crash
   * surfaces as the opaque "process exited with code 1". Captured here and
   * attached to the Error event when the stream throws.
   */
  private recentStderr = new Map<string, string>();
  /**
   * Active goals keyed by sessionId (mcode-${threadId}). When set, the SDK
   * Stop hook installed in baseOptions blocks the agent from ending its turn
   * with a "Goal not yet met" message until the goal is cleared. Set by the
   * `/goal <condition>` chat command (intercepted in AgentService) and
   * cleared by `/goal clear`. In-memory only — does not persist across
   * server restarts.
   */
  private goalsBySession = new Map<string, ClaudeGoalEntry>();
  /** Native Claude Code `/goal` mirrors keyed by Mcode session id. */
  private nativeGoalsBySession = new Map<string, ClaudeGoalEntry>();
  /** Per-session native `/goal` capability, proven only by `system/init.slash_commands`. */
  private nativeGoalSupportBySession = new Map<string, ClaudeNativeGoalSupport>();
  /**
   * Session IDs for which a stop was requested before the session was created.
   * Checked by doSendMessage after session creation; if found the session is
   * torn down immediately so the agent never starts.
   */
  private pendingStops = new Set<string>();
  /**
   * SDK query handles whose stream teardown must not emit `Ended`. Populated
   * when a live session is intentionally superseded (spawn-param mismatch,
   * setModel failure) before `runtime.stop` deletes the pool entry — the
   * stream loop's finally block can then outlive the session map lookup.
   */
  private readonly suppressEndedQueries = new Set<Query>();
  /**
   * Threads whose next `SessionStart` hook should be hidden. Set when a
   * context-window or permission-mode change forces an internal session
   * recreation so the handoff stays invisible in the narrative timeline.
   */
  private readonly suppressSessionStartHooks = new Set<string>();
  /** Threads currently in plan-answer mode. ExitPlanMode is only captured for these. */
  private planAnswerThreads = new Set<string>();
  /** Pending permission requests awaiting user decision, keyed by requestId. */
  private pendingPermissions = new Map<
    string,
    {
      threadId: string;
      toolName: string;
      input: unknown;
      title?: string;
      resolve: (decision: PermissionDecision) => void;
    }
  >();
  private lastSessionCostUsd?: number;
  private lastServiceTier?: "standard" | "priority" | "batch";
  private lastNumTurns?: number;
  private lastDurationMs?: number;
  private readonly oauthUsageSource = new AnthropicOAuthUsageSource(readAnthropicOauthToken);
  private readonly usageSource: CompositeUsageSource = new CompositeUsageSource([
    this.oauthUsageSource,
    new AnthropicHeaderUsageSource(),
  ]);

  constructor(
    @inject(EnvService) private readonly envService: EnvService,
    @inject("JobObject") private readonly jobObject: JobObject,
    // Optional with a default so existing `new ClaudeProvider(env, job)` test
    // call sites keep working; DI always supplies the shared singleton so the
    // pipeline-issued handoff grants are visible here.
    @inject(ScopedPreGrantService)
    private readonly scopedPreGrant: ScopedPreGrantService = new ScopedPreGrantService(),
    @inject(BrowserAutomationSessionLease)
    private readonly browserAutomationSessionLease: BrowserAutomationSessionLease = new BrowserAutomationSessionLease(),
    @inject(InternalThreadControlMcpRuntime)
    private readonly threadControlMcp: InternalThreadControlMcpRuntime = undefined as never,
  ) {
    super();
    this.runtime = new SessionRuntime<ClaudeSessionState>(this, {
      jobObject: this.jobObject,
      envService: this.envService,
    });
  }

  /**
   * Merges {@link EnvService.getEnv} into `process.env` for the Claude SDK spawn window
   * only, then restores the previous environment.
   */
  private withSdkSpawnEnv<T>(fn: () => T): T {
    const backup = snapshotProcessEnv();
    try {
      const merged = this.envService.getEnv();
      for (const [k, v] of Object.entries(merged)) {
        process.env[k] = v;
      }
      return fn();
    } finally {
      restoreProcessEnv(backup);
    }
  }

  /** Start or continue a session by sending a message via the SDK. */
  async sendTurn(req: TurnRequest<"claude">): Promise<void> {
    // Seed the resume id so doSendMessage's sdkSessionIds lookup resolves it.
    // `resumeFrom` defined ⇒ resume that SDK session; undefined ⇒ fresh.
    if (req.resumeFrom !== undefined) {
      this.sdkSessionIds.set(req.sessionId, req.resumeFrom);
    }
    const browserScope: BrowserAutomationSessionLeaseScope = {
      providerId: this.id,
      providerSessionId: req.resumeFrom ?? req.sessionId,
      mcodeSessionId: req.sessionId,
      threadId: req.threadId,
      workspaceId: req.workspaceId,
      permissionCapability: browserAutomationPermissionCapability(
        req.permissionMode,
        req.interactionMode,
      ),
    };
    const previousBrowserAccess = this.pendingBrowserAccess.get(req.sessionId);
    if (previousBrowserAccess?.stage) {
      this.browserAutomationSessionLease.release(previousBrowserAccess.stage.leaseId);
    }
    this.pendingBrowserAccess.set(req.sessionId, {
      scope: browserScope,
      stage: this.browserAutomationSessionLease.stage(browserScope),
    });
    const params = {
      sessionId: req.sessionId,
      message: req.message,
      cwd: req.cwd,
      model: req.model,
      fallbackModel: req.fallbackModel,
      resume: req.resumeFrom !== undefined,
      permissionMode: req.permissionMode,
      attachments: req.attachments,
      reasoningLevel: req.reasoningLevel,
      orchestrationMode: req.orchestrationMode ?? "standard",
      contextWindowMode: req.providerOptions.contextWindowMode,
      thinking: req.providerOptions.thinking,
      maxBudgetUsd: req.maxBudgetUsd,
      maxTurns: req.maxTurns,
    };
    try {
      await this.doSendMessage(params, req.turnExecutionId);
    } catch (e: unknown) {
      logger.error("sendTurn error", {
        sessionId: req.sessionId,
        error: String(e),
      });
      throw e;
    } finally {
      const pendingBrowserAccess = this.pendingBrowserAccess.get(req.sessionId);
      if (pendingBrowserAccess) {
        if (pendingBrowserAccess.grant) {
          this.browserAutomationSessionLease.release(pendingBrowserAccess.grant.leaseId);
        }
        if (pendingBrowserAccess.stage) {
          this.browserAutomationSessionLease.release(pendingBrowserAccess.stage.leaseId);
        }
      }
      this.pendingBrowserAccess.delete(req.sessionId);
    }
  }

  /**
   * One-shot text completion using the same prompt queue pattern as chat.
   * Spawns an ephemeral SDK subprocess (not persisted to disk) with tools
   * disabled and maxTurns: 1, collects the response text, then tears down.
   */
  async complete(prompt: string, model: string, cwd: string, options: CompletionOptions = {}): Promise<string> {
    const backup = snapshotProcessEnv();
    try {
      const merged = this.envService.getEnv();
      for (const [k, v] of Object.entries(merged)) {
        process.env[k] = v;
      }

      const queue = createPromptQueue();
      const ephemeralId = `complete-${crypto.randomUUID()}`;

      // Note: the Claude Agent SDK spawns a 'claude' CLI subprocess internally.
      // That subprocess PID is not exposed by the SDK, so it cannot be added to
      // the server's Job Object. On server crash, this subprocess may briefly
      // outlive the server until the OS job-object kill propagates via inheritance.
      // Track: expose subprocess PID from claude-agent-sdk for explicit assignment.
      const q = sdkQuery({
        prompt: queue.iterable,
        options: {
          cwd,
          model,
          maxTurns: 1,
          tools: [],
          systemPrompt: "Respond with exactly what is requested. No questions, no commentary.",
          settingSources: [],
            permissionMode: "default" as const,
            persistSession: false,
            includePartialMessages: true,
            ...buildReasoningOptions(options.reasoningLevel, model),
          },
        });

      queue.push(toUserMessage(prompt, ephemeralId));
      // Close immediately: the message is already queued. This signals end-of-input
      // so the SDK subprocess exits after processing instead of blocking on the
      // next read from the queue (which would deadlock the for-await loop below).
      queue.close();

      let resultText = "";
      let assistantText = "";
      let deltaText = "";

      for await (const msg of q) {
        const anyMsg = msg as Record<string, unknown>;

        if (anyMsg.type === "result") {
          if (anyMsg.is_error) {
            const errors = (anyMsg.errors as string[]) ?? [];
            throw new Error(`Claude SDK error: ${errors.join(", ") || "unknown error"}`);
          }
          const res = anyMsg.result;
          if (typeof res === "string" && res) resultText = res;
        }

        if (anyMsg.type === "assistant") {
          const content =
            (anyMsg.message as { content?: Array<{ type: string; text?: string }> })
              ?.content ?? [];
          for (const block of content) {
            if (block.type === "text" && block.text) assistantText += block.text;
          }
        }

        // Collect incremental text deltas as a third fallback source
        if (anyMsg.type === "stream_event") {
          const streamEvent = anyMsg.event as {
            type?: string;
            delta?: { type?: string; text?: string };
          };
          if (
            streamEvent?.type === "content_block_delta" &&
            streamEvent.delta?.type === "text_delta" &&
            streamEvent.delta.text
          ) {
            deltaText += streamEvent.delta.text;
          }
        }
      }

      const text = resultText || assistantText || deltaText;
      if (!text) throw new Error("Claude SDK returned no text content");
      return text.trim();
    } finally {
      restoreProcessEnv(backup);
    }
  }

  /**
   * Run a one-shot query against a forked copy of the parent's session.
   * Uses `resume: parentSdkSessionId` which creates a clean fork — the
   * original session is not mutated. Only the text output is returned;
   * the forked session ID is discarded.
   *
   * Post-restart vulnerability: after a server restart, the parent thread's
   * sdk_session_id is still in SQLite but the Claude SDK's in-memory session
   * cache is empty. The SDK may also reject sessions that exceed its retention
   * window (TTL). When that happens, the SDK throws with a session-not-found /
   * session-expired message. We detect that shape here and, when
   * `conversationHistory` is provided, transparently retry without `resume:`
   * by baking the history directly into the prompt (sessionless fallback).
   * Without `conversationHistory`, session-missing errors are rethrown with
   * code="ETIMEDOUT" so the pipeline falls cleanly to path D.
   */
  async runSideChannelQuery(args: {
    parentThreadId: string;
    parentSdkSessionId: string;
    prompt: string;
    abortSignal?: AbortSignal;
    /**
     * Conversation history as plain text (the budgeted replay). Used as the
     * fallback prompt body when `resume:` fails because the SDK's process-local
     * session storage no longer has the parent session (e.g. after a server
     * restart). When omitted, session-missing errors propagate as before.
     */
    conversationHistory?: string;
    /**
     * Working directory for the SDK call. Must be the parent thread's effective
     * worktree (worktree_path if set, otherwise the workspace path) so the
     * model sees the correct user project files, not the server's own cwd.
     */
    cwd: string;
  }): Promise<string> {
    const { parentSdkSessionId, prompt, abortSignal, cwd } = args;

    // Resolve model from the parent thread's active session if available,
    // falling back to the default claude-sonnet model.
    const parentSessionId = `mcode-${args.parentThreadId}`;
    const hasLiveParentSession = this.runtime.get(parentSessionId) !== undefined;

    // Path B-prime: after a server restart (or when the user forks without
    // sending a new message on the parent), the SDK subprocess is not running
    // even though sdk_session_id is still in SQLite. Resume on a cold subprocess
    // often hangs until the pipeline abort fires, leaving no time for the
    // sessionless retry. Skip resume and bake message history into the prompt.
    if (!hasLiveParentSession && args.conversationHistory) {
      logger.info("Claude side-channel: no live parent session, using sessionless path B-prime", {
        threadId: args.parentThreadId,
      });
      return await this.runSideChannelQuerySessionless(
        args.conversationHistory,
        prompt,
        abortSignal,
        args.parentThreadId,
        cwd,
      );
    }

    const model = this.runtime.get(parentSessionId)?.model ?? DEFAULT_CLAUDE_MODEL;

    const backup = snapshotProcessEnv();
    // Cap resume attempts so a hung subprocess does not consume the full
    // pipeline timeout before sessionless path B-prime can run.
    const resumeProbe = args.conversationHistory ? new AbortController() : null;
    let resumeProbeTimer: ReturnType<typeof setTimeout> | undefined;
    if (resumeProbe && abortSignal && !abortSignal.aborted) {
      resumeProbeTimer = setTimeout(() => resumeProbe.abort(), SIDE_CHANNEL_RESUME_PROBE_MS);
      abortSignal.addEventListener("abort", () => resumeProbe.abort(), { once: true });
    }

    try {
      const merged = this.envService.getEnv();
      for (const [k, v] of Object.entries(merged)) {
        process.env[k] = v;
      }

      const queue = createPromptQueue();
      const ephemeralId = `side-channel-${crypto.randomUUID()}`;

      const sdkAbortSource = resumeProbe?.signal ?? abortSignal;

      // The SDK takes an AbortController, not a bare AbortSignal. We cannot
      // overwrite `signal` on a real AbortController (it is a getter-only
      // property and Object.assign throws on modern Node). Instead, create a
      // fresh controller and forward aborts from the caller's signal to it.
      let sdkAbortController: AbortController | undefined;
      if (sdkAbortSource) {
        sdkAbortController = new AbortController();
        if (sdkAbortSource.aborted) {
          sdkAbortController.abort();
        } else {
          sdkAbortSource.addEventListener("abort", () => sdkAbortController?.abort(), { once: true });
        }
      }

      const q = sdkQuery({
        prompt: queue.iterable,
        options: {
          cwd,
          model,
          // 2 turns so a thinking-block or compliance turn from the model
          // does not exhaust the budget before the actual response. We pass
          // tools: [] so the model has nothing to call, but it can still
          // emit a no-op turn during reasoning.
          maxTurns: 2,
          resume: parentSdkSessionId,
          tools: [],
          settingSources: [],
          permissionMode: "default" as const,
          persistSession: false,
          includePartialMessages: true,
          ...(sdkAbortController ? { abortController: sdkAbortController } : {}),
        },
      });

      queue.push(toUserMessage(prompt, ephemeralId));
      // Close immediately after pushing so the SDK subprocess exits after the
      // single turn instead of blocking waiting for more input.
      queue.close();

      let assistantText = "";

      for await (const msg of q) {
        const anyMsg = msg as Record<string, unknown>;

        if (anyMsg.type === "result" && anyMsg.is_error) {
          const errors = (anyMsg.errors as string[]) ?? [];
          logger.warn("Claude side-channel SDK returned is_error", {
            threadId: args.parentThreadId,
            sdkResultKeys: Object.keys(anyMsg),
            errorsField: errors,
            subtype: anyMsg.subtype,
            durationMs: anyMsg.duration_ms,
            rawResult: anyMsg,
          });
          throw new Error(`Claude side-channel query SDK error: ${errors.join(", ") || "unknown error"}`);
        }

        // Collect text content blocks from assistant turns only.
        if (anyMsg.type === "assistant") {
          const content =
            (anyMsg.message as { content?: Array<{ type: string; text?: string }> })
              ?.content ?? [];
          for (const block of content) {
            if (block.type === "text" && block.text) assistantText += block.text;
          }
        }
      }

      if (!assistantText) throw new Error("Claude side-channel query returned empty output");
      return assistantText.trim();
    } catch (err) {
      const resumeProbeTimedOut =
        resumeProbe?.signal.aborted === true && abortSignal && !abortSignal.aborted;

      // Resume hung before the pipeline timeout. Retry sessionless while budget remains.
      if (resumeProbeTimedOut && args.conversationHistory) {
        logger.info("Claude side-channel: resume probe timed out, retrying without resume", {
          threadId: args.parentThreadId,
        });
        return await this.runSideChannelQuerySessionless(
          args.conversationHistory,
          args.prompt,
          abortSignal,
          args.parentThreadId,
          args.cwd,
        );
      }

      // Detect session-not-found / expired errors. Includes the actual SDK
      // phrase "No conversation found with session ID: ..." seen in user logs.
      const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
      const isSessionMissing = /no conversation found|session not found|session expired|resume.*invalid|unknown session/.test(msg);
      if (isSessionMissing && args.conversationHistory) {
        // Sessionless fallback: retry without `resume:` using baked-in history.
        // From path B's perspective this still succeeds (ladderStep stays "B").
        logger.info("Claude side-channel: parent session unresumable, retrying without resume", {
          threadId: args.parentThreadId,
          originalError: err instanceof Error ? err.message : String(err),
        });
        return await this.runSideChannelQuerySessionless(
          args.conversationHistory,
          args.prompt,
          args.abortSignal,
          args.parentThreadId,
          args.cwd,
        );
      }
      if (isSessionMissing) {
        // No history provided: reclassify as transient so path B falls to D.
        const rethrown = new Error(
          `Parent session not resumable (likely after server restart): ${err instanceof Error ? err.message : err}`,
        ) as Error & { code: string };
        rethrown.code = "ETIMEDOUT"; // classifyProviderError maps ETIMEDOUT -> "transient"
        throw rethrown;
      }
      throw err;
    } finally {
      if (resumeProbeTimer) clearTimeout(resumeProbeTimer);
      restoreProcessEnv(backup);
    }
  }

  /**
   * Retry a side-channel query without a `resume:` session ID by baking the
   * conversation history directly into the prompt. Called automatically by
   * `runSideChannelQuery` when the parent session is unresumable and history
   * has been provided by the pipeline.
   */
  private async runSideChannelQuerySessionless(
    history: string,
    prompt: string,
    abortSignal: AbortSignal | undefined,
    parentThreadId: string,
    cwd: string,
  ): Promise<string> {
    // Prepend the prior conversation so the model has equivalent context to a
    // resumed session. The handoff request follows the separator.
    const fullPrompt = `## Prior conversation (parent thread)\n\n${history}\n\n---\n\n${prompt}`;
    // The parent session is gone so we cannot look up its original model.
    // Use the same safe default as the main path's fallback.
    const model = DEFAULT_CLAUDE_MODEL;

    const backup = snapshotProcessEnv();
    try {
      const merged = this.envService.getEnv();
      for (const [k, v] of Object.entries(merged)) {
        process.env[k] = v;
      }

      const queue = createPromptQueue();
      const ephemeralId = `side-channel-sessionless-${crypto.randomUUID()}`;

      let sdkAbortController: AbortController | undefined;
      if (abortSignal) {
        sdkAbortController = new AbortController();
        if (abortSignal.aborted) {
          sdkAbortController.abort();
        } else {
          abortSignal.addEventListener("abort", () => sdkAbortController?.abort(), { once: true });
        }
      }

      const q = sdkQuery({
        prompt: queue.iterable,
        options: {
          cwd,
          model,
          // 2 turns, same rationale as the main side-channel method above.
          maxTurns: 2,
          // No `resume:`: this is the point of the sessionless fallback.
          tools: [],
          settingSources: [],
          permissionMode: "default" as const,
          persistSession: false,
          includePartialMessages: true,
          ...(sdkAbortController ? { abortController: sdkAbortController } : {}),
        },
      });

      queue.push(toUserMessage(fullPrompt, ephemeralId));
      queue.close();

      let assistantText = "";
      for await (const msg of q) {
        const anyMsg = msg as Record<string, unknown>;
        if (anyMsg.type === "result" && anyMsg.is_error) {
          const errors = (anyMsg.errors as string[]) ?? [];
          logger.warn("Claude sessionless side-channel SDK returned is_error", {
            threadId: parentThreadId,
            sdkResultKeys: Object.keys(anyMsg),
            errorsField: errors,
            subtype: anyMsg.subtype,
          });
          throw new Error(`Claude sessionless side-channel SDK error: ${errors.join(", ") || "unknown error"}`);
        }
        if (anyMsg.type === "assistant") {
          const content =
            (anyMsg.message as { content?: Array<{ type: string; text?: string }> })
              ?.content ?? [];
          for (const block of content) {
            if (block.type === "text" && block.text) assistantText += block.text;
          }
        }
      }

      if (!assistantText) throw new Error("Claude sessionless side-channel query returned empty output");
      return assistantText.trim();
    } finally {
      restoreProcessEnv(backup);
    }
  }

  private async doSendMessage(params: {
    sessionId: string;
    message: string;
    cwd: string;
    model: string;
    fallbackModel?: string;
    resume: boolean;
    permissionMode: string;
    attachments?: AttachmentMeta[];
    reasoningLevel?: ReasoningLevel;
    orchestrationMode: OrchestrationMode;
    contextWindowMode?: ContextWindowMode;
    thinking?: boolean;
    maxBudgetUsd?: number;
    maxTurns?: number;
  }, turnExecutionId: string): Promise<void> {
    const {
      sessionId,
      message,
      cwd,
      model,
      fallbackModel,
      resume,
      permissionMode,
      attachments,
      reasoningLevel,
      orchestrationMode,
      contextWindowMode,
      thinking,
    } = params;
    const emitTurnEvent = (event: AgentEvent): void => { this.emit("event", { ...event, turnExecutionId }); };

    const existing = this.runtime.get(sessionId);
    const pendingBrowserAccess = this.pendingBrowserAccess.get(sessionId);
    const browserScope = pendingBrowserAccess?.scope;
    const browserLeaseExpired = existing?.browserLease !== undefined && existing.browserLease.expiresAt <= Date.now();
    if (browserLeaseExpired && existing?.browserLease && pendingBrowserAccess) {
      const previousLeaseId = existing.browserLease.leaseId;
      const refreshed = this.browserAutomationSessionLease.refresh(previousLeaseId);
      // Transfer lease ownership before SessionRuntime.stop invokes close.
      // close must not revoke a refreshed grant needed by replacement spawn.
      existing.browserLease = undefined;
      if (refreshed.ok) {
        if (pendingBrowserAccess.stage) {
          this.browserAutomationSessionLease.release(pendingBrowserAccess.stage.leaseId);
        }
        pendingBrowserAccess.grant = refreshed.grant;
        pendingBrowserAccess.stage = undefined;
      } else {
        this.browserAutomationSessionLease.release(previousLeaseId);
      }
    }
    const isBypass = permissionMode === "full";
    const sdkPermissionMode = isBypass
      ? ("bypassPermissions" as const)
      : ("default" as const);
    const uuid = sessionId.startsWith("mcode-")
      ? sessionId.slice(6)
      : sessionId;
    const tid = uuid;
    const resolvedCwd = cwd || process.cwd();
    const resolvedModel = model || "claude-sonnet-4-6";
    // The "[1m]" suffix is appended only when the user opted into the 1M context
    // window AND the model supports it. The SDK translates it into the
    // `context-1m-2025-08-07` beta header.
    const sdkModelSlug = resolveSdkModelSlug(resolvedModel, contextWindowMode);

    const prompt =
      attachments && attachments.length > 0
        ? await this.buildMultimodalMessage(message, attachments, sessionId)
        : toUserMessage(message, sessionId);

    // A live session whose spawn-fixed parameters (permissionMode or
    // contextWindowMode) still match the request can be reused in place: the
    // model can be hot-swapped via setModel() and the prompt pushed onto the
    // existing queue. A mismatch is detected by `isStale`, so `acquire` would
    // discard and respawn anyway; tearing it down here (with `suppressEnded`)
    // keeps the stream loop quiet and falls through to the fresh-spawn path,
    // which resumes the same conversation via the persisted sdkSessionIds entry.
    const reusable =
      existing !== undefined &&
      existing.poisoned !== true &&
      existing.permissionMode === permissionMode &&
      existing.contextWindowMode === contextWindowMode &&
      (!this.browserAutomationSessionLease.isConfigured() ||
        !browserScope ||
        (existing.workspaceId === browserScope.workspaceId &&
          existing.browserPermissionCapability === browserScope.permissionCapability &&
          !browserLeaseExpired));

    if (existing && !reusable) {
      logger.info("Session spawn parameters changed, recreating session", {
        sessionId,
        permissionMode: { from: existing.permissionMode, to: permissionMode },
        contextWindowMode: { from: existing.contextWindowMode, to: contextWindowMode },
      });
      // Suppress the teardown's Ended emit; the fresh session takes over the id.
      existing.suppressEnded = true;
      this.suppressEndedQueries.add(existing.query);
      this.suppressSessionStartHooks.add(tid);
      await this.runtime.stop(sessionId);
    }

    if (existing && reusable) {
      const pendingBrowserAccess = this.pendingBrowserAccess.get(sessionId);
      if (pendingBrowserAccess?.stage) {
        this.browserAutomationSessionLease.release(pendingBrowserAccess.stage.leaseId);
        this.pendingBrowserAccess.delete(sessionId);
      }
      this.runtime.recordUsage(sessionId);
      existing.lastUsedAt = Date.now();

      if (existing.orchestrationMode !== orchestrationMode) {
        try {
          await existing.query.applyFlagSettings({
            ultracode: orchestrationMode === "proactive",
          });
          existing.orchestrationMode = orchestrationMode;
        } catch (err) {
          logger.error("Ultracode mode change failed, recreating session", {
            sessionId,
            orchestrationMode,
            error: err instanceof Error ? err.message : String(err),
          });
          existing.suppressEnded = true;
          this.suppressEndedQueries.add(existing.query);
          this.suppressSessionStartHooks.add(tid);
          await this.runtime.stop(sessionId);
          return this.doSendMessage({ ...params, resume: false }, turnExecutionId);
        }
      }

      if (existing.model !== resolvedModel) {
        logger.info("Model changed, calling setModel()", {
          sessionId,
          model: sdkModelSlug,
        });
        try {
          // Always pass the slug (with optional [1m] suffix) to the SDK; the
          // entry stores the bare model ID so fallback detection compares
          // against the base name the SDK reports in modelUsage.
          await existing.query.setModel(sdkModelSlug);
          existing.model = resolvedModel;
        } catch (err) {
          logger.error(
            "setModel() failed, closing session for recreation",
            {
              sessionId,
              error:
                err instanceof Error ? err.message : String(err),
            },
          );
          // Respawn fresh (no resume) after a setModel failure. Suppress the
          // teardown Ended and fall through to the fresh-spawn path with a
          // resume:false stage so the new subprocess starts a clean session.
          existing.suppressEnded = true;
          this.suppressEndedQueries.add(existing.query);
          this.suppressSessionStartHooks.add(tid);
          await this.runtime.stop(sessionId);
          return this.doSendMessage({ ...params, resume: false }, turnExecutionId);
        }
      }

      try {
        existing.pushMessage(prompt, turnExecutionId);
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : String(err);
        // push() throws two distinct errors: "Prompt queue is closed" (race
        // with idle eviction / stopSession()) and "Prompt queue full" (caller
        // is pushing faster than the SDK can drain). Only the closed case
        // means the session is gone; overflow leaves the session healthy.
        const isClosed = errorMessage.includes("queue is closed");
        if (isClosed) {
          logger.error("Prompt queue push failed on existing session", {
            sessionId,
            error: errorMessage,
          });
          emitTurnEvent({
            type: AgentEventType.Error,
            threadId: tid,
            error: "Message could not be delivered: session was shutting down. Please try again.",
          } satisfies AgentEvent);
          // Drop the stale entry so the next send creates a fresh session.
          // Safe even if startStreamLoop is mid-iteration: its finally block
          // guards with `current?.query === q` before re-deleting, so a second
          // stop is a no-op and the terminal Ended event still fires via the
          // `(!current || current.query === q)` condition.
          await this.runtime.stop(sessionId);
        } else {
          // Transient overflow: surface via Error event but keep the session.
          logger.warn("Prompt queue full on existing session", {
            sessionId,
            error: errorMessage,
          });
          emitTurnEvent({
            type: AgentEventType.Error,
            threadId: tid,
            error: errorMessage,
          } satisfies AgentEvent);
        }
        throw err;
      }
      return;
    }

    const resumeId = this.sdkSessionIds.get(sessionId) ?? uuid;

    const autoCompactWindow = resolveAutoCompactWindow(contextWindowMode, resolvedModel);

    const internalMcpServer = this.threadControlMcp?.createClaudeServer(sessionId);
    const baseOptions = {
      cwd: resolvedCwd,
      // sdkModelSlug appends "[1m]" when the user opted into the 1M context window
      // and the model supports it. Plain `resolvedModel` is preserved on the
      // session entry as well so the existing-session branch can detect changes.
      model: sdkModelSlug,
      settingSources: [
        "user" as const,
        "project" as const,
        "local" as const,
      ],
      systemPrompt: {
        type: "preset" as const,
        preset: "claude_code" as const,
      },
      tools: {
        type: "preset" as const,
        preset: "claude_code" as const,
      },
      mcpServers: internalMcpServer
        ? {
            mcode_internal_thread_control: { type: "sdk" as const, instance: internalMcpServer },
          }
        : {},
      // EnterPlanMode is disallowed because Mcode controls plan entry.
      // ExitPlanMode is NOT disallowed: we intercept it in canUseTool.
      // In plan-answer mode we capture the plan; in normal mode we deny
      // it silently so the model doesn't get stuck.
      // AskUserQuestion is disallowed: no result handler here.
      disallowedTools: ["EnterPlanMode", "AskUserQuestion"],
      permissionMode: sdkPermissionMode,
      canUseTool: (async (
        toolName: string,
        input: Record<string, unknown>,
        options: Parameters<CanUseTool>[2],
      ) => {
        try {
          // ExitPlanMode: only capture the plan when the thread is in
          // plan-answer mode. In normal chat, deny silently so the model
          // doesn't get stuck calling a tool with no handler.
          if (toolName === "ExitPlanMode") {
            if (this.planAnswerThreads.has(tid)) {
              const planMd = typeof input?.plan === "string" ? input.plan.trim() : "";
              if (planMd.length > 0) {
                this.planAnswerThreads.delete(tid);
                this.emit("exit_plan_mode", {
                  threadId: tid,
                  planMarkdown: planMd,
                });
              }
              return {
                behavior: "deny" as const,
                message:
                  "The client captured your proposed plan. Stop here and wait for the user to review it.",
              };
            }
            // Not in plan mode - deny without capturing
            return {
              behavior: "deny" as const,
              message: "Plan mode is not active. Continue with the user's request normally.",
            };
          }

          // Off-band handoff (PRD #538): if the pipeline pre-granted a one-shot
          // Read of this exact path for this thread, auto-allow it without
          // prompting, bypassing permissionMode. tryConsume is path-scoped and
          // one-shot, so this never widens authority beyond the single handoff
          // doc. All other permission behaviour is unchanged.
          if (toolName === "Read") {
            const readPath = typeof input?.path === "string" ? input.path : undefined;
            if (
              readPath !== undefined &&
              this.scopedPreGrant.tryConsume({ threadId: tid, toolName: "Read", path: readPath })
            ) {
              logger.debug("canUseTool: auto-allowing pre-granted handoff Read", {
                threadId: tid,
                path: readPath,
              });
              return { behavior: "allow" as const, updatedInput: input };
            }
          }

          const requestId = crypto.randomUUID();
          logger.debug("canUseTool called", { toolName, requestId, threadId: tid });
          const decision = await new Promise<PermissionDecision>((resolve) => {
            this.pendingPermissions.set(requestId, {
              threadId: tid,
              toolName,
              input,
              title: options?.title,
              resolve,
            });
            this.emit("permission_request", {
              requestId,
              threadId: tid,
              toolName,
              input,
              title: options?.title,
            } satisfies PermissionRequest);

            // Auto-cancel if the SDK aborts the tool call (e.g. timeout).
            if (options?.signal) {
              const onAbort = () => {
                if (this.pendingPermissions.delete(requestId)) {
                  resolve("cancelled");
                  this.emit("permission_resolved", { requestId, decision: "cancelled" as const });
                }
              };
              options.signal.addEventListener("abort", onAbort, { once: true });
            }
          });
          logger.debug("canUseTool decision", { toolName, requestId, decision });
          let result;
          switch (decision) {
            case "allow":
              // updatedInput is required by the CLI's runtime Zod schema (not optional
              // despite the SDK TypeScript type). Pass the original input unchanged.
              result = {
                behavior: "allow" as const,
                updatedInput: input,
              };
              break;
            case "allow-session":
              // Use the SDK-provided suggestions. They encode the correct
              // PermissionUpdate shape for the specific tool being allowed.
              result = {
                behavior: "allow" as const,
                updatedInput: input,
                updatedPermissions: options?.suggestions,
              };
              break;
            case "deny":
            case "cancelled":
              result = {
                behavior: "deny" as const,
                message: decision === "cancelled"
                  ? "Session stopped by user"
                  : "User denied",
              };
              break;
            default:
              logger.error("canUseTool received unexpected decision", { toolName, requestId, decision });
              result = {
                behavior: "deny" as const,
                message: "Unexpected permission decision value",
              };
          }
          logger.debug("canUseTool returning", { toolName, requestId, behavior: result.behavior });
          return result;
        } catch (err) {
          logger.error("canUseTool callback threw unexpectedly", { toolName, err });
          return {
            behavior: "deny" as const,
            message: "Permission check encountered an internal error",
          };
        }
      }) satisfies CanUseTool,
      ...buildReasoningOptions(reasoningLevel, resolvedModel, thinking),
      ...(fallbackModel && { fallbackModel }),
      // SDK 0.3.x derives its auto-compaction trigger from the model's 1M
      // capability ceiling; in standard mode that means compaction never fires
      // before the 200k tier rejects the request. resolveAutoCompactWindow
      // pins the window to 200k unless the session actually runs on the 1M
      // wire tier (mode plus model support). Inline `settings` is the SDK's
      // `--settings` layer, so this takes precedence over any autoCompactWindow
      // in the user's own settings.json.
      settings: {
        ...(autoCompactWindow !== undefined && { autoCompactWindow }),
        ultracode: orchestrationMode === "proactive",
      },
      includePartialMessages: true,
      // Guardrails are fixed at session creation. If the user changes the
      // setting between turns while the session is still live in memory, the
      // original values remain in effect until the session is evicted or the
      // server restarts.
      ...(params.maxBudgetUsd != null && params.maxBudgetUsd > 0 && { maxBudgetUsd: params.maxBudgetUsd }),
      ...(params.maxTurns != null && params.maxTurns > 0 && { maxTurns: params.maxTurns }),
      hooks: {
        PostCompact: [{
          // @ts-expect-error: HookCallback accepts 3 params but we only need input
          hooks: [async (input) => {
            const { compact_summary } = (input as PostCompactHookInput);
            // Derive threadId the same way startStreamLoop does.
            const tid = sessionId.startsWith("mcode-") ? sessionId.slice(6) : sessionId;
          emitTurnEvent({
              type: AgentEventType.CompactSummary,
              threadId: tid,
              summary: compact_summary,
            } satisfies AgentEvent);
            return {};
          }],
        }],
        Stop: [{
          // @ts-expect-error: HookCallback accepts 3 params but we only need input
          hooks: [async (input) => {
            const stopInput = input as StopHookInput;
            const goal = this.goalsBySession.get(sessionId);
            // No goal set or hook is already re-prompting → allow stop. The
            // `stop_hook_active` guard prevents an infinite block loop when the
            // model insists on stopping after the first re-prompt.
            if (!goal || stopInput.stop_hook_active) {
              return {};
            }
            return {
              decision: "block" as const,
              reason:
                `Goal not yet met: "${goal.objective}". Continue working until the goal is satisfied. ` +
                `If you have satisfied it, ask the user to clear it with "/goal clear".`,
            };
          }],
        }],
      },
    };
    // Stage the per-turn payload so `spawn` can build the SDK query, start the
    // stream loop, and push this prompt as the fresh session's first turn.
    // `spawn` discriminates resume vs. fresh via these staged fields.
    const stageTurn = (doResume: boolean): void => {
      this.pendingSpawnTurns.set(sessionId, {
        turnExecutionId,
        prompt,
        resume: doResume,
        resumeId,
        uuid,
        baseOptions,
        resolvedModel,
        contextWindowMode,
        orchestrationMode,
      });
    };

    // Spawn fresh through the runtime. Resume-failure detection needs its
    // listeners registered BEFORE `acquire` runs `spawn` (which starts the
    // stream loop), otherwise a `_resumeFailed` emit could race ahead of the
    // listener attach across the `await acquire` boundary.
    const runSpawn = async (doResume: boolean): Promise<"ok" | "stopped" | "retry"> => {
      stageTurn(doResume);

      let retryPromise: Promise<boolean> | undefined;
      let resumeHandler: (() => void) | null = null;
      let doneHandler: (() => void) | null = null;
      let okHandler: (() => void) | null = null;
      const failedEvent = `_resumeFailed:${sessionId}`;
      const doneEvent = `_streamDone:${sessionId}`;
      const okEvent = `_resumeOk:${sessionId}`;
      if (doResume) {
        // Resolve true → fall back to a fresh query; false → proceed.
        // `_resumeOk` fires when the resumed turn is confirmed live (the first
        // non-result event arrived) so a SUCCESSFUL resume releases the waiter
        // immediately instead of hanging until the stream ends. `_streamDone`
        // remains a backstop for a resume turn that completes before emitting
        // any non-result event. `_resumeFailed` still drives the fallback.
        retryPromise = new Promise<boolean>((resolve) => {
          resumeHandler = () => resolve(true);
          doneHandler = () => resolve(false);
          okHandler = () => resolve(false);
          this.once(failedEvent, resumeHandler);
          this.once(doneEvent, doneHandler);
          this.once(okEvent, okHandler);
        });
      }

      const removeResumeListeners = (): void => {
        if (resumeHandler) this.removeListener(failedEvent, resumeHandler);
        if (doneHandler) this.removeListener(doneEvent, doneHandler);
        if (okHandler) this.removeListener(okEvent, okHandler);
      };

      try {
        await this.runtime.acquire({
          sessionId,
          threadId: tid,
          cwd: resolvedCwd,
          permissionMode,
          resumeFrom: doResume ? resumeId : undefined,
        });
      } catch (err) {
        removeResumeListeners();
        this.pendingSpawnTurns.delete(sessionId);
        throw err;
      }
      this.runtime.recordUsage(sessionId);

      // A stop requested while the spawn was in flight: tear it down now.
      if (this.pendingStops.delete(sessionId)) {
        logger.info("Pending stop consumed, tearing down new session", {
          sessionId,
        });
        removeResumeListeners();
        await this.runtime.stop(sessionId);
        // TurnStarted was already emitted by AgentService before calling the
        // provider, so the frontend thinks the agent is running. Emit Ended
        // to clear that state.
          emitTurnEvent({
          type: AgentEventType.Ended,
          threadId: tid,
        } satisfies AgentEvent);
        return "stopped";
      }

      if (!doResume || !retryPromise) return "ok";

      let needsRetry: boolean;
      try {
        needsRetry = await retryPromise;
      } finally {
        // Guarantee all listeners are removed regardless of how the
        // promise settled (resolve, reject, or upstream cancellation).
        removeResumeListeners();
      }

      if (!needsRetry) return "ok";

      logger.info("Resume failed, falling back to fresh query()", { sessionId });
      this.sdkSessionIds.delete(sessionId);
      // Discard the resume session so `acquire` spawns a fresh one. The failed
      // resume already suppressed its own Ended via the stream loop.
      await this.runtime.stop(sessionId);
      return "retry";
    };

    const first = await runSpawn(resume);
    if (first === "retry") {
      await runSpawn(false);
    }
  }

  /**
   * Spawns a fresh Claude SDK session for the staged turn: builds the prompt
   * queue, launches `sdkQuery` inside the env snapshot window, surfaces any new
   * child PID to the runtime (which attaches it to the Windows JobObject and
   * hard-kills it on stop — Claude's converged taskkill), starts the stream
   * loop, and pushes the first prompt.
   *
   * Returns the discovered child PIDs (Windows only; the Claude SDK does not
   * expose the subprocess PID directly, so they are recovered by diffing the
   * server's direct children across the spawn). On non-Windows the array is
   * empty and JobObject/taskkill are no-ops.
   */
  async spawn(args: SpawnArgs): Promise<SpawnResult<ClaudeSessionState>> {
    const { sessionId, cwd } = args;
    const staged = this.pendingSpawnTurns.get(sessionId);
    if (!staged) {
      throw new Error(`Claude spawn called with no staged turn for session ${sessionId}`);
    }
    this.pendingSpawnTurns.delete(sessionId);

    const {
      prompt,
      resume,
      resumeId,
      uuid,
      baseOptions,
      resolvedModel,
      contextWindowMode,
      orchestrationMode,
      turnExecutionId,
    } = staged;
    const pendingBrowserAccess = this.pendingBrowserAccess.get(sessionId);
    const browserScope = pendingBrowserAccess?.scope;
    const browserGrant = pendingBrowserAccess?.grant ??
      (pendingBrowserAccess?.stage
        ? this.browserAutomationSessionLease.issue(pendingBrowserAccess.stage)
        : null);
    if (pendingBrowserAccess?.grant && pendingBrowserAccess.stage) {
      this.browserAutomationSessionLease.release(pendingBrowserAccess.stage.leaseId);
    }
    // Capture the subprocess stderr tail so a non-zero exit (which the SDK
    // reports as a bare "process exited with code N") carries the actual CLI
    // error instead of an opaque code. Reset per spawn so a crash is never
    // attributed stale output from a prior turn on the same session.
    this.recentStderr.delete(sessionId);
    const captureStderr = (data: string): void => {
      const next = ((this.recentStderr.get(sessionId) ?? "") + data).slice(-STDERR_CAPTURE_LIMIT);
      this.recentStderr.set(sessionId, next);
    };

    const effectiveMcpServers = mergeClaudeMcpServers(
      (baseOptions.mcpServers ?? {}) as Record<string, unknown>,
      browserGrant,
    );
    const runtimeInstructions = renderMcodeInstructions(buildMcodeInstructionPlan({
      sourceThreadId: args.threadId,
      threadControlGranted: Boolean(effectiveMcpServers.mcode_internal_thread_control),
      browserAutomationGranted: Boolean(browserGrant),
    }));
    const optionsWithRuntimeInstructions = {
      ...baseOptions,
      mcpServers: effectiveMcpServers,
      systemPrompt: {
        type: "preset" as const,
        preset: "claude_code" as const,
        append: runtimeInstructions,
      },
    };
    const options = (resume
      ? { ...optionsWithRuntimeInstructions, resume: resumeId, stderr: captureStderr }
      : { ...optionsWithRuntimeInstructions, sessionId: uuid, stderr: captureStderr }) as unknown as NonNullable<Parameters<typeof sdkQuery>[0]["options"]>;

    const queue = createPromptQueue();

    logger.info("Starting query()", {
      sessionId,
      resume,
      resumeId,
      cwd,
    });

    let beforePids: Set<number> | undefined;
    if (this.jobObject.isWindowsJob) {
      try {
        const children = await listDirectChildren(process.pid);
        beforePids = new Set(children.map((c) => c.pid));
      } catch {
        // Best-effort
      }
    }

    let q: Query;
    try {
      q = this.withSdkSpawnEnv(() => sdkQuery({ prompt: queue.iterable, options }));
    } catch (error) {
      if (browserGrant) this.browserAutomationSessionLease.release(browserGrant.leaseId);
      if (pendingBrowserAccess?.stage) {
        this.browserAutomationSessionLease.release(pendingBrowserAccess.stage.leaseId);
      }
      this.pendingBrowserAccess.delete(sessionId);
      throw error;
    }
    if (pendingBrowserAccess?.grant && pendingBrowserAccess.stage) {
      this.browserAutomationSessionLease.release(pendingBrowserAccess.stage.leaseId);
    }
    this.pendingBrowserAccess.delete(sessionId);

    // Discover the newly-spawned child PID(s) so the runtime can JobObject-
    // attach and taskkill them. Mirrors the old `labelSdkSubprocess` diff, but
    // returns the PIDs to the runtime instead of attaching inline.
    let pids: number[] = [];
    if (beforePids) {
      try {
        const after = await listDirectChildren(process.pid);
        pids = after.filter((c) => !beforePids!.has(c.pid)).map((c) => c.pid);
      } catch {
        // Best-effort: process enumeration can fail transiently.
      }
    }

    const state: ClaudeSessionState = {
      sessionId,
      cwd,
      query: q,
      pushMessage: queue.push,
      closeQueue: queue.close,
      // Store the bare model ID; the [1m] suffix is only attached at the SDK
      // boundary so detectFallbackModel can compare against the dated snapshot
      // IDs the SDK reports in modelUsage.
      model: resolvedModel,
      permissionMode: args.permissionMode,
      contextWindowMode,
      orchestrationMode,
      lastUsedAt: Date.now(),
      pendingToolUses: new Set<string>(),
      hasFiredToolThisTurn: false,
      workspaceId: browserScope?.workspaceId ?? "unknown-workspace",
      browserPermissionCapability: browserScope?.permissionCapability ?? "interact",
      ...(browserGrant && {
        browserLease: {
          leaseId: browserGrant.leaseId,
          credentialId: browserGrant.credentialId,
          expiresAt: browserGrant.expiresAt,
        },
      }),
    };

    // Start the stream loop and push the first prompt. The loop is async and
    // reads `this.runtime.get(sessionId)` lazily on each SDK message; by the
    // time the first message yields, `acquire` has stored `state` in the pool
    // (the runtime stores it synchronously the moment this `spawn` resolves).
    this.startStreamLoop(sessionId, q, turnExecutionId, queue.setOnPromptConsumed);
    queue.push(prompt, turnExecutionId);

    return { state, pids };
  }

  /**
   * Eviction guard: a session is busy while a tool_use awaits its result, OR
   * while it has a pending permission request the user may still answer (the
   * user could be on another thread). Both keep the session out of idle
   * eviction regardless of how long the SDK has been quiet.
   */
  isBusy(state: ClaudeSessionState): boolean {
    if (state.pendingToolUses.size > 0) {
      logger.debug("Skipping eviction: pending tool calls", {
        sessionId: state.sessionId,
        pending: state.pendingToolUses.size,
      });
      return true;
    }
    const tid = state.sessionId.startsWith("mcode-")
      ? state.sessionId.slice(6)
      : state.sessionId;
    return [...this.pendingPermissions.values()].some((p) => p.threadId === tid);
  }

  /** Graceful protocol interrupt: close the prompt queue so the SDK iterator ends. */
  interrupt(state: ClaudeSessionState): void {
    state.closeQueue();
  }

  /** Provider teardown: close the SDK query handle. */
  async close(state: ClaudeSessionState): Promise<void> {
    if (state.browserLease) {
      this.browserAutomationSessionLease.release(state.browserLease.leaseId);
    }
    await this.threadControlMcp?.close(state.sessionId);
    state.query.close();
  }

  /**
   * A pooled session must be discarded before reuse when its spawn-fixed
   * parameters changed. permissionMode is fixed at SDK spawn (bypass vs.
   * default), and contextWindowMode is encoded into the model slug at spawn,
   * so either change forces a respawn. `doSendMessage` detects the same
   * mismatch and tears the session down explicitly (with `suppressEnded`)
   * before reaching `acquire`; this is the runtime-side backstop.
   */
  isStale(state: ClaudeSessionState, args: { cwd: string; permissionMode: string }): boolean {
    return state.permissionMode !== args.permissionMode;
  }

  /** Run the stream loop for a query, mapping SDK events to AgentEvent types. */
  private startStreamLoop(
    sessionId: string,
    q: Query,
    turnExecutionId: string,
    setOnPromptConsumed: (handler: (turnExecutionId?: string) => void) => void,
  ): void {
    const threadId = sessionId.startsWith("mcode-")
      ? sessionId.slice(6)
      : sessionId;

    (async () => {
      let currentTurnExecutionId = turnExecutionId;
      const pendingPromptExecutionIds: string[] = [];
      setOnPromptConsumed((consumedTurnExecutionId) => {
        if (consumedTurnExecutionId && consumedTurnExecutionId !== currentTurnExecutionId) {
          pendingPromptExecutionIds.push(consumedTurnExecutionId);
        }
      });
      const emitTurnEvent = (event: AgentEvent): void =>
        createTurnEventSink(this, currentTurnExecutionId)(event);
      let suppressEnded = false;
      try {
        let lastAssistantText = "";
        let sessionInitialized = false;
        /** Tracks whether the SDK has signalled compaction is active for this stream. */
        let sessionCompacting = false;
        /** Tracks the last known context window size for post-compaction estimation. */
        let lastContextWindow: number | undefined = undefined;
        /** Per-API-call input token count from the most recent stream_event message_start.
         * Consumed by the result handler to use as tokensIn on turnComplete (authoritative
         * context fill vs. the accumulated result.usage which inflates across API calls).
         * Reset to undefined after each turnComplete. */
        let lastStreamInputTokens: number | undefined = undefined;
        /** Set after a `result` (TurnComplete). When the SDK auto-resumes
         *  (e.g. ScheduleWakeup/loop), the next non-system/non-result event
         *  triggers a synthetic TurnStarted so the server and UI know a new
         *  turn has begun without going through sendMessage(). Prompt queue
         *  consumption is the only boundary that can replace the execution ID;
         *  internal result continuations stay on the current ID. */
        let awaitingResume = false;
        let resumedTurnStarted = false;

        /** Suppresses duplicate ToolUse events when the SDK emits the same id on assistant blocks and tool_use messages. */
        const emittedToolUseIds = new Set<string>();

        /**
         * Emit an Error event with a best-effort message extracted from an SDK
         * result payload. The full raw payload is logged so operators can see
         * every field the SDK sent, while the Error event stays compatible with
         * the string-shaped `error` field on AgentEvent.
         */
        const emitResultError = (anyMsg: Record<string, unknown>): void => {
          const errors = (anyMsg.errors as string[] | undefined) ?? [];
          let errorMessage: string;
          if (errors.length > 0) {
            errorMessage = errors.join(", ");
          } else if (typeof anyMsg.result === "string") {
            errorMessage = anyMsg.result;
          } else {
            try {
              errorMessage = JSON.stringify(anyMsg.result ?? anyMsg);
            } catch {
              errorMessage = "Claude SDK returned an error result";
            }
          }
          logger.error("Claude SDK result error", {
            sessionId,
            threadId,
            errors,
            subtype: anyMsg.subtype,
            payload: anyMsg,
          });
        emitTurnEvent({
            type: AgentEventType.Error,
            threadId,
            error: errorMessage || "Claude SDK returned an error result",
          } satisfies AgentEvent);
        };

        for await (const msg of q) {
          const entry = this.runtime.get(sessionId);
          if (entry) entry.lastUsedAt = Date.now();

          const anyMsg = msg as Record<string, unknown>;

          if (!sessionInitialized && anyMsg.type !== "result") {
            sessionInitialized = true;
            // A resumed session is now confirmed live (the first non-result
            // event arrived without a "No conversation found" error). Release
            // the resume waiter in `runSpawn(true)` so `sendTurn` proceeds
            // without blocking until the whole stream completes. Harmless on
            // fresh spawns: no listener is registered there.
            this.emit(`_resumeOk:${sessionId}`);
          }

          // Capture SDK session ID
          const sdkSid = anyMsg.session_id as string | undefined;
          if (
            sdkSid &&
            sessionInitialized &&
            !this.sdkSessionIds.has(sessionId)
          ) {
            this.sdkSessionIds.set(sessionId, sdkSid);
            logger.info("Captured SDK session ID", {
              sessionId,
              sdkSessionId: sdkSid,
            });
        emitTurnEvent({
              type: AgentEventType.System,
              threadId,
              subtype: "sdk_session_id:" + sdkSid,
            } satisfies AgentEvent);
          }

          // Auto-resume detection: the SDK can start a new turn without
          // going through sendMessage() (e.g. ScheduleWakeup/loop timer).
          // Emit a synthetic TurnStarted so AgentService re-adds to
          // activeSessionIds and the frontend shows the running indicator.
          let emitResumeStart = false;
          if (
            awaitingResume &&
            anyMsg.type !== "system" &&
            (anyMsg.type !== "result" || pendingPromptExecutionIds.length > 0)
          ) {
            const nextPromptExecutionId = pendingPromptExecutionIds.shift();
            if (nextPromptExecutionId) {
              awaitingResume = false;
              currentTurnExecutionId = nextPromptExecutionId;
              resumedTurnStarted = true;
              emitResumeStart = true;
            } else if (!resumedTurnStarted) {
              resumedTurnStarted = true;
              emitResumeStart = true;
            }
          }
          if (emitResumeStart) {
            emitTurnEvent({
              type: AgentEventType.TurnStarted,
              threadId,
            } satisfies AgentEvent);
          }

          // Detect failed resume
          if (
            anyMsg.type === "result" &&
            anyMsg.is_error === true &&
            !sessionInitialized
          ) {
            const errors = anyMsg.errors as string[] | undefined;
            const isNoConversation = errors?.some(
              (e) =>
                typeof e === "string" &&
                e.includes("No conversation found"),
            );
            if (isNoConversation) {
              logger.warn(
                "Resume failed: conversation not found, will retry with fresh query()",
                { sessionId },
              );
              this.sdkSessionIds.delete(sessionId);
        emitTurnEvent({
                type: AgentEventType.System,
                threadId,
                subtype: "session_restarted",
              } satisfies AgentEvent);
              this.emit(`_resumeFailed:${sessionId}`);
              suppressEnded = true;
              return;
            }
          }

          switch (anyMsg.type) {
            case "assistant": {
              const innerMessage = anyMsg.message as {
                content?: Array<Record<string, unknown>>;
                stop_reason?: string | null;
              } | undefined;
              const contentBlocks = innerMessage?.content ?? [];
              const text = contentBlocks
                .filter((b) => b.type === "text")
                .map((b) => (b.text as string) ?? "")
                .join("");

              if (text && text !== lastAssistantText) {
                lastAssistantText = text;
              }

              // Anthropic message-level stop_reason is the authoritative
              // discriminator between thoughts and final response text.
              // {end_turn, stop_sequence, max_tokens} → final response
              // {tool_use, pause_turn, null, anything else} → preamble/thought
              // Only emit a boundary when this message actually carried text;
              // pure tool-call messages have no streamed deltas to reclassify.
              if (text.length > 0) {
                const stopReason = innerMessage?.stop_reason ?? null;
                const isFinalResponse =
                  stopReason === "end_turn" ||
                  stopReason === "stop_sequence" ||
                  stopReason === "max_tokens";
        emitTurnEvent({
                  type: AgentEventType.AssistantMessageBoundary,
                  threadId,
                  isFinalResponse,
                } satisfies AgentEvent);
              }

              // Read parent_tool_use_id from the SDK message top-level.
              // When subagents run in parallel, this is the ONLY reliable way
              // to determine which Agent owns a given child tool call - the
              // server-side agentCallStack approach fails for parallel dispatch
              // because LIFO returns only the most recent Agent.
              // Treat empty string the same as null/undefined: an empty parent id
              // would otherwise be stored as a truthy value and break nesting
              // (build-narrative.ts groups by parentToolCallId, and "" never matches
              // an Agent id, so children get silently dropped from the tree).
              const sdkParentRaw = anyMsg.parent_tool_use_id as string | null | undefined;
              const sdkParentToolUseId =
                typeof sdkParentRaw === "string" && sdkParentRaw.length > 0
                  ? sdkParentRaw
                  : undefined;

              for (const block of contentBlocks) {
                if (block.type === "tool_use") {
                  const toolId = (block.id as string) || "";
                  if (toolId && emittedToolUseIds.has(toolId)) {
                    continue;
                  }
                  if (toolId) {
                    emittedToolUseIds.add(toolId);
                    const entry = this.runtime.get(sessionId);
                    if (entry) {
                      entry.pendingToolUses.add(toolId);
                      entry.hasFiredToolThisTurn = true;
                    }
                  }
                  const toolName = (block.name as string) || "unknown";
                  logger.debug("Claude ToolUse from assistant block", {
                    toolId, toolName, parent_tool_use_id: sdkParentToolUseId ?? null,
                  });
        emitTurnEvent({
                    type: AgentEventType.ToolUse,
                    threadId,
                    toolCallId: toolId,
                    toolName,
                    toolInput:
                      (block.input as Record<
                        string,
                        unknown
                      >) || {},
                    parentToolCallId: sdkParentToolUseId,
                  } satisfies AgentEvent);
                }
              }
              break;
            }

            case "result": {
              if (anyMsg.is_error === true) {
                // Poison-pill recovery: an unmodifiable-thinking-block 400 means
                // this session's stored transcript can never be resumed again.
                // Abandon the session (forget the resume id, mark the live entry
                // poisoned so it is not reused, and tell AgentService to clear
                // the persisted sdk_session_id) so the next send starts fresh,
                // instead of looping the same 400 forever.
                if (isUnrecoverableThinkingBlockError(anyMsg.result)) {
                  logger.warn("Claude session poisoned by unmodifiable thinking block; abandoning session", {
                    sessionId,
                    threadId,
                  });
                  this.sdkSessionIds.delete(sessionId);
                  const poisonedEntry = this.runtime.get(sessionId);
                  if (poisonedEntry) poisonedEntry.poisoned = true;
                  // Surface the reset as a quiet system-message hairline in the
                  // transcript (handled client-side), not a red error card. The
                  // same event also clears the persisted sdk_session_id server-side.
        emitTurnEvent({
                    type: AgentEventType.System,
                    threadId,
                    subtype: "sdk_session_invalidated",
                  } satisfies AgentEvent);
                  lastAssistantText = "";
                  lastStreamInputTokens = undefined;
                  awaitingResume = false;
                  resumedTurnStarted = false;
                  break;
                }
                // The "No conversation found" resume-recovery branch above
                // handles its own flow and returns early; any other is_error
                // result lands here and must be surfaced as an Error event
                // rather than silently completing the turn.
                emitResultError(anyMsg);
                lastAssistantText = "";
                lastStreamInputTokens = undefined;
                awaitingResume = false;
                resumedTurnStarted = false;
                break;
              }
              const nativeGoalResult = parseClaudeGoalCommandResult(lastAssistantText, anyMsg);
              if (nativeGoalResult) {
                this.applyNativeGoalCommandResult(sessionId, nativeGoalResult);
              }
              if (lastAssistantText) {
        emitTurnEvent({
                  type: AgentEventType.Message,
                  threadId,
                  content: lastAssistantText,
                  tokens:
                    (
                      anyMsg.usage as {
                        output_tokens?: number;
                      }
                    )?.output_tokens ?? null,
                } satisfies AgentEvent);
              }

              // Detect if the SDK used a fallback model. Guard on entry?.model
              // to avoid a spurious event if the session was evicted mid-stream.
              const requestedModel = entry?.model;
              if (requestedModel) {
                const usedFallback = detectFallbackModel(
                  (anyMsg.modelUsage as Record<string, unknown>) ?? {},
                  requestedModel,
                );
                if (usedFallback) {
        emitTurnEvent({
                    type: AgentEventType.ModelFallback,
                    threadId,
                    requestedModel,
                    actualModel: usedFallback,
                  } satisfies AgentEvent);
                }
              }

              // Extract the authoritative context window from SDK modelUsage.
              // modelUsage is Record<modelId, { contextWindow?: number, ... }>.
              // SDK 0.3.x reports the model's 1M capability ceiling here even
              // when the session runs on the standard 200k tier, so clamp to
              // the window mode the subprocess was actually spawned with.
              const sdkModelUsage = (anyMsg.modelUsage ?? {}) as Record<
                string,
                { contextWindow?: number }
              >;
              const sdkContextWindow = clampContextWindowToMode(
                Object.values(sdkModelUsage).find(
                  (u) =>
                    typeof u.contextWindow === "number" &&
                    Number.isFinite(u.contextWindow),
                )?.contextWindow,
                entry?.contextWindowMode,
                entry?.model,
              );

              const usage = (anyMsg.usage ?? {}) as {
                input_tokens?: number;
                output_tokens?: number;
                cache_read_input_tokens?: number;
                cache_creation_input_tokens?: number;
              };

              // Accumulated total tokens processed across all API calls this session.
              // result.usage is accumulated (like total_cost_usd and num_turns),
              // so this already includes all previous API calls in the turn.
              const totalProcessedTokens =
                (usage.input_tokens ?? 0) +
                (usage.cache_read_input_tokens ?? 0) +
                (usage.cache_creation_input_tokens ?? 0) +
                (usage.output_tokens ?? 0);

              // Current context fill: prefer the last stream_event message_start
              // usage (per-API-call, authoritative). Fall back to a heuristic
              // from result.usage only if stream events were not captured.
              const tokensIn = lastStreamInputTokens ?? (
                (usage.input_tokens ?? 0) +
                (usage.cache_read_input_tokens ?? 0) +
                (usage.cache_creation_input_tokens ?? 0)
              );

              this.lastSessionCostUsd = (anyMsg.total_cost_usd as number) ?? undefined;
              this.lastNumTurns = (anyMsg.num_turns as number) ?? undefined;
              this.lastDurationMs = (anyMsg.duration_ms as number) ?? undefined;
              const resultUsage = (anyMsg.usage ?? {}) as { service_tier?: string };
              const rawTier = resultUsage.service_tier;
              this.lastServiceTier = (rawTier === "standard" || rawTier === "priority" || rawTier === "batch")
                ? rawTier
                : undefined;

        emitTurnEvent({
                type: AgentEventType.TurnComplete,
                threadId,
                reason:
                  (anyMsg.stop_reason as string) ||
                  (anyMsg.subtype as string) ||
                  "end_turn",
                costUsd:
                  (anyMsg.total_cost_usd as number) ?? null,
                tokensIn,
                tokensOut: usage.output_tokens ?? 0,
                contextWindow: sdkContextWindow,
                totalProcessedTokens,
                cacheReadTokens: usage.cache_read_input_tokens ?? undefined,
                cacheWriteTokens: usage.cache_creation_input_tokens ?? undefined,
                providerId: "claude",
              } satisfies AgentEvent);

              // Invalidate the usage cache so the warm-refresh call from the
              // client picks up fresh plan utilization after this turn.
              this.usageSource.invalidate();
              const billingMode = await this.resolveBillingMode();
        emitTurnEvent({
                type: AgentEventType.QuotaUpdate,
                threadId,
                providerId: "claude",
                categories: [],
                billingMode,
                sessionCostUsd: this.lastSessionCostUsd,
                serviceTier: this.lastServiceTier,
                numTurns: this.lastNumTurns,
                durationMs: this.lastDurationMs,
              } satisfies AgentEvent);

              lastContextWindow = sdkContextWindow;
              // Reset for next turn
              lastStreamInputTokens = undefined;

              lastAssistantText = "";
              awaitingResume = true;
              resumedTurnStarted = false;
              // Keep `hasFiredToolThisTurn` for the lifetime of this `sendMessage`
              // query. The SDK emits `result` between internal API rounds while the
              // same user turn continues; clearing the flag there made every
              // post-`result` textDelta look like pre-tool preamble so
              // `isFinalResponse` never fired and the reply duplicated THOUGHT rows.
              break;
            }

            case "system": {
              if ((anyMsg.subtype as string) === "init") {
                const slashCommands = anyMsg.slash_commands;
                if (Array.isArray(slashCommands)) {
                  this.observeNativeGoalCommands(
                    sessionId,
                    slashCommands,
                    anyMsg.claude_code_version,
                  );
                }
              // subtype 'status' carries the SDK's compaction state.
              // Only emit a compacting event on known transitions to avoid
              // spurious "active: false" from unrelated status strings (e.g.
              // "idle", "ready") that the SDK may send during session lifecycle.
              } else if ((anyMsg.subtype as string) === "status") {
                const sdkStatus = (anyMsg as { status?: string | null }).status;
                if (sdkStatus === "compacting" && !sessionCompacting) {
                  sessionCompacting = true;
        emitTurnEvent({
                    type: AgentEventType.Compacting,
                    threadId,
                    active: true,
                  } satisfies AgentEvent);
                } else if (sdkStatus !== "compacting" && sessionCompacting) {
                  sessionCompacting = false;
        emitTurnEvent({
                    type: AgentEventType.Compacting,
                    threadId,
                    active: false,
                  } satisfies AgentEvent);
                  // Ring hides during compaction (lastTokensIn: 0 sentinel).
                  // It stays hidden until the next authoritative turnComplete
                  // or stream_event message_start provides real usage data.
                }
              } else if ((anyMsg.subtype as string) === "compact_boundary") {
                const metadata = (anyMsg as { compact_metadata?: { pre_tokens?: number; trigger?: string } }).compact_metadata;
                if (metadata) {
                  logger.info("Compact boundary received", {
                    threadId,
                    preTokens: metadata.pre_tokens,
                    trigger: metadata.trigger,
                  });
                }
              } else if ((anyMsg.subtype as string) === "api_retry") {
        emitTurnEvent({
                  type: AgentEventType.ApiRetry,
                  threadId,
                  reason: (anyMsg.error as string) || "unknown",
                  attempt: anyMsg.attempt as number | undefined,
                  maxRetries: anyMsg.max_retries as number | undefined,
                  delayMs: anyMsg.retry_delay_ms as number | undefined,
                  errorStatus: (anyMsg.error_status as number | undefined) ?? undefined,
                } satisfies AgentEvent);
              } else if ((anyMsg.subtype as string) === "hook_started") {
                const hookName = (anyMsg.hook_name as string) || "unknown";
                if (
                  hookName.startsWith("SessionStart") &&
                  this.suppressSessionStartHooks.has(threadId)
                ) {
                  break;
                }
        emitTurnEvent({
                  type: AgentEventType.HookStarted,
                  threadId,
                  hookName,
                  hookType: anyMsg.tool_name ? "permission" : "stop",
                  ...(anyMsg.tool_name ? { toolName: anyMsg.tool_name as string } : {}),
                } satisfies AgentEvent);
              } else if ((anyMsg.subtype as string) === "hook_progress") {
        emitTurnEvent({
                  type: AgentEventType.HookProgress,
                  threadId,
                  hookName: (anyMsg.hook_name as string) || "unknown",
                  output: (anyMsg.output as string) || "",
                } satisfies AgentEvent);
              } else if ((anyMsg.subtype as string) === "hook_response") {
                const hookName = (anyMsg.hook_name as string) || "unknown";
                if (
                  hookName.startsWith("SessionStart") &&
                  this.suppressSessionStartHooks.has(threadId)
                ) {
                  this.suppressSessionStartHooks.delete(threadId);
                  break;
                }
        emitTurnEvent({
                  type: AgentEventType.HookCompleted,
                  threadId,
                  hookName,
                  exitCode: (anyMsg.exit_code as number) ?? 1,
                  durationMs: (anyMsg.duration_ms as number) ?? 0,
                  didBlock: (anyMsg.did_block as boolean) ?? false,
                } satisfies AgentEvent);
              } else {
        emitTurnEvent({
                  type: AgentEventType.System,
                  threadId,
                  subtype: (anyMsg.subtype as string) || "unknown",
                } satisfies AgentEvent);
              }
              break;
            }

            case "tool_use": {
              const toolId = (anyMsg.id as string) || "";
              if (toolId && emittedToolUseIds.has(toolId)) {
                break;
              }
              if (toolId) {
                emittedToolUseIds.add(toolId);
                const entry = this.runtime.get(sessionId);
                if (entry) {
                  entry.pendingToolUses.add(toolId);
                  entry.hasFiredToolThisTurn = true;
                }
              }
              // See sdkParentToolUseId above: empty string breaks nesting.
              const parentRaw = anyMsg.parent_tool_use_id as string | null | undefined;
              const parentToolCallId =
                typeof parentRaw === "string" && parentRaw.length > 0
                  ? parentRaw
                  : undefined;
              const toolName =
                (anyMsg.tool_name as string) ||
                (anyMsg.name as string) ||
                "unknown";
              logger.debug("Claude ToolUse from tool_use message", {
                toolId, toolName, parent_tool_use_id: parentToolCallId ?? null,
              });
        emitTurnEvent({
                type: AgentEventType.ToolUse,
                threadId,
                toolCallId: toolId,
                toolName,
                toolInput:
                  (anyMsg.tool_input as Record<
                    string,
                    unknown
                  >) ||
                  (anyMsg.input as Record<
                    string,
                    unknown
                  >) ||
                  {},
                parentToolCallId,
              } satisfies AgentEvent);
              break;
            }

            case "tool_result": {
              const toolUseId = (anyMsg.tool_use_id as string) || "";
              const content = anyMsg.content;
        emitTurnEvent({
                type: AgentEventType.ToolResult,
                threadId,
                toolCallId: toolUseId,
                output:
                  typeof content === "string"
                    ? content
                    : JSON.stringify(content ?? ""),
                isError: Boolean(anyMsg.is_error),
              } satisfies AgentEvent);
              if (toolUseId) {
                const entry = this.runtime.get(sessionId);
                entry?.pendingToolUses.delete(toolUseId);
              }
              break;
            }

            case "stream_event": {
              const streamEvent = anyMsg.event as {
                type?: string;
                delta?: { type?: string; text?: string; partial_json?: string };
                message?: {
                  usage?: {
                    input_tokens?: number;
                    cache_read_input_tokens?: number;
                    cache_creation_input_tokens?: number;
                  };
                };
              };
              if (streamEvent?.type === "message_start" && streamEvent.message?.usage) {
                const u = streamEvent.message.usage;
                lastStreamInputTokens =
                  (u.input_tokens ?? 0) +
                  (u.cache_read_input_tokens ?? 0) +
                  (u.cache_creation_input_tokens ?? 0);

                // Emit mid-turn context estimate so the ring updates on each API call.
                // contextWindow is undefined on the very first API call of a session
                // because lastContextWindow is only populated after the first result.
                // contextEstimate.contextWindow is optional and consumers handle undefined
                // gracefully via their own lastContextWindowByThread map.
                if (lastStreamInputTokens > 0) {
        emitTurnEvent({
                    type: AgentEventType.ContextEstimate,
                    threadId,
                    tokensIn: lastStreamInputTokens,
                    contextWindow: lastContextWindow,
                  } satisfies AgentEvent);
                }
              }
              if (streamEvent?.type === "content_block_delta") {
                if (
                  streamEvent.delta?.type === "text_delta" &&
                  typeof streamEvent.delta.text === "string" &&
                  streamEvent.delta.text
                ) {
                  // Determine whether this delta is part of the final user-facing
                  // response. The condition holds when all tool calls have resolved
                  // (pendingToolUses empty) AND at least one tool has fired this
                  // turn — distinguishing post-tool final-response text from
                  // pre-tool preamble, both of which have pendingToolUses===0.
                  const sessionEntry = this.runtime.get(sessionId);
                  const isFinalResponse =
                    sessionEntry !== undefined &&
                    sessionEntry.pendingToolUses.size === 0 &&
                    sessionEntry.hasFiredToolThisTurn === true;
        emitTurnEvent({
                    type: AgentEventType.TextDelta,
                    threadId,
                    delta: streamEvent.delta.text,
                    ...(isFinalResponse && { isFinalResponse: true }),
                  } satisfies AgentEvent);
                } else if (
                  streamEvent.delta?.type === "input_json_delta" &&
                  typeof streamEvent.delta.partial_json === "string" &&
                  streamEvent.delta.partial_json
                ) {
        emitTurnEvent({
                    type: AgentEventType.ToolInputDelta,
                    threadId,
                    partialJson: streamEvent.delta.partial_json,
                  } satisfies AgentEvent);
                }
              }
              break;
            }

            case "tool_progress": {
              const toolUseId = (anyMsg.tool_use_id as string | undefined) ?? "";
              const toolName = (anyMsg.tool_name as string | undefined) ?? "unknown";
              const elapsedSeconds = (anyMsg.elapsed_time_seconds as number | undefined) ?? 0;
              if (toolUseId) {
        emitTurnEvent({
                  type: AgentEventType.ToolProgress,
                  threadId,
                  toolCallId: toolUseId,
                  toolName,
                  elapsedSeconds,
                } satisfies AgentEvent);
              }
              break;
            }

            case "rate_limit_event": {
              const info = anyMsg.rate_limit_info as {
                status?: string;
                resetsAt?: number;
                rateLimitType?: string;
                utilization?: number;
              } | undefined;
              const status = info?.status;

              // Only surface warnings and rejections; 'allowed' is noise
              if (status === "allowed_warning" || status === "rejected") {
                const retryAfterMs = info?.resetsAt
                  ? Math.max(0, info.resetsAt * 1000 - Date.now())
                  : undefined;
        emitTurnEvent({
                  type: AgentEventType.RateLimited,
                  threadId,
                  active: true,
                  retryAfterMs,
                  limitType: info?.rateLimitType,
                  utilization: info?.utilization,
                } satisfies AgentEvent);
              } else if (status === "allowed") {
                // Clear any previously active rate limit indicator
        emitTurnEvent({
                  type: AgentEventType.RateLimited,
                  threadId,
                  active: false,
                } satisfies AgentEvent);
              }
              break;
            }
          }
        }
      } catch (e: unknown) {
        const errorMessage =
          e instanceof Error ? e.message : String(e);
        // Gate the Error event with the same "still the active stream" check
        // as the Ended event below. When a session is intentionally torn down
        // (mode change, setModel failure) the Claude CLI subprocess exits
        // non-zero after its stdin is closed, which propagates here as a
        // thrown exit error. That exit is expected, not a user-visible crash,
        // because a fresh session has already taken over the sessionId.
        const current = this.runtime.get(sessionId);
        const superseded =
          (current !== undefined && current.query !== q) ||
          current?.suppressEnded === true;
        // The SDK's process-exit error omits stderr; attach the captured tail
        // so "process exited with code 1" becomes actionable.
        const stderrTail = this.recentStderr.get(sessionId)?.trim();
        if (superseded) {
          logger.debug("SDK stream error suppressed (session superseded)", {
            sessionId,
            error: errorMessage,
          });
        } else {
          logger.error("SDK stream error", {
            sessionId,
            error: errorMessage,
            ...(stderrTail ? { stderr: stderrTail } : {}),
          });
        emitTurnEvent({
            type: AgentEventType.Error,
            threadId,
            error: stderrTail
              ? `${errorMessage}\n\nClaude Code stderr (tail):\n${stderrTail}`
              : errorMessage,
          } satisfies AgentEvent);
        }
      } finally {
        this.recentStderr.delete(sessionId);
        const wasSuppressedQuery = this.suppressEndedQueries.has(q);
        this.suppressEndedQueries.delete(q);
        const current = this.runtime.get(sessionId);
        const superseded = current !== undefined && current.query !== q;
        if (current?.query === q) {
          // The SDK subprocess has exited; drop the dead session from the pool.
          // `runtime.stop` also best-effort taskkills the (already-gone) PIDs,
          // which is harmless. Fire-and-forget: the stream loop is unwinding.
          void this.runtime.stop(sessionId);
          // Clear any stale SessionStart suppression: if the recreated session
          // had a SessionStart hook it already self-cleared on hook_response; if
          // it had none, the flag would otherwise outlive this pooled session and
          // suppress a legitimately-configured SessionStart on the next resume.
          this.suppressSessionStartHooks.delete(threadId);
        }
        logger.info("Session stream ended", { sessionId });
        this.emit(`_streamDone:${sessionId}`);
        if (
          !suppressEnded &&
          !wasSuppressedQuery &&
          !superseded &&
          !current?.suppressEnded &&
          (!current || current.query === q)
        ) {
        emitTurnEvent({
            type: AgentEventType.Ended,
            threadId,
          } satisfies AgentEvent);
        }
      }
    })();
  }

  /** Build a multimodal SDKUserMessage from text and attachments. */
  private async buildMultimodalMessage(
    message: string,
    attachments: AttachmentMeta[],
    sessionId: string,
  ): Promise<SDKUserMessage> {
    const contentBlocks: Array<Record<string, unknown>> = [];

    for (const att of attachments) {
      if (isVirtualBrowserContextAttachment(att.mimeType)) continue;
      try {
        const data = await readFile(att.sourcePath);

        if (att.mimeType.startsWith("image/")) {
          contentBlocks.push({
            type: "image",
            source: {
              type: "base64",
              media_type: att.mimeType,
              data: data.toString("base64"),
            },
          });
        } else if (att.mimeType === "application/pdf") {
          contentBlocks.push({
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: data.toString("base64"),
            },
          });
        } else if (att.mimeType === "text/plain") {
          contentBlocks.push({
            type: "document",
            source: {
              type: "text",
              media_type: "text/plain",
              data: data.toString("utf-8"),
            },
          });
        }
      } catch (err) {
        const errMsg =
          err instanceof Error ? err.message : String(err);
        logger.error("Failed to read attachment", {
          id: att.id,
          path: att.sourcePath,
          error: errMsg,
        });
        contentBlocks.push({
          type: "text",
          text: `[Attachment failed to load: ${att.name} - ${errMsg}]`,
        });
      }
    }

    if (message.trim().length > 0) {
      contentBlocks.push({ type: "text", text: message });
    }

    return {
      type: "user" as const,
      message: {
        role: "user" as const,
        content:
          contentBlocks as unknown as SDKUserMessage["message"]["content"],
      },
      parent_tool_use_id: null,
      session_id: sessionId,
    };
  }

  /** Return whether native Claude Code `/goal` has been proven for this session. */
  hasNativeGoalCommand(sessionId: string): boolean {
    return this.nativeGoalSupportBySession.get(sessionId) === "supported";
  }

  /** Records Claude Code slash-command availability observed from `system/init`. */
  observeNativeGoalCommands(
    sessionId: string,
    slashCommands: readonly unknown[],
    claudeCodeVersion?: unknown,
  ): void {
    const supported = slashCommands.includes("goal");
    this.nativeGoalSupportBySession.set(
      sessionId,
      supported ? "supported" : "unsupported",
    );
    logger.debug("Claude native goal support observed", {
      sessionId,
      supported,
      claudeCodeVersion,
    });
  }

  /** Mark the native `/goal` command unavailable after Claude reports it disabled. */
  private markNativeGoalUnavailable(sessionId: string): void {
    this.nativeGoalSupportBySession.set(sessionId, "unsupported");
    this.nativeGoalsBySession.delete(sessionId);
  }

  /** Install a local mirror for a native Claude Code goal command already dispatched. */
  setNativeGoalMirror(sessionId: string, condition: string): GoalState {
    const now = Date.now();
    const existing = this.nativeGoalsBySession.get(sessionId);
    const entry: ClaudeGoalEntry = {
      objective: condition,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.nativeGoalsBySession.set(sessionId, entry);
    return this.toGoalState(sessionId, entry);
  }

  /** Clear the local mirror for a native Claude Code goal command. */
  clearNativeGoalMirror(sessionId: string): boolean {
    return this.nativeGoalsBySession.delete(sessionId);
  }

  /** Apply a fail-closed native `/goal` parse result to the in-memory mirror. */
  private applyNativeGoalCommandResult(
    sessionId: string,
    result: NonNullable<ReturnType<typeof parseClaudeGoalCommandResult>>,
  ): void {
    if (result.kind === "unavailable") {
      this.markNativeGoalUnavailable(sessionId);
      this.emit(`_nativeGoalCommandResult:${sessionId}`, result);
      return;
    }
    if (result.kind === "active") {
      this.setNativeGoalMirror(sessionId, result.objective);
      this.emit(`_nativeGoalCommandResult:${sessionId}`, result);
      return;
    }
    if (result.kind === "cleared" || result.kind === "empty") {
      this.nativeGoalsBySession.delete(sessionId);
    }
    this.emit(`_nativeGoalCommandResult:${sessionId}`, result);
  }

  /** Dispatch a native `/goal` command into an idle Claude session and wait for its proven command result. */
  async runNativeGoalCommand(
    sessionId: string,
    command: "/goal" | "/goal off",
    timeoutMs = 20_000,
  ): Promise<NonNullable<ReturnType<typeof parseClaudeGoalCommandResult>> | null> {
    const entry = this.runtime.get(sessionId);
    if (
      !entry ||
      this.nativeGoalSupportBySession.get(sessionId) !== "supported" ||
      this.isBusy(entry)
    ) {
      return null;
    }

    const eventName = `_nativeGoalCommandResult:${sessionId}`;
    const current = this.runtime.get(sessionId);
    if (!current || current !== entry || this.isBusy(current)) {
      return null;
    }
    const resultPromise = new Promise<NonNullable<ReturnType<typeof parseClaudeGoalCommandResult>> | null>((resolve) => {
      let settled = false;
      const done = (result: NonNullable<ReturnType<typeof parseClaudeGoalCommandResult>> | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.removeListener(eventName, onResult);
        resolve(result);
      };
      const onResult = (result: NonNullable<ReturnType<typeof parseClaudeGoalCommandResult>>) => done(result);
      const timer = setTimeout(() => done(null), timeoutMs);
      this.once(eventName, onResult);
    });

    entry.pushMessage(toUserMessage(command, sessionId));
    return resultPromise;
  }

  /**
   * Install a Claude-wrapper goal. Claude can enforce a stop gate, but native
   * `/goal` sessions keep their own mirror and bypass this Stop hook state.
   */
  setGoal(sessionId: string, condition: string): GoalState {
    const now = Date.now();
    const existing = this.goalsBySession.get(sessionId);
    const entry: ClaudeGoalEntry = {
      objective: condition,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.goalsBySession.set(sessionId, entry);
    return this.toGoalState(sessionId, entry);
  }

  /** Remove an active Claude-wrapper goal. */
  clearGoal(sessionId: string): boolean {
    return this.goalsBySession.delete(sessionId);
  }

  /** Return the active Claude-wrapper goal state for a session, or undefined. */
  getGoal(sessionId: string): GoalState | undefined {
    const entry = this.nativeGoalsBySession.get(sessionId) ?? this.goalsBySession.get(sessionId);
    return entry ? this.toGoalState(sessionId, entry) : undefined;
  }

  /** Return non-authoritative Claude-wrapper goal lookup metadata. */
  getGoalLookup(sessionId: string): GoalLookupResult {
    const nativeGoal = this.nativeGoalsBySession.get(sessionId);
    if (nativeGoal) {
      return {
        goal: this.toGoalState(sessionId, nativeGoal),
        authoritative: false,
        source: "claude-cache",
      };
    }
    const goal = this.goalsBySession.get(sessionId);
    return {
      goal: goal ? this.toGoalState(sessionId, goal) : null,
      authoritative: false,
      source: "claude-wrapper",
      ...(goal ? {} : { reason: "missing" }),
    };
  }

  /** Convert internal Claude goal metadata into the provider-neutral state. */
  private toGoalState(sessionId: string, entry: ClaudeGoalEntry): GoalState {
    const now = Date.now();
    return {
      threadId: sessionId.startsWith("mcode-") ? sessionId.slice(6) : sessionId,
      objective: entry.objective,
      status: "active",
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: Math.max(0, Math.floor((now - entry.createdAt) / 1000)),
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      providerId: "claude",
      source: "claude",
      controls: {
        canInspect: true,
        canClear: true,
      },
    };
  }

  /** Abort a running session, or record a pending stop if the session hasn't been created yet. */
  async stopSession(sessionId: string): Promise<void> {
    // Normalize to the raw UUID that canUseTool stores as threadId.
    const tid = sessionId.startsWith("mcode-") ? sessionId.slice(6) : sessionId;
    // Reject all pending permission requests for this session and notify frontend.
    for (const [requestId, entry] of this.pendingPermissions) {
      if (entry.threadId === tid) {
        this.pendingPermissions.delete(requestId);
        entry.resolve("cancelled");
        this.emit("permission_resolved", { requestId, decision: "cancelled" });
      }
    }
    this.goalsBySession.delete(sessionId);
    this.nativeGoalsBySession.delete(sessionId);
    const entry = this.runtime.get(sessionId);
    if (entry) {
      // The runtime's stop runs interrupt (closeQueue) → close (query.close) →
      // hard taskkill of the spawned PID.
      await this.runtime.stop(sessionId);
    } else {
      // Session not yet created (sendMessage still in flight). Record the
      // stop so doSendMessage tears the session down immediately after
      // creation, preventing the agent from ever starting.
      this.pendingStops.add(sessionId);
      // Auto-expire after 10s in case the send never arrives (network
      // error, client disconnect, etc.) so the set doesn't leak.
      setTimeout(() => this.pendingStops.delete(sessionId), 10_000);
    }
  }

  /**
   * Force-discard the pooled session so the next sendTurn spawns fresh. Pure
   * pool eviction via the runtime's `stop` (interrupt → close → hard kill); it
   * deliberately leaves goals and pending permissions intact, since the caller
   * retries the same turn on a new session.
   */
  async discardSession(sessionId: string): Promise<void> {
    if (this.runtime.get(sessionId) === undefined) return;
    await this.runtime.stop(sessionId);
  }

  /**
   * Stop a session and wait for the underlying subprocess to exit.
   * Resolves when the stream loop emits _streamDone or when the timeout
   * elapses — whichever comes first. Safe to call if the session does not
   * exist (resolves immediately). The once-listener is always cleaned up,
   * even on timeout, to prevent EventEmitter listener accumulation.
   */
  async waitForSessionExit(sessionId: string, timeoutMs = 5000): Promise<void> {
    // Register the listener BEFORE checking sessions so we never miss an
    // event that fires between the check and the once() call.
    await new Promise<void>((resolve) => {
      let settled = false;

      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.removeListener(`_streamDone:${sessionId}`, done);
        resolve();
      };

      const timer = setTimeout(done, timeoutMs);
      this.once(`_streamDone:${sessionId}`, done);

      const entry = this.runtime.get(sessionId);
      if (!entry) {
        // No active session — resolve immediately without waiting.
        done();
        return;
      }

      // Stop through the runtime (interrupt → close → taskkill). The interrupt
      // closes the prompt queue, ending the SDK iterator, so the stream loop's
      // finally emits `_streamDone`, which resolves the wait above.
      void this.runtime.stop(sessionId).catch((err: unknown) => {
        logger.warn("Claude waitForSessionExit stop failed", { sessionId, error: String(err) });
      });
    });
  }

  /** Returns Claude plan utilization plus accumulated session stats. */
  async getUsage(): Promise<ProviderUsageInfo> {
    let categories: QuotaCategory[] | null = null;
    const billingMode = await this.resolveBillingMode();
    try {
      categories = await this.usageSource.fetch();
    } catch (error) {
      logger.warn("Failed to fetch Claude usage categories", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const hasThreadMetrics =
      this.lastSessionCostUsd !== undefined ||
      this.lastServiceTier !== undefined ||
      this.lastNumTurns !== undefined ||
      this.lastDurationMs !== undefined;
    if (categories === null && !hasThreadMetrics) {
      throw new Error("Claude usage source unavailable");
    }
    return {
      providerId: "claude",
      quotaCategories: categories ?? [],
      billingMode,
      sessionCostUsd: this.lastSessionCostUsd,
      serviceTier: this.lastServiceTier,
      numTurns: this.lastNumTurns,
      durationMs: this.lastDurationMs,
    };
  }

  /** Resolves Claude's provider-owned billing mode without exposing credentials. */
  private async resolveBillingMode(): Promise<ProviderBillingMode> {
    if (await this.oauthUsageSource.isAvailable()) return "plan";
    if (Number.isFinite(this.lastSessionCostUsd)) return "api_key";
    return "unknown";
  }

  /** Fetch available Claude models from the Anthropic REST API. */
  async listModels(): Promise<ProviderModelInfo[]> {
    return listClaudeModels();
  }

  /** Resolves a pending permission request by ID. Deletes the entry before calling resolve to prevent re-entrant calls. Returns false if the requestId is unknown. */
  resolvePermission(requestId: string, decision: PermissionDecision): boolean {
    const entry = this.pendingPermissions.get(requestId);
    if (!entry) {
      logger.warn("resolvePermission: requestId not found in pendingPermissions", { requestId, decision, mapSize: this.pendingPermissions.size });
      return false;
    }
    logger.debug("resolvePermission", { requestId, decision, toolName: entry.toolName });
    this.pendingPermissions.delete(requestId);

    // Reset the session's idle timer so the 10-minute eviction clock starts
    // from the moment the user responds, not from when the request was sent.
    const sessionId = `mcode-${entry.threadId}`;
    const session = this.runtime.get(sessionId);
    if (session) session.lastUsedAt = Date.now();

    entry.resolve(decision);
    this.emit("permission_resolved", { requestId, decision });
    return true;
  }

  /** Returns all pending permission requests for the given thread, including tool input and optional title for display. Used by the frontend to re-hydrate cards after a WebSocket reconnect. */
  listPendingPermissions(threadId: string): PermissionRequest[] {
    const results: PermissionRequest[] = [];
    for (const [requestId, entry] of this.pendingPermissions) {
      if (entry.threadId === threadId) {
        results.push({
          requestId,
          threadId: entry.threadId,
          toolName: entry.toolName,
          input: entry.input,
          title: entry.title,
        });
      }
    }
    return results;
  }

  /**
   * Toggle plan-answer mode for a thread. When enabled, the canUseTool
   * callback captures ExitPlanMode calls instead of denying them.
   * When disabled (or after capture), the model's ExitPlanMode calls
   * are denied silently.
   *
   * Off-interface (like setGoal/clearGoal): no longer an IAgentProvider member;
   * AgentService invokes it on the concrete ClaudeProvider via a cast. The
   * question-vs-answer plan distinction cannot be carried by the binary
   * TurnRequest.interactionMode, so this Claude-only arming stays explicit.
   */
  setPlanAnswerMode(threadId: string, enabled: boolean): void {
    if (enabled) {
      this.planAnswerThreads.add(threadId);
    } else {
      this.planAnswerThreads.delete(threadId);
    }
  }

  /** Tear down all sessions and release resources. */
  shutdown(): void {
    // Drain all pending permission requests so their promises settle. Do this
    // before the runtime stops sessions so any in-flight canUseTool awaits
    // unblock and the SDK iterators can wind down cleanly.
    for (const [requestId, entry] of this.pendingPermissions) {
      this.pendingPermissions.delete(requestId);
      entry.resolve("cancelled");
      this.emit("permission_resolved", { requestId, decision: "cancelled" as const });
    }
    // The runtime stops every session (interrupt → close → taskkill) and
    // clears its eviction timer. Fire-and-forget: shutdown is synchronous and
    // the provider-owned maps below are cleared immediately.
    void this.runtime.shutdown().catch((err: unknown) => {
      logger.warn("Claude runtime shutdown failed", { error: String(err) });
    });
    this.pendingSpawnTurns.clear();
    this.pendingBrowserAccess.clear();
    this.sdkSessionIds.clear();
    this.goalsBySession.clear();
    this.nativeGoalsBySession.clear();
    this.nativeGoalSupportBySession.clear();
    logger.info("ClaudeProvider shutdown complete");
  }
}
