/**
 * Claude Agent SDK provider adapter.
 * Implements IAgentProvider using the v1 query() API with a prompt queue pattern.
 * Migrated from apps/desktop/src/main/sidecar/client.ts.
 */

import { injectable, inject } from "tsyringe";
import * as NodeEvents from "node:events";
import * as NodeFSPromises from "node:fs/promises";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type {
  Query,
  SDKUserMessage,
  PostCompactHookInput,
  StopHookInput,
  CanUseTool,
} from "@anthropic-ai/claude-agent-sdk";
import { logger } from "@mcode/shared";
import {
  AgentEventType,
  isVirtualBrowserContextAttachment,
  providerRuntimeEvent,
} from "@mcode/contracts";
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
import { listClaudeModels } from "./list-models.js";
import { resolveSdkModelSlug } from "./resolve-slug.js";
import { resolveAutoCompactWindow } from "./context-window.js";
import { readAnthropicOauthToken } from "@mcode/shared/usage";
import { AnthropicOAuthUsageSource } from "./usage/oauth-usage-source.js";
import { AnthropicHeaderUsageSource } from "./usage/header-usage-source.js";
import { CompositeUsageSource } from "./usage/composite-usage-source.js";
import { EnvService } from "../../../../runtime/environment/env-service.js";
import { JobObject } from "../../../../runtime/process/containment/job-object.js";
import { ScopedPreGrantService } from "../../../agents/permissions/scoped-pre-grant.js";
import { SessionRuntime } from "../../runtime/session-runtime.js";
import { InternalThreadControlMcpRuntime } from "../../../thread-control/index.js";
import {
  buildMcodeInstructionPlan,
  renderMcodeInstructions,
} from "@mcode/thread-orchestration";

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
import type {
  ProtocolAdapter,
  SpawnArgs,
  SpawnResult,
} from "../../runtime/session-runtime.js";
import { listDirectChildren } from "../../../../runtime/process/containment/process-kill.js";
import { CleanForker } from "../../../handoff/index.js";
import {
  browserAutomationPermissionCapability,
  BrowserAutomationSessionLease,
  type BrowserAutomationSessionLeaseGrant,
  type BrowserAutomationSessionLeaseScope,
  type BrowserAutomationSessionLeaseStage,
} from "../../../browser-automation/index.js";
import type { SessionForker } from "@mcode/contracts";
import type { ProviderHostPorts } from "@mcode/providers";
import type { ProviderIdentity } from "@mcode/contracts";
import { parseClaudeGoalCommandResult } from "./claude-goal-command-parser.js";
import {
  collectCompletionText,
  collectSideChannelText,
} from "./claude-query-output.js";
import {
  ClaudeEventMapper,
  type ClaudeEventMapperCallbacks,
  type ClaudeUsageMetrics,
} from "./claude-event-mapper.js";
import {
  ClaudeCanonicalEventPublisher,
  type ClaudeCanonicalEventRouting,
} from "./claude-canonical-event-publisher.js";

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
  browserLease?: Pick<
    BrowserAutomationSessionLeaseGrant,
    "leaseId" | "credentialId" | "expiresAt"
  >;
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
  const pending: Array<{ message: SDKUserMessage; turnExecutionId?: string }> =
    [];
  let waiting: ((result: IteratorResult<SDKUserMessage>) => void) | null = null;
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

  const setOnPromptConsumed = (
    handler: (turnExecutionId?: string) => void,
  ): void => {
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
export function isUnrecoverableThinkingBlockError(
  resultText: unknown,
): boolean {
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

interface ClaudeSideChannelRequest {
  parentThreadId: string;
  parentSdkSessionId: string;
  prompt: string;
  abortSignal?: AbortSignal;
  conversationHistory?: string;
  cwd: string;
}

interface ClaudeResumeProbe {
  signal: AbortSignal | undefined;
  dispose(): void;
}

interface ClaudeSendMessageParams {
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
}

interface ClaudeTurnContext {
  params: ClaudeSendMessageParams;
  routing: ClaudeCanonicalEventRouting;
  prompt: SDKUserMessage;
  threadId: string;
  cwd: string;
  model: string;
  sdkModelSlug: string;
}

interface ClaudeBrowserReuseState {
  scope: BrowserAutomationSessionLeaseScope | undefined;
  leaseExpired: boolean;
}

type ClaudeReuseOutcome = "spawn" | "handled" | "retry_fresh";
type ClaudeToolPermissionResult = Awaited<ReturnType<CanUseTool>>;

interface ClaudeResumeWaiter {
  retry: Promise<boolean> | undefined;
  dispose(): void;
}

type ClaudeSpawnOutcome = "ok" | "stopped" | "retry";
type ClaudeSdkQueryOptions = NonNullable<
  Parameters<typeof sdkQuery>[0]["options"]
>;

interface ClaudeSpawnBrowserAccess {
  pending: PendingBrowserAccess | undefined;
  scope: BrowserAutomationSessionLeaseScope | undefined;
  grant: BrowserAutomationSessionLeaseGrant | null;
}

interface ClaudeStreamLoopState {
  currentTurnExecutionId: string;
  pendingPromptExecutionIds: string[];
  sessionInitialized: boolean;
  awaitingResume: boolean;
  resumedTurnStarted: boolean;
  suppressEnded: boolean;
  mapper: ClaudeEventMapper;
}

/** Claude Agent SDK adapter implementing IAgentProvider with prompt queue pattern. */
@injectable()
export class ClaudeProvider
  extends NodeEvents.EventEmitter
  implements
    IAgentProvider,
    IGoalCapable,
    ISessionEvictable,
    ProtocolAdapter<ClaudeSessionState>
{
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
  /** Canonical routing retained while the SDK keeps a pooled stream alive. */
  private canonicalRoutings:
    Map<string, ClaudeCanonicalEventRouting> | undefined;
  /** Serializes canonical event submission when the adapter runs in the server composition. */
  private readonly canonicalEventPublisher:
    ClaudeCanonicalEventPublisher | undefined;
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
  private nativeGoalSupportBySession = new Map<
    string,
    ClaudeNativeGoalSupport
  >();
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
  private readonly oauthUsageSource = new AnthropicOAuthUsageSource(
    () => readAnthropicOauthToken(this.requireHostRuntime().platform),
  );
  private readonly usageSource: CompositeUsageSource = new CompositeUsageSource(
    [this.oauthUsageSource, new AnthropicHeaderUsageSource()],
  );

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
    @inject("ProviderHostPorts")
    private readonly host?: Pick<ProviderHostPorts, "runtime" | "events">,
  ) {
    super();
    this.canonicalEventPublisher = this.host
      ? new ClaudeCanonicalEventPublisher(this.host.events)
      : undefined;
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
    const routing = this.rememberCanonicalRouting(req);
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
      this.browserAutomationSessionLease.release(
        previousBrowserAccess.stage.leaseId,
      );
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
      await this.doSendMessage(params, routing);
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
          this.browserAutomationSessionLease.release(
            pendingBrowserAccess.grant.leaseId,
          );
        }
        if (pendingBrowserAccess.stage) {
          this.browserAutomationSessionLease.release(
            pendingBrowserAccess.stage.leaseId,
          );
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
  async complete(
    prompt: string,
    model: string,
    cwd: string,
    options: CompletionOptions = {},
  ): Promise<string> {
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
          systemPrompt:
            "Respond with exactly what is requested. No questions, no commentary.",
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

      return await collectCompletionText(q);
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
  async runSideChannelQuery(args: ClaudeSideChannelRequest): Promise<string> {
    const { parentSdkSessionId, prompt, abortSignal, cwd } = args;

    // Resolve model from the parent thread's active session if available,
    // falling back to the default claude-sonnet model.
    const parentSessionId = `mcode-${args.parentThreadId}`;
    const parentSession = this.runtime.get(parentSessionId);

    // Path B-prime: after a server restart (or when the user forks without
    // sending a new message on the parent), the SDK subprocess is not running
    // even though sdk_session_id is still in SQLite. Resume on a cold subprocess
    // often hangs until the pipeline abort fires, leaving no time for the
    // sessionless retry. Skip resume and bake message history into the prompt.
    if (!parentSession && args.conversationHistory) {
      logger.info(
        "Claude side-channel: no live parent session, using sessionless path B-prime",
        {
          threadId: args.parentThreadId,
        },
      );
      return await this.runSideChannelQuerySessionless(
        args.conversationHistory,
        prompt,
        abortSignal,
        args.parentThreadId,
        cwd,
      );
    }

    const model = parentSession?.model ?? DEFAULT_CLAUDE_MODEL;

    const backup = snapshotProcessEnv();
    // Cap resume attempts so a hung subprocess does not consume the full
    // pipeline timeout before sessionless path B-prime can run.
    const resumeProbe = this.createSideChannelResumeProbe(
      args.conversationHistory,
      abortSignal,
    );

    try {
      this.applySdkEnvironment();

      const queue = createPromptQueue();
      const ephemeralId = `side-channel-${crypto.randomUUID()}`;

      const sdkAbortController = this.createSdkAbortController(
        resumeProbe.signal ?? abortSignal,
      );

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
          ...(sdkAbortController
            ? { abortController: sdkAbortController }
            : {}),
        },
      });

      queue.push(toUserMessage(prompt, ephemeralId));
      // Close immediately after pushing so the SDK subprocess exits after the
      // single turn instead of blocking waiting for more input.
      queue.close();

      return await collectSideChannelText(
        q,
        this.sideChannelOutputOptions(args.parentThreadId, false),
      );
    } catch (err) {
      return await this.handleResumedSideChannelError(
        args,
        resumeProbe.signal,
        err,
      );
    } finally {
      resumeProbe.dispose();
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
      this.applySdkEnvironment();

      const queue = createPromptQueue();
      const ephemeralId = `side-channel-sessionless-${crypto.randomUUID()}`;

      const sdkAbortController = this.createSdkAbortController(abortSignal);

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
          ...(sdkAbortController
            ? { abortController: sdkAbortController }
            : {}),
        },
      });

      queue.push(toUserMessage(fullPrompt, ephemeralId));
      queue.close();

      return await collectSideChannelText(
        q,
        this.sideChannelOutputOptions(parentThreadId, true),
      );
    } finally {
      restoreProcessEnv(backup);
    }
  }

  private applySdkEnvironment(): void {
    for (const [key, value] of Object.entries(this.envService.getEnv())) {
      process.env[key] = value;
    }
  }

  private createSideChannelResumeProbe(
    history: string | undefined,
    abortSignal: AbortSignal | undefined,
  ): ClaudeResumeProbe {
    if (!history) return { signal: undefined, dispose: () => undefined };
    const controller = new AbortController();
    if (!abortSignal || abortSignal.aborted)
      return { signal: controller.signal, dispose: () => undefined };
    const timer = setTimeout(
      () => controller.abort(),
      SIDE_CHANNEL_RESUME_PROBE_MS,
    );
    abortSignal.addEventListener("abort", () => controller.abort(), {
      once: true,
    });
    return { signal: controller.signal, dispose: () => clearTimeout(timer) };
  }

  private createSdkAbortController(
    abortSignal: AbortSignal | undefined,
  ): AbortController | undefined {
    if (!abortSignal) return undefined;
    const controller = new AbortController();
    if (abortSignal.aborted) controller.abort();
    else
      abortSignal.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
    return controller;
  }

  private sideChannelOutputOptions(
    parentThreadId: string,
    sessionless: boolean,
  ) {
    return sessionless
      ? {
          errorPrefix: "Claude sessionless side-channel SDK",
          emptyMessage:
            "Claude sessionless side-channel query returned empty output",
          onResultError: (output: Record<string, unknown>) =>
            this.logSideChannelResultError(parentThreadId, output, true),
        }
      : {
          errorPrefix: "Claude side-channel query SDK",
          emptyMessage: "Claude side-channel query returned empty output",
          onResultError: (output: Record<string, unknown>) =>
            this.logSideChannelResultError(parentThreadId, output, false),
        };
  }

  private logSideChannelResultError(
    parentThreadId: string,
    output: Record<string, unknown>,
    sessionless: boolean,
  ): void {
    const errors = Array.isArray(output.errors) ? output.errors : [];
    const details = {
      threadId: parentThreadId,
      sdkResultKeys: Object.keys(output),
      errorsField: errors,
      subtype: output.subtype,
    };
    if (sessionless) {
      logger.warn(
        "Claude sessionless side-channel SDK returned is_error",
        details,
      );
      return;
    }
    logger.warn("Claude side-channel SDK returned is_error", {
      ...details,
      durationMs: output.duration_ms,
      rawResult: output,
    });
  }

  private async handleResumedSideChannelError(
    args: ClaudeSideChannelRequest,
    resumeProbeSignal: AbortSignal | undefined,
    error: unknown,
  ): Promise<string> {
    if (this.didResumeProbeTimeout(args, resumeProbeSignal)) {
      logger.info(
        "Claude side-channel: resume probe timed out, retrying without resume",
        { threadId: args.parentThreadId },
      );
      return await this.runSideChannelQuerySessionless(
        args.conversationHistory!,
        args.prompt,
        args.abortSignal,
        args.parentThreadId,
        args.cwd,
      );
    }
    if (!isUnresumableSideChannelError(error)) throw error;
    if (args.conversationHistory) {
      logger.info(
        "Claude side-channel: parent session unresumable, retrying without resume",
        {
          threadId: args.parentThreadId,
          originalError: sideChannelErrorMessage(error),
        },
      );
      return await this.runSideChannelQuerySessionless(
        args.conversationHistory,
        args.prompt,
        args.abortSignal,
        args.parentThreadId,
        args.cwd,
      );
    }
    throw transientSideChannelResumeError(error);
  }

  private didResumeProbeTimeout(
    args: ClaudeSideChannelRequest,
    resumeProbeSignal: AbortSignal | undefined,
  ): boolean {
    return (
      resumeProbeSignal?.aborted === true &&
      args.abortSignal !== undefined &&
      !args.abortSignal.aborted &&
      args.conversationHistory !== undefined
    );
  }

  private createCanUseTool(threadId: string): CanUseTool {
    return async (toolName, input, options) => {
      try {
        const planExit = this.handleExitPlanMode(threadId, toolName, input);
        if (planExit) return planExit;
        const preGrant = this.consumeScopedReadGrant(threadId, toolName, input);
        if (preGrant) return preGrant;
        return await this.requestClaudeToolPermission(
          threadId,
          toolName,
          input,
          options,
        );
      } catch (error) {
        logger.error("canUseTool callback threw unexpectedly", {
          toolName,
          error,
        });
        return {
          behavior: "deny" as const,
          message: "Permission check encountered an internal error",
        };
      }
    };
  }

  private handleExitPlanMode(
    threadId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): ClaudeToolPermissionResult | undefined {
    if (toolName !== "ExitPlanMode") return undefined;
    if (!this.planAnswerThreads.has(threadId)) {
      return {
        behavior: "deny" as const,
        message:
          "Plan mode is not active. Continue with the user's request normally.",
      };
    }
    const planMarkdown =
      typeof input.plan === "string" ? input.plan.trim() : "";
    if (planMarkdown) {
      this.planAnswerThreads.delete(threadId);
      this.emit("exit_plan_mode", { threadId, planMarkdown });
    }
    return {
      behavior: "deny" as const,
      message:
        "The client captured your proposed plan. Stop here and wait for the user to review it.",
    };
  }

  private consumeScopedReadGrant(
    threadId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): ClaudeToolPermissionResult | undefined {
    if (toolName !== "Read" || typeof input.path !== "string") return undefined;
    if (
      !this.scopedPreGrant.tryConsume({
        threadId,
        toolName: "Read",
        path: input.path,
      })
    )
      return undefined;
    logger.debug("canUseTool: auto-allowing pre-granted handoff Read", {
      threadId,
      path: input.path,
    });
    return { behavior: "allow" as const, updatedInput: input };
  }

  private async requestClaudeToolPermission(
    threadId: string,
    toolName: string,
    input: Record<string, unknown>,
    options: Parameters<CanUseTool>[2],
  ): Promise<ClaudeToolPermissionResult> {
    const requestId = crypto.randomUUID();
    logger.debug("canUseTool called", { toolName, requestId, threadId });
    const decision = await this.waitForClaudePermission(
      requestId,
      threadId,
      toolName,
      input,
      options,
    );
    logger.debug("canUseTool decision", { toolName, requestId, decision });
    const result = this.toClaudePermissionResult(
      decision,
      input,
      options,
      toolName,
      requestId,
    );
    logger.debug("canUseTool returning", {
      toolName,
      requestId,
      behavior: result?.behavior,
    });
    return result;
  }

  private waitForClaudePermission(
    requestId: string,
    threadId: string,
    toolName: string,
    input: Record<string, unknown>,
    options: Parameters<CanUseTool>[2],
  ): Promise<PermissionDecision> {
    return new Promise((resolve) => {
      this.pendingPermissions.set(requestId, {
        threadId,
        toolName,
        input,
        title: options?.title,
        resolve,
      });
      this.emit("permission_request", {
        requestId,
        threadId,
        toolName,
        input,
        title: options?.title,
      } satisfies PermissionRequest);
      options?.signal?.addEventListener(
        "abort",
        () => this.cancelClaudePermission(requestId, resolve),
        { once: true },
      );
    });
  }

  private cancelClaudePermission(
    requestId: string,
    resolve: (decision: PermissionDecision) => void,
  ): void {
    if (!this.pendingPermissions.delete(requestId)) return;
    resolve("cancelled");
    this.emit("permission_resolved", {
      requestId,
      decision: "cancelled" as const,
    });
  }

  private toClaudePermissionResult(
    decision: PermissionDecision,
    input: Record<string, unknown>,
    options: Parameters<CanUseTool>[2],
    toolName: string,
    requestId: string,
  ): ClaudeToolPermissionResult {
    switch (decision) {
      case "allow":
        return { behavior: "allow" as const, updatedInput: input };
      case "allow-session":
        return {
          behavior: "allow" as const,
          updatedInput: input,
          updatedPermissions: options?.suggestions,
        };
      case "deny":
        return { behavior: "deny" as const, message: "User denied" };
      case "cancelled":
        return {
          behavior: "deny" as const,
          message: "Session stopped by user",
        };
      default:
        logger.error("canUseTool received unexpected decision", {
          toolName,
          requestId,
          decision,
        });
        return {
          behavior: "deny" as const,
          message: "Unexpected permission decision value",
        };
    }
  }

  private prepareClaudeBrowserReuseState(
    sessionId: string,
    existing: ClaudeSessionState | undefined,
  ): ClaudeBrowserReuseState {
    const pendingBrowserAccess = this.pendingBrowserAccess.get(sessionId);
    const leaseExpired =
      existing?.browserLease !== undefined &&
      existing.browserLease.expiresAt <= Date.now();
    if (!leaseExpired || !existing?.browserLease || !pendingBrowserAccess) {
      return { scope: pendingBrowserAccess?.scope, leaseExpired };
    }
    const previousLeaseId = existing.browserLease.leaseId;
    const refreshed =
      this.browserAutomationSessionLease.refresh(previousLeaseId);
    existing.browserLease = undefined;
    if (refreshed.ok) {
      if (pendingBrowserAccess.stage)
        this.browserAutomationSessionLease.release(
          pendingBrowserAccess.stage.leaseId,
        );
      pendingBrowserAccess.grant = refreshed.grant;
      pendingBrowserAccess.stage = undefined;
    } else {
      this.browserAutomationSessionLease.release(previousLeaseId);
    }
    return { scope: pendingBrowserAccess.scope, leaseExpired };
  }

  private async createClaudePrompt(
    message: string,
    attachments: AttachmentMeta[] | undefined,
    sessionId: string,
  ): Promise<SDKUserMessage> {
    if (attachments?.length)
      return await this.buildMultimodalMessage(message, attachments, sessionId);
    return toUserMessage(message, sessionId);
  }

  private createClaudeTurnContext(
    params: ClaudeSendMessageParams,
    routing: ClaudeCanonicalEventRouting,
    prompt: SDKUserMessage,
    threadId: string,
    cwd: string,
    model: string,
    sdkModelSlug: string,
  ): ClaudeTurnContext {
    return { params, routing, prompt, threadId, cwd, model, sdkModelSlug };
  }

  private async tryReuseClaudeSession(
    context: ClaudeTurnContext,
    existing: ClaudeSessionState | undefined,
    browser: ClaudeBrowserReuseState,
  ): Promise<ClaudeReuseOutcome> {
    if (!existing) return "spawn";
    if (!this.isReusableClaudeSession(existing, context, browser)) {
      this.logClaudeSessionRecreation(context, existing);
      await this.stopClaudeSessionForRecreation(
        context.params.sessionId,
        context.threadId,
        existing,
      );
      return "spawn";
    }
    this.releasePendingBrowserStage(context.params.sessionId);
    this.markClaudeSessionUsed(context.params.sessionId, existing);
    if (!(await this.reconfigureReusableClaudeSession(context, existing)))
      return "retry_fresh";
    await this.pushClaudeMessage(existing, context);
    return "handled";
  }

  private isReusableClaudeSession(
    existing: ClaudeSessionState,
    context: ClaudeTurnContext,
    browser: ClaudeBrowserReuseState,
  ): boolean {
    return (
      existing.poisoned !== true &&
      existing.permissionMode === context.params.permissionMode &&
      existing.contextWindowMode === context.params.contextWindowMode &&
      this.matchesClaudeBrowserScope(existing, browser)
    );
  }

  private matchesClaudeBrowserScope(
    existing: ClaudeSessionState,
    browser: ClaudeBrowserReuseState,
  ): boolean {
    if (!this.browserAutomationSessionLease.isConfigured() || !browser.scope)
      return true;
    return (
      existing.workspaceId === browser.scope.workspaceId &&
      existing.browserPermissionCapability ===
        browser.scope.permissionCapability &&
      !browser.leaseExpired
    );
  }

  private logClaudeSessionRecreation(
    context: ClaudeTurnContext,
    existing: ClaudeSessionState,
  ): void {
    logger.info("Session spawn parameters changed, recreating session", {
      sessionId: context.params.sessionId,
      permissionMode: {
        from: existing.permissionMode,
        to: context.params.permissionMode,
      },
      contextWindowMode: {
        from: existing.contextWindowMode,
        to: context.params.contextWindowMode,
      },
    });
  }

  private releasePendingBrowserStage(sessionId: string): void {
    const pendingBrowserAccess = this.pendingBrowserAccess.get(sessionId);
    if (!pendingBrowserAccess?.stage) return;
    this.browserAutomationSessionLease.release(
      pendingBrowserAccess.stage.leaseId,
    );
    this.pendingBrowserAccess.delete(sessionId);
  }

  private async reconfigureReusableClaudeSession(
    context: ClaudeTurnContext,
    existing: ClaudeSessionState,
  ): Promise<boolean> {
    if (!(await this.updateClaudeOrchestrationMode(context, existing)))
      return false;
    return await this.updateClaudeSessionModel(context, existing);
  }

  private async updateClaudeOrchestrationMode(
    context: ClaudeTurnContext,
    existing: ClaudeSessionState,
  ): Promise<boolean> {
    if (existing.orchestrationMode === context.params.orchestrationMode)
      return true;
    try {
      await existing.query.applyFlagSettings({
        ultracode: context.params.orchestrationMode === "proactive",
      });
      existing.orchestrationMode = context.params.orchestrationMode;
      return true;
    } catch (error) {
      logger.error("Ultracode mode change failed, recreating session", {
        sessionId: context.params.sessionId,
        orchestrationMode: context.params.orchestrationMode,
        error: sideChannelErrorMessage(error),
      });
      await this.stopClaudeSessionForRecreation(
        context.params.sessionId,
        context.threadId,
        existing,
      );
      return false;
    }
  }

  private async updateClaudeSessionModel(
    context: ClaudeTurnContext,
    existing: ClaudeSessionState,
  ): Promise<boolean> {
    if (existing.model === context.model) return true;
    logger.info("Model changed, calling setModel()", {
      sessionId: context.params.sessionId,
      model: context.sdkModelSlug,
    });
    try {
      await existing.query.setModel(context.sdkModelSlug);
      existing.model = context.model;
      return true;
    } catch (error) {
      logger.error("setModel() failed, closing session for recreation", {
        sessionId: context.params.sessionId,
        error: sideChannelErrorMessage(error),
      });
      await this.stopClaudeSessionForRecreation(
        context.params.sessionId,
        context.threadId,
        existing,
      );
      return false;
    }
  }

  private async stopClaudeSessionForRecreation(
    sessionId: string,
    threadId: string,
    existing: ClaudeSessionState,
  ): Promise<void> {
    existing.suppressEnded = true;
    this.suppressEndedQueries.add(existing.query);
    this.suppressSessionStartHooks.add(threadId);
    await this.runtime.stop(sessionId);
  }

  private markClaudeSessionUsed(
    sessionId: string,
    existing: ClaudeSessionState,
  ): void {
    this.runtime.recordUsage(sessionId);
    existing.lastUsedAt = Date.now();
  }

  private async pushClaudeMessage(
    existing: ClaudeSessionState,
    context: ClaudeTurnContext,
  ): Promise<void> {
    try {
      existing.pushMessage(context.prompt, context.routing.executionId);
    } catch (error) {
      await this.handleClaudePushError(context, error);
    }
  }

  private async handleClaudePushError(
    context: ClaudeTurnContext,
    error: unknown,
  ): Promise<never> {
    const errorMessage = sideChannelErrorMessage(error);
    if (errorMessage.includes("queue is closed")) {
      logger.error("Prompt queue push failed on existing session", {
        sessionId: context.params.sessionId,
        error: errorMessage,
      });
      this.publishTurnEvent(context.routing, context.params.sessionId, {
        type: AgentEventType.Error,
        threadId: context.threadId,
        error:
          "Message could not be delivered: session was shutting down. Please try again.",
      } satisfies AgentEvent);
      await this.runtime.stop(context.params.sessionId);
    } else {
      logger.warn("Prompt queue full on existing session", {
        sessionId: context.params.sessionId,
        error: errorMessage,
      });
      this.publishTurnEvent(context.routing, context.params.sessionId, {
        type: AgentEventType.Error,
        threadId: context.threadId,
        error: errorMessage,
      } satisfies AgentEvent);
    }
    throw error;
  }

  private createClaudeBaseOptions(
    context: ClaudeTurnContext,
    permissionMode: "bypassPermissions" | "default",
  ): Record<string, unknown> {
    const internalMcpServer = this.threadControlMcp?.createClaudeServer(
      context.params.sessionId,
    );
    const autoCompactWindow = resolveAutoCompactWindow(
      context.params.contextWindowMode,
      context.model,
    );
    return {
      cwd: context.cwd,
      model: context.sdkModelSlug,
      settingSources: ["user", "project", "local"],
      systemPrompt: { type: "preset", preset: "claude_code" },
      tools: { type: "preset", preset: "claude_code" },
      mcpServers: internalMcpServer
        ? {
            mcode_internal_thread_control: {
              type: "sdk",
              instance: internalMcpServer,
            },
          }
        : {},
      disallowedTools: ["EnterPlanMode", "AskUserQuestion"],
      permissionMode,
      canUseTool: this.createCanUseTool(context.threadId),
      ...buildReasoningOptions(
        context.params.reasoningLevel,
        context.model,
        context.params.thinking,
      ),
      ...(context.params.fallbackModel && {
        fallbackModel: context.params.fallbackModel,
      }),
      settings: {
        ...(autoCompactWindow !== undefined && { autoCompactWindow }),
        ultracode: context.params.orchestrationMode === "proactive",
      },
      includePartialMessages: true,
      ...(context.params.maxBudgetUsd != null &&
        context.params.maxBudgetUsd > 0 && {
          maxBudgetUsd: context.params.maxBudgetUsd,
        }),
      ...(context.params.maxTurns != null &&
        context.params.maxTurns > 0 && { maxTurns: context.params.maxTurns }),
      hooks: this.createClaudeHooks(context),
    };
  }

  private createClaudeHooks(context: ClaudeTurnContext) {
    return {
      PostCompact: [{ hooks: [this.createPostCompactHook(context)] }],
      Stop: [{ hooks: [this.createGoalStopHook(context)] }],
    };
  }

  private createPostCompactHook(context: ClaudeTurnContext) {
    return async (input: unknown) => {
      const { compact_summary } = input as PostCompactHookInput;
      this.publishTurnEvent(context.routing, context.params.sessionId, {
        type: AgentEventType.CompactSummary,
        threadId: context.threadId,
        summary: compact_summary,
      } satisfies AgentEvent);
      return {};
    };
  }

  private createGoalStopHook(context: ClaudeTurnContext) {
    return async (input: unknown) => {
      const stopInput = input as StopHookInput;
      const goal = this.goalsBySession.get(context.params.sessionId);
      if (!goal || stopInput.stop_hook_active) return {};
      return {
        decision: "block" as const,
        reason: `Goal not yet met: "${goal.objective}". Continue working until the goal is satisfied. If you have satisfied it, ask the user to clear it with "/goal clear".`,
      };
    };
  }

  private stageClaudeTurn(
    context: ClaudeTurnContext,
    baseOptions: Record<string, unknown>,
    resumeId: string,
    resume: boolean,
  ): void {
    this.pendingSpawnTurns.set(context.params.sessionId, {
      turnExecutionId: context.routing.executionId,
      prompt: context.prompt,
      resume,
      resumeId,
      uuid: context.threadId,
      baseOptions,
      resolvedModel: context.model,
      contextWindowMode: context.params.contextWindowMode,
      orchestrationMode: context.params.orchestrationMode,
    });
  }

  private async spawnClaudeTurn(
    context: ClaudeTurnContext,
    baseOptions: Record<string, unknown>,
    resumeId: string,
  ): Promise<void> {
    const first = await this.runClaudeSpawn(
      context,
      baseOptions,
      resumeId,
      context.params.resume,
    );
    if (first === "retry")
      await this.runClaudeSpawn(context, baseOptions, resumeId, false);
  }

  private async runClaudeSpawn(
    context: ClaudeTurnContext,
    baseOptions: Record<string, unknown>,
    resumeId: string,
    resume: boolean,
  ): Promise<ClaudeSpawnOutcome> {
    this.stageClaudeTurn(context, baseOptions, resumeId, resume);
    const resumeWaiter = this.waitForClaudeResume(
      context.params.sessionId,
      resume,
    );
    try {
      await this.runtime.acquire({
        sessionId: context.params.sessionId,
        threadId: context.threadId,
        cwd: context.cwd,
        permissionMode: context.params.permissionMode,
        resumeFrom: resume ? resumeId : undefined,
      });
    } catch (error) {
      resumeWaiter.dispose();
      this.pendingSpawnTurns.delete(context.params.sessionId);
      throw error;
    }
    this.runtime.recordUsage(context.params.sessionId);
    if (await this.stopPendingClaudeSpawn(context, resumeWaiter)) {
      return "stopped";
    }
    return await this.finishClaudeSpawn(context, resumeWaiter);
  }

  private waitForClaudeResume(
    sessionId: string,
    resume: boolean,
  ): ClaudeResumeWaiter {
    if (!resume) return { retry: undefined, dispose: () => undefined };
    const failedEvent = `_resumeFailed:${sessionId}`;
    const doneEvent = `_streamDone:${sessionId}`;
    const okEvent = `_resumeOk:${sessionId}`;
    const handlers: { failed: () => void; done: () => void; ok: () => void } = {
      failed: () => undefined,
      done: () => undefined,
      ok: () => undefined,
    };
    const retry = new Promise<boolean>((resolve) => {
      handlers.failed = () => resolve(true);
      handlers.done = () => resolve(false);
      handlers.ok = () => resolve(false);
      this.once(failedEvent, handlers.failed);
      this.once(doneEvent, handlers.done);
      this.once(okEvent, handlers.ok);
    });
    return {
      retry,
      dispose: () => {
        this.removeListener(failedEvent, handlers.failed);
        this.removeListener(doneEvent, handlers.done);
        this.removeListener(okEvent, handlers.ok);
      },
    };
  }

  private async stopPendingClaudeSpawn(
    context: ClaudeTurnContext,
    resumeWaiter: ClaudeResumeWaiter,
  ): Promise<boolean> {
    if (!this.pendingStops.delete(context.params.sessionId)) return false;
    logger.info("Pending stop consumed, tearing down new session", {
      sessionId: context.params.sessionId,
    });
    resumeWaiter.dispose();
    await this.runtime.stop(context.params.sessionId);
    this.publishTurnEvent(context.routing, context.params.sessionId, {
      type: AgentEventType.Ended,
      threadId: context.threadId,
      turnExecutionId: context.routing.executionId,
    } satisfies AgentEvent);
    return true;
  }

  private async finishClaudeSpawn(
    context: ClaudeTurnContext,
    resumeWaiter: ClaudeResumeWaiter,
  ): Promise<ClaudeSpawnOutcome> {
    if (!resumeWaiter.retry) return "ok";
    let retry: boolean;
    try {
      retry = await resumeWaiter.retry;
    } finally {
      resumeWaiter.dispose();
    }
    if (!retry) return "ok";
    logger.info("Resume failed, falling back to fresh query()", {
      sessionId: context.params.sessionId,
    });
    this.sdkSessionIds.delete(context.params.sessionId);
    await this.runtime.stop(context.params.sessionId);
    return "retry";
  }

  private async doSendMessage(
    params: ClaudeSendMessageParams,
    routing: ClaudeCanonicalEventRouting,
  ): Promise<void> {
    const {
      sessionId,
      message,
      cwd,
      model,
      permissionMode,
      attachments,
      contextWindowMode,
    } = params;

    const existing = this.runtime.get(sessionId);
    const { scope: browserScope, leaseExpired: browserLeaseExpired } =
      this.prepareClaudeBrowserReuseState(sessionId, existing);
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

    const prompt = await this.createClaudePrompt(
      message,
      attachments,
      sessionId,
    );

    const context = this.createClaudeTurnContext(
      params,
      routing,
      prompt,
      tid,
      resolvedCwd,
      resolvedModel,
      sdkModelSlug,
    );
    const reuseOutcome = await this.tryReuseClaudeSession(context, existing, {
      scope: browserScope,
      leaseExpired: browserLeaseExpired,
    });
    if (reuseOutcome === "handled") return;
    if (reuseOutcome === "retry_fresh")
      return await this.doSendMessage({ ...params, resume: false }, routing);

    const resumeId = this.sdkSessionIds.get(sessionId) ?? uuid;
    const baseOptions = this.createClaudeBaseOptions(
      context,
      sdkPermissionMode,
    );
    await this.spawnClaudeTurn(context, baseOptions, resumeId);
  }

  private takePendingClaudeSpawn(sessionId: string): PendingSpawnTurn {
    const staged = this.pendingSpawnTurns.get(sessionId);
    if (!staged)
      throw new Error(
        `Claude spawn called with no staged turn for session ${sessionId}`,
      );
    this.pendingSpawnTurns.delete(sessionId);
    return staged;
  }

  private issueClaudeBrowserGrant(sessionId: string): ClaudeSpawnBrowserAccess {
    const pending = this.pendingBrowserAccess.get(sessionId);
    const grant =
      pending?.grant ??
      (pending?.stage
        ? this.browserAutomationSessionLease.issue(pending.stage)
        : null);
    if (pending?.grant && pending.stage)
      this.browserAutomationSessionLease.release(pending.stage.leaseId);
    return { pending, scope: pending?.scope, grant };
  }

  private createClaudeStderrCapture(sessionId: string): (data: string) => void {
    this.recentStderr.delete(sessionId);
    return (data) => {
      const next = ((this.recentStderr.get(sessionId) ?? "") + data).slice(
        -STDERR_CAPTURE_LIMIT,
      );
      this.recentStderr.set(sessionId, next);
    };
  }

  private createClaudeSpawnOptions(
    args: SpawnArgs,
    staged: PendingSpawnTurn,
    browserGrant: BrowserAutomationSessionLeaseGrant | null,
    stderr: (data: string) => void,
  ): ClaudeSdkQueryOptions {
    const effectiveMcpServers = mergeClaudeMcpServers(
      (staged.baseOptions.mcpServers ?? {}) as Record<string, unknown>,
      browserGrant,
    );
    const instructions = renderMcodeInstructions(
      buildMcodeInstructionPlan({
        sourceThreadId: args.threadId,
        threadControlGranted: Boolean(
          effectiveMcpServers.mcode_internal_thread_control,
        ),
        browserAutomationGranted: Boolean(browserGrant),
      }),
    );
    const options = {
      ...staged.baseOptions,
      mcpServers: effectiveMcpServers,
      systemPrompt: {
        type: "preset" as const,
        preset: "claude_code" as const,
        append: instructions,
      },
    };
    return (
      staged.resume
        ? { ...options, resume: staged.resumeId, stderr }
        : { ...options, sessionId: staged.uuid, stderr }
    ) as ClaudeSdkQueryOptions;
  }

  private async captureClaudeChildPidsBeforeSpawn(): Promise<
    Set<number> | undefined
  > {
    if (!this.jobObject.isWindowsJob) return undefined;
    try {
      return new Set(
        (await listDirectChildren(process.pid, this.requireHostRuntime().platform)).map((child) => child.pid),
      );
    } catch {
      return undefined;
    }
  }

  private requireHostRuntime(): Pick<ProviderHostPorts, "runtime">["runtime"] {
    if (!this.host) throw new Error("Claude Provider host runtime is required");
    return this.host.runtime;
  }

  private startClaudeSdkQuery(
    sessionId: string,
    queue: ReturnType<typeof createPromptQueue>,
    options: ClaudeSdkQueryOptions,
    browser: ClaudeSpawnBrowserAccess,
  ): Query {
    try {
      return this.withSdkSpawnEnv(() =>
        sdkQuery({ prompt: queue.iterable, options }),
      );
    } catch (error) {
      this.releaseFailedClaudeBrowserGrant(sessionId, browser);
      throw error;
    }
  }

  private releaseFailedClaudeBrowserGrant(
    sessionId: string,
    browser: ClaudeSpawnBrowserAccess,
  ): void {
    if (browser.grant)
      this.browserAutomationSessionLease.release(browser.grant.leaseId);
    if (browser.pending?.stage)
      this.browserAutomationSessionLease.release(browser.pending.stage.leaseId);
    this.pendingBrowserAccess.delete(sessionId);
  }

  private releaseStagedClaudeBrowserAccess(
    sessionId: string,
    browser: ClaudeSpawnBrowserAccess,
  ): void {
    if (browser.pending?.grant && browser.pending.stage) {
      this.browserAutomationSessionLease.release(browser.pending.stage.leaseId);
    }
    this.pendingBrowserAccess.delete(sessionId);
  }

  private async captureClaudeChildPidsAfterSpawn(
    beforePids: Set<number> | undefined,
  ): Promise<number[]> {
    if (!beforePids) return [];
    try {
      const children = await listDirectChildren(process.pid, this.requireHostRuntime().platform);
      return children
        .filter((child) => !beforePids.has(child.pid))
        .map((child) => child.pid);
    } catch {
      return [];
    }
  }

  private createClaudeSessionState(
    args: SpawnArgs,
    staged: PendingSpawnTurn,
    queue: ReturnType<typeof createPromptQueue>,
    query: Query,
    browser: ClaudeSpawnBrowserAccess,
  ): ClaudeSessionState {
    return {
      sessionId: args.sessionId,
      cwd: args.cwd,
      query,
      pushMessage: queue.push,
      closeQueue: queue.close,
      model: staged.resolvedModel,
      permissionMode: args.permissionMode,
      contextWindowMode: staged.contextWindowMode,
      orchestrationMode: staged.orchestrationMode,
      lastUsedAt: Date.now(),
      pendingToolUses: new Set<string>(),
      hasFiredToolThisTurn: false,
      workspaceId: browser.scope?.workspaceId ?? "unknown-workspace",
      browserPermissionCapability:
        browser.scope?.permissionCapability ?? "interact",
      ...(browser.grant && {
        browserLease: {
          leaseId: browser.grant.leaseId,
          credentialId: browser.grant.credentialId,
          expiresAt: browser.grant.expiresAt,
        },
      }),
    };
  }

  private startClaudeStagedTurn(
    sessionId: string,
    query: Query,
    staged: PendingSpawnTurn,
    queue: ReturnType<typeof createPromptQueue>,
  ): void {
    const routing = this.getCanonicalRoutings().get(staged.turnExecutionId);
    if (!routing)
      throw new Error(
        `Claude canonical routing missing for execution ${staged.turnExecutionId}`,
      );
    this.startStreamLoop(
      sessionId,
      query,
      routing,
      queue.setOnPromptConsumed,
      staged.resume,
    );
    queue.push(staged.prompt, routing.executionId);
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
    const staged = this.takePendingClaudeSpawn(sessionId);
    const browser = this.issueClaudeBrowserGrant(sessionId);
    const options = this.createClaudeSpawnOptions(
      args,
      staged,
      browser.grant,
      this.createClaudeStderrCapture(sessionId),
    );
    const queue = createPromptQueue();
    logger.info("Starting query()", {
      sessionId,
      resume: staged.resume,
      resumeId: staged.resumeId,
      cwd,
    });
    const beforePids = await this.captureClaudeChildPidsBeforeSpawn();
    const query = this.startClaudeSdkQuery(sessionId, queue, options, browser);
    this.releaseStagedClaudeBrowserAccess(sessionId, browser);
    const pids = await this.captureClaudeChildPidsAfterSpawn(beforePids);
    const state = this.createClaudeSessionState(
      args,
      staged,
      queue,
      query,
      browser,
    );
    this.startClaudeStagedTurn(sessionId, query, staged, queue);
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
    return [...this.pendingPermissions.values()].some(
      (p) => p.threadId === tid,
    );
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
  isStale(
    state: ClaudeSessionState,
    args: { cwd: string; permissionMode: string },
  ): boolean {
    return state.permissionMode !== args.permissionMode;
  }

  /** Runs the SDK transport loop while the provider owns session finalization. */
  private startStreamLoop(
    sessionId: string,
    q: Query,
    routing: ClaudeCanonicalEventRouting,
    onConsumed: (handler: (turnExecutionId?: string) => void) => void,
    isResuming: boolean,
  ): void {
    const state = this.createClaudeStreamState(sessionId, routing, isResuming);
    onConsumed((executionId) => {
      if (executionId && executionId !== state.currentTurnExecutionId)
        state.pendingPromptExecutionIds.push(executionId);
    });
    void this.consumeClaudeStream(sessionId, q, routing, state);
  }

  private createClaudeStreamState(
    sessionId: string,
    routing: ClaudeCanonicalEventRouting,
    isResuming: boolean,
  ): ClaudeStreamLoopState {
    const threadId = sessionId.startsWith("mcode-")
      ? sessionId.slice(6)
      : sessionId;
    const state: ClaudeStreamLoopState = {
      currentTurnExecutionId: routing.executionId,
      pendingPromptExecutionIds: [],
      sessionInitialized: false,
      awaitingResume: isResuming,
      resumedTurnStarted: false,
      suppressEnded: false,
      mapper: undefined as never,
    };
    state.mapper = new ClaudeEventMapper(
      sessionId,
      threadId,
      this.createClaudeMapperCallbacks(sessionId, threadId, state, routing),
    );
    return state;
  }

  private createClaudeMapperCallbacks(
    sessionId: string,
    threadId: string,
    state: ClaudeStreamLoopState,
    routing: ClaudeCanonicalEventRouting,
  ): ClaudeEventMapperCallbacks {
    return {
      emit: (event) =>
        this.publishTurnEvent(
          this.getCanonicalRoutings().get(state.currentTurnExecutionId) ??
            routing,
          sessionId,
          event,
        ),
      getSession: () => this.runtime.get(sessionId),
      captureSdkSessionId: (id) =>
        this.captureClaudeSdkSessionId(sessionId, id),
      observeNativeGoalCommands: (commands, version) =>
        this.observeNativeGoalCommands(sessionId, commands, version),
      applyNativeGoalCommandResult: (result) =>
        this.applyNativeGoalCommandResult(sessionId, result),
      invalidateSdkSession: () => this.sdkSessionIds.delete(sessionId),
      markSessionPoisoned: () => {
        const current = this.runtime.get(sessionId);
        if (current) current.poisoned = true;
      },
      updateUsage: (metrics) => this.updateClaudeUsage(metrics),
      invalidateUsage: () => this.usageSource.invalidate(),
      resolveBillingMode: () => this.resolveBillingMode(),
      isSessionStartHookSuppressed: () =>
        this.suppressSessionStartHooks.has(threadId),
      clearSessionStartHookSuppression: () =>
        this.suppressSessionStartHooks.delete(threadId),
    };
  }

  private async consumeClaudeStream(
    sessionId: string,
    q: Query,
    routing: ClaudeCanonicalEventRouting,
    state: ClaudeStreamLoopState,
  ): Promise<void> {
    try {
      for await (const raw of q) {
        const message = raw as Record<string, unknown>;
        const current = this.runtime.get(sessionId);
        if (current) current.lastUsedAt = Date.now();
        if (!state.sessionInitialized && message.type !== "result") {
          state.sessionInitialized = true;
          this.emit(`_resumeOk:${sessionId}`);
        }
        state.mapper.captureSessionIdentity(message, state.sessionInitialized);
        const isResumeFailure = this.isFailedClaudeResume(
          message,
          state.sessionInitialized,
        );
        this.startClaudeResume(
          sessionId,
          routing,
          state,
          message,
          isResumeFailure,
        );
        if (isResumeFailure) {
          this.handleFailedClaudeResume(sessionId, routing, state);
          break;
        }
        const outcome = await state.mapper.map(message);
        if (outcome !== "none") {
          state.awaitingResume = outcome === "turn_complete";
          state.resumedTurnStarted = false;
        }
      }
    } catch (error: unknown) {
      this.publishClaudeStreamError(sessionId, q, routing, state, error);
    } finally {
      await this.finalizeClaudeStream(sessionId, q, routing, state);
    }
  }

  private isFailedClaudeResume(
    message: Record<string, unknown>,
    initialized: boolean,
  ): boolean {
    return (
      !initialized &&
      message.type === "result" &&
      message.is_error === true &&
      Array.isArray(message.errors) &&
      message.errors.some(
        (error) =>
          typeof error === "string" && error.includes("No conversation found"),
      )
    );
  }

  private handleFailedClaudeResume(
    sessionId: string,
    routing: ClaudeCanonicalEventRouting,
    state: ClaudeStreamLoopState,
  ): void {
    const threadId = sessionId.startsWith("mcode-")
      ? sessionId.slice(6)
      : sessionId;
    logger.warn(
      "Resume failed: conversation not found, will retry with fresh query()",
      { sessionId },
    );
    this.sdkSessionIds.delete(sessionId);
    this.publishTurnEvent(
      this.getCanonicalRoutings().get(state.currentTurnExecutionId) ?? routing,
      sessionId,
      {
        type: AgentEventType.System,
        threadId,
        subtype: "session_restarted",
      } satisfies AgentEvent,
    );
    this.emit(`_resumeFailed:${sessionId}`);
    state.suppressEnded = true;
  }

  private startClaudeResume(
    sessionId: string,
    routing: ClaudeCanonicalEventRouting,
    state: ClaudeStreamLoopState,
    message: Record<string, unknown>,
    isResumeFailure: boolean,
  ): void {
    if (
      !state.awaitingResume ||
      message.type === "system" ||
      (message.type === "result" &&
        state.pendingPromptExecutionIds.length === 0 &&
        !isResumeFailure)
    )
      return;
    const executionId = state.pendingPromptExecutionIds.shift();
    if (executionId) {
      state.awaitingResume = false;
      state.currentTurnExecutionId = executionId;
    } else if (state.resumedTurnStarted) return;
    state.resumedTurnStarted = true;
    const threadId = sessionId.startsWith("mcode-")
      ? sessionId.slice(6)
      : sessionId;
    this.publishTurnEvent(
      this.getCanonicalRoutings().get(state.currentTurnExecutionId) ?? routing,
      sessionId,
      { type: AgentEventType.TurnStarted, threadId } satisfies AgentEvent,
    );
  }

  private captureClaudeSdkSessionId(
    sessionId: string,
    sdkSessionId: string,
  ): boolean {
    if (sdkSessionId.trim().length === 0) return false;
    if (this.sdkSessionIds.has(sessionId)) return false;
    this.sdkSessionIds.set(sessionId, sdkSessionId);
    logger.info("Captured SDK session ID", { sessionId, sdkSessionId });
    return true;
  }

  private updateClaudeUsage(metrics: ClaudeUsageMetrics) {
    this.lastSessionCostUsd = metrics.costUsd;
    this.lastNumTurns = metrics.numTurns;
    this.lastDurationMs = metrics.durationMs;
    this.lastServiceTier = metrics.serviceTier;
    return {
      sessionCostUsd: this.lastSessionCostUsd,
      serviceTier: this.lastServiceTier,
      numTurns: this.lastNumTurns,
      durationMs: this.lastDurationMs,
    };
  }

  private publishClaudeStreamError(
    sessionId: string,
    q: Query,
    routing: ClaudeCanonicalEventRouting,
    state: ClaudeStreamLoopState,
    error: unknown,
  ): void {
    const current = this.runtime.get(sessionId);
    if (this.suppressClaudeStreamError(current, q)) return;
    const message = error instanceof Error ? error.message : String(error);
    const tail = this.recentStderr.get(sessionId)?.trim();
    const threadId = sessionId.startsWith("mcode-")
      ? sessionId.slice(6)
      : sessionId;
    logger.error("SDK stream error", {
      sessionId,
      error: message,
      ...(tail ? { stderr: tail } : {}),
    });
    this.publishTurnEvent(
      this.getCanonicalRoutings().get(state.currentTurnExecutionId) ?? routing,
      sessionId,
      {
        type: AgentEventType.Error,
        threadId,
        error: tail
          ? `${message}\n\nClaude Code stderr (tail):\n${tail}`
          : message,
      } satisfies AgentEvent,
    );
  }

  private suppressClaudeStreamError(
    current: ClaudeSessionState | undefined,
    q: Query,
  ): boolean {
    return (
      current?.suppressEnded === true ||
      this.isSupersededClaudeStream(current, q)
    );
  }

  private isSupersededClaudeStream(
    current: ClaudeSessionState | undefined,
    q: Query,
  ): boolean {
    return current !== undefined && current.query !== q;
  }

  private async finalizeClaudeStream(
    sessionId: string,
    q: Query,
    routing: ClaudeCanonicalEventRouting,
    state: ClaudeStreamLoopState,
  ): Promise<void> {
    this.recentStderr.delete(sessionId);
    const suppressedQuery = this.suppressEndedQueries.delete(q);
    const current = this.runtime.get(sessionId);
    const superseded = this.isSupersededClaudeStream(current, q);
    const threadId = sessionId.startsWith("mcode-")
      ? sessionId.slice(6)
      : sessionId;
    if (current?.query === q) {
      void this.runtime.stop(sessionId);
      this.suppressSessionStartHooks.delete(threadId);
    }
    logger.info("Session stream ended", { sessionId });
    this.emit(`_streamDone:${sessionId}`);
    if (
      !this.canEmitClaudeEnded(state, suppressedQuery, superseded, current, q)
    )
      return;
    this.publishTurnEvent(
      this.getCanonicalRoutings().get(state.currentTurnExecutionId) ?? routing,
      sessionId,
      {
        type: AgentEventType.Ended,
        threadId,
        turnExecutionId: state.currentTurnExecutionId,
      } satisfies AgentEvent,
    );
    await this.waitForCanonicalExecution(state.currentTurnExecutionId);
  }

  private canEmitClaudeEnded(
    state: ClaudeStreamLoopState,
    suppressedQuery: boolean,
    superseded: boolean,
    current: ClaudeSessionState | undefined,
    q: Query,
  ): boolean {
    return (
      !state.suppressEnded &&
      !suppressedQuery &&
      !superseded &&
      !current?.suppressEnded &&
      (!current || current.query === q)
    );
  }
  private rememberCanonicalRouting(
    req: TurnRequest<"claude">,
  ): ClaudeCanonicalEventRouting {
    const routing = {
      threadId: req.threadId,
      turnId: req.turnId,
      executionId: req.turnExecutionId,
      deliveryAttempt: req.deliveryAttempt ?? 1,
    };
    this.getCanonicalRoutings().set(routing.executionId, routing);
    return routing;
  }

  private publishTurnEvent(
    routing: ClaudeCanonicalEventRouting,
    sessionId: string,
    event: AgentEvent,
  ): void {
    const runtimeEvent = providerRuntimeEvent({
      ...event,
      turnExecutionId: routing.executionId,
    });
    if (!this.canonicalEventPublisher) {
      this.emit("event", runtimeEvent);
      return;
    }
    this.canonicalEventPublisher.publish(
      routing,
      runtimeEvent,
      this.claudeSessionIdentities(sessionId),
    );
  }

  private claudeSessionIdentities(sessionId: string): ProviderIdentity[] {
    const nativeSessionId = this.sdkSessionIds.get(sessionId);
    if (!nativeSessionId) return [];
    return [
      {
        providerId: this.id,
        scope: "session",
        value: nativeSessionId,
        provenance: "native",
      },
    ];
  }

  private async waitForCanonicalExecution(executionId: string): Promise<void> {
    const routing = this.getCanonicalRoutings().get(executionId);
    if (!routing || !this.canonicalEventPublisher) return;
    try {
      await this.canonicalEventPublisher.waitForExecution(routing);
    } catch (error: unknown) {
      logger.error("Claude canonical event delivery failed", {
        executionId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.getCanonicalRoutings().delete(executionId);
    }
  }

  private getCanonicalRoutings(): Map<string, ClaudeCanonicalEventRouting> {
    this.canonicalRoutings ??= new Map<string, ClaudeCanonicalEventRouting>();
    return this.canonicalRoutings;
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
        const data = await NodeFSPromises.readFile(att.sourcePath);

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
        const errMsg = err instanceof Error ? err.message : String(err);
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
  ): Promise<NonNullable<
    ReturnType<typeof parseClaudeGoalCommandResult>
  > | null> {
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
    const resultPromise = new Promise<NonNullable<
      ReturnType<typeof parseClaudeGoalCommandResult>
    > | null>((resolve) => {
      let settled = false;
      const done = (
        result: NonNullable<
          ReturnType<typeof parseClaudeGoalCommandResult>
        > | null,
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.removeListener(eventName, onResult);
        resolve(result);
      };
      const onResult = (
        result: NonNullable<ReturnType<typeof parseClaudeGoalCommandResult>>,
      ) => done(result);
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
    const entry =
      this.nativeGoalsBySession.get(sessionId) ??
      this.goalsBySession.get(sessionId);
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
        logger.warn("Claude waitForSessionExit stop failed", {
          sessionId,
          error: String(err),
        });
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
      logger.warn(
        "resolvePermission: requestId not found in pendingPermissions",
        { requestId, decision, mapSize: this.pendingPermissions.size },
      );
      return false;
    }
    logger.debug("resolvePermission", {
      requestId,
      decision,
      toolName: entry.toolName,
    });
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
      this.emit("permission_resolved", {
        requestId,
        decision: "cancelled" as const,
      });
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

function sideChannelErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isUnresumableSideChannelError(error: unknown): boolean {
  return /no conversation found|session not found|session expired|resume.*invalid|unknown session/.test(
    sideChannelErrorMessage(error).toLowerCase(),
  );
}

function transientSideChannelResumeError(
  error: unknown,
): Error & { code: string } {
  const rethrown = new Error(
    `Parent session not resumable (likely after server restart): ${sideChannelErrorMessage(error)}`,
  ) as Error & { code: string };
  rethrown.code = "ETIMEDOUT";
  return rethrown;
}
