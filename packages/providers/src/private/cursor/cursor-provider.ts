/**
 * @internal
 * Cursor CLI provider via long-lived `cursor-agent acp` (Agent Client Protocol).
 *
 * One subprocess per Mcode thread keeps JSON-RPC on stdio stable across turns.
 * When `session/load` fails (known Cursor limitations), we fall back to `session/new`
 * and emit `sdk_session_id` so the DB tracks the active session id.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import { logger } from "@mcode/shared";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type PermissionOption,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type McpServer,
} from "@agentclientprotocol/sdk";

import {
  providerBrowserPermissionCapability,
  type ProviderBrowserCredentialMetadata,
  type ProviderBrowserLeaseGrant,
  type ProviderBrowserLeaseHandle,
  type ProviderHostPorts,
  type ProviderThreadControlHttpConnection,
} from "../../host-ports.js";
import type { CursorProviderPorts } from "../../factory-types.js";
import { SessionRuntime } from "../session-runtime.js";
import type { ProtocolAdapter, SpawnArgs, SpawnResult } from "../session-runtime.js";
import {
  AgentEventType,
  CURSOR_STATIC_MODEL_FALLBACK,
  getCatalogEntry,
} from "@mcode/contracts";
import type {
  AttachmentMeta,
  AgentEvent,
  ForkRequest,
  HandoffArtifact,
  HandoffMeta,
  IAgentProvider,
  ISessionEvictable,
  TurnRequest,
  PermissionDecision,
  PermissionRequest,
  ProviderModelInfo,
  SessionForker,
  Settings,
} from "@mcode/contracts";
import {
  createCursorTodoSnapshot,
  cursorUpdateTodosExtNotificationToAgentEvents,
  type CursorTodoSnapshot,
} from "./cursor-todo-snapshot.js";
import { fetchCursorCliModels } from "./cursor-cli-models.js";
import { buildCursorAcpArgs } from "./cursor-acp-spawn-args.js";
import { buildCursorAcpPromptBlocks } from "./cursor-acp-prompt.js";
import { buildMcodeInstructionPlan, renderMcodeInstructions } from "@mcode/thread-orchestration";
import {
  buildCursorAgentGuidanceMarkdown,
  formatCursorSkillsAndCommandsForPrompt,
} from "./cursor-agent-guidance.js";
import { readCursorUserInstructions } from "./cursor-prompt.js";
import {
  createCursorAcpTurnState,
  mapCursorAcpSessionNotification,
  type CursorAcpTurnState,
} from "./cursor-acp-event-mapper.js";
import { resolveCursorAssistantMessageContent } from "./cursor-stream-event-mapper.js";
import {
  mapDecisionToAcpOutcome,
  pickFullAccessAllowOption,
  synthesizeCursorAcpPermissionRequest,
} from "./cursor-acp-permission-mapper.js";
import { resolveCursorStickyInstructionBlob } from "./cursor-acp-sticky-instructions.js";
import { buildCursorAskQuestionExtResponse } from "./cursor-acp-ask-question.js";
import {
  buildCursorAcpContinueAfterDisconnectPrompt,
  looksLikeAcpConnectionClosed,
  looksLikeCursorRateLimit,
  computeCursorRateLimitBackoffMs,
  interruptibleDelay,
  isLikelyTransientCursorPromptFailure,
  shouldSuppressCursorPromptError,
} from "./cursor-acp-transient-retry.js";
import {
  shouldEmitCursorSessionTrace,
  summarizeCursorSessionNotification,
  summarizeEmittedAgentEventsForTrace,
} from "./cursor-acp-session-trace.js";
import { cursorTaskExtToAgentEvents } from "./cursor-acp-task.js";
import { extractCursorCreatePlanMarkdown } from "./cursor-create-plan.js";
import {
  AcpSessionRuntime,
  validateAcpInitializeResult,
  validateAcpSessionUpdate,
} from "../protocols/acp/acp-session-runtime.js";

const CURSOR_STDERR_TAIL_MAX = 48;

/**
 * Wrap a message as a transient (ETIMEDOUT) error. `classifyProviderError` maps
 * ETIMEDOUT to the "transient" bucket, so the handoff pipeline falls cleanly to
 * the deterministic path (D) instead of treating a missing/unresumable session
 * as a permanent failure.
 */
function transientHandoffError(message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = "ETIMEDOUT";
  return err;
}

/**
 * Minimal transport surface the clean side-channel needs from a throwaway ACP
 * connection: reconstruct the parent session, run one prompt, then dispose. The
 * assistant text is read off the local accumulator, so neither return value is
 * inspected here.
 */
interface CursorSideChannelTransport {
  loadSession(args: { cwd: string; mcpServers: never[]; sessionId: string }): Promise<unknown>;
  prompt(args: { sessionId: string; prompt: { type: "text"; text: string }[] }): Promise<unknown>;
  dispose(): Promise<void> | void;
}

/** Builds the ACP HTTP MCP configuration for one provider session. */
export function buildCursorInternalMcpServers(
  connection: ProviderThreadControlHttpConnection,
): McpServer[] {
  return [{
    type: "http",
    name: connection.name,
    url: connection.url,
    headers: Object.entries(connection.headers).map(([name, value]) => ({ name, value })),
  }];
}

type BrowserAutomationCredentialMetadata = ProviderBrowserCredentialMetadata;
type BrowserAutomationSessionLeaseGrant = ProviderBrowserLeaseGrant;
type BrowserAutomationSessionLeaseStage = ProviderBrowserLeaseHandle;

const CURSOR_SUPPORTED_CAPABILITIES = [
  "build",
  "plan",
  "permissions",
  "session-eviction",
  "clean-fork",
  "browser-access",
  "thread-control",
] as const;

const CURSOR_ACP_UNSUPPORTED_RESULT = Object.freeze({ outcome: { outcome: "unsupported" as const } });

interface CleanForkCapable {
  readonly id: string;
  runSideChannelQuery(args: {
    parentThreadId: string;
    parentSdkSessionId: string;
    prompt: string;
    abortSignal?: AbortSignal;
    conversationHistory?: string;
    cwd: string;
  }): Promise<string>;
}

class CleanForker implements SessionForker {
  constructor(private readonly provider: CleanForkCapable) {}

  async fork(request: ForkRequest): Promise<HandoffArtifact> {
    const markdown = await this.provider.runSideChannelQuery({
      parentThreadId: request.parentThreadId,
      parentSdkSessionId: request.parentSdkSessionId ?? "",
      prompt: request.prompt,
      abortSignal: request.abortSignal,
      conversationHistory: request.conversationHistory,
      cwd: request.cwd,
    });
    const parent = request.parentThread;
    const meta: HandoffMeta = {
      schemaVersion: 1,
      parentThreadId: request.parentThreadId,
      forkedFromMessageId: request.forkedFromMessageId,
      forkAnchorRole: request.forkAnchorRole,
      childThreadId: request.childThreadId,
      generatedBy: "provider",
      provider: parent.provider,
      ladderStep: "B",
      mode: "full",
      generatedAt: new Date().toISOString(),
      characterCount: markdown.length,
      parentSdkSessionId: parent.sdk_session_id ?? null,
      providerErrorOnGenerate: null,
      regenerationHistory: [],
      attachments: [],
      ...(request.historyBudget && { historyBudget: request.historyBudget }),
    };
    return { markdown, meta };
  }
}

/**
 * Factory that opens a throwaway ACP transport wired to a non-emitting client.
 * Defaulted to the real `cursor-agent acp` spawn and overridable in tests so the
 * clean-fork invariants can be asserted without a live subprocess.
 */
type CursorSideChannelConnector = (args: {
  cwd: string;
  client: Client;
}) => Promise<CursorSideChannelTransport>;

function cursorCliProbeBinaries(settings: Settings): string[] {
  const configured = settings.provider.cli.cursor?.trim();
  return configured ? [configured] : [getCatalogEntry("cursor").cliBinary, "agent"];
}

function isThreadControlHttpConnection(value: unknown): value is ProviderThreadControlHttpConnection {
  if (!value || typeof value !== "object") return false;
  const connection = value as Record<string, unknown>;
  return typeof connection.name === "string"
    && typeof connection.url === "string"
    && typeof connection.headers === "object"
    && connection.headers !== null
    && !Array.isArray(connection.headers);
}

interface PendingAcpPermission {
  mcodeSessionId: string;
  threadId: string;
  options: PermissionOption[];
  request: PermissionRequest;
  resolve: (value: RequestPermissionResponse) => void;
}

interface CursorAcpSessionEntry {
  mcodeSessionId: string;
  threadId: string;
  child: ChildProcess;
  connection: ClientSideConnection;
  acpRuntime: AcpSessionRuntime;
  acpSessionId: string;
  cwd: string;
  permissionMode: "full" | "default";
  lastUsedAt: number;
  todoSnapshot: CursorTodoSnapshot;
  turnChain: Promise<void>;
  activeTurnState: CursorAcpTurnState | null;
  /** True once a heavy stitched instructions blob (> threshold) shipped on this MCP session. */
  stickyHeavyInstructionsSent: boolean;
  /** Monotonic prompts across the MCP subprocess lifetime (sticky preamble pacing). */
  cursorPromptOrdinal: number;
  /** Recent stderr snippets for diagnosing opaque CLI failures. */
  stderrTailLines: string[];
  /** Last stable `modelId` handshake for this MCP session (`acpSessionId` rotation forces re-apply). */
  cursorModelAppliedPair: { acpSessionId: string; modelId: string } | null;
  /** Set immediately before issuing ACP cancel while a prompt is in flight (explicit Stop vs noisy upstream errors). */
  pendingUserStopAbort: boolean;
  /** Whether this ACP version advertised HTTP MCP session support. */
  browserHttpMcpSupported: boolean;
  /** Non-secret browser credential lifecycle metadata for this main session. */
  browserCredential?: BrowserAutomationCredentialMetadata & { leaseId: string };
  /** Workspace fixed to this provider process at spawn. */
  workspaceId: string;
  /** Browser permission class fixed to this provider process at spawn. */
  browserPermissionCapability: "observe" | "interact" | "privileged";
  supportsHttpMcp: boolean;
  /** Capability-derived Mcode guidance sent once on first normal prompt. */
  mcodeRuntimeInstructions: string;
  mcodeRuntimeInstructionsSent: boolean;
  /** True when this ACP logical session successfully reloaded stored state. */
  mcodeLogicalSessionReloaded: boolean;
}

/**
 * Per-session state owned by the {@link SessionRuntime}. Identical to the rich
 * ACP session entry the provider has always carried (child process, ACP
 * connection, logical session id, in-flight turn state, the serialized turn
 * chain, sticky-instruction pacing, stderr tail). The runtime now owns the
 * pool, idle eviction (with the `activeTurnState` busy guard), process-port
 * attachment, and process-tree termination for the child PID surfaced from `spawn`.
 */
type CursorSessionState = CursorAcpSessionEntry;

type CursorBrowserContext = Pick<CursorAcpSessionEntry, "workspaceId" | "browserPermissionCapability">;

/** Builds the ACP HTTP MCP descriptor for one short-lived browser grant. */
export function buildCursorBrowserMcpServers(
  grant: Pick<BrowserAutomationSessionLeaseGrant, "mcpUrl" | "token"> | null,
): McpServer[] {
  return grant
    ? [{
        type: "http",
        name: "mcode-browser",
        url: grant.mcpUrl,
        headers: [{ name: "Authorization", value: `Bearer ${grant.token}` }],
      }]
    : [];
}

/** Returns true only when the ACP initialize response explicitly supports HTTP MCP. */
export function cursorSupportsHttpMcp(initializeResult: {
  agentCapabilities?: { mcpCapabilities?: { http?: boolean } };
}): boolean {
  return initializeResult.agentCapabilities?.mcpCapabilities?.http === true;
}

/** Appends Mcode guidance only when not yet delivered to a logical ACP session. */
export function appendCursorMcodeInstructions(
  instructionMarkdown: string | undefined,
  runtimeInstructions: string,
  sent: boolean,
): { instructionMarkdown: string | undefined; included: boolean } {
  if (sent || !runtimeInstructions.trim()) return { instructionMarkdown, included: false };
  if (instructionMarkdown?.includes(runtimeInstructions)) {
    return { instructionMarkdown, included: true };
  }
  return {
    instructionMarkdown: [instructionMarkdown, runtimeInstructions]
      .filter((value): value is string => Boolean(value && value.trim()))
      .join("\n\n"),
    included: true,
  };
}

/** Carries one-time guidance state only across a successful stored-session reload. */
export function carryCursorMcodeSentState(
  logicalSessionReloaded: boolean,
  sent: boolean,
): boolean {
  return logicalSessionReloaded && sent;
}

/** Cursor ACP adapter implementing IAgentProvider through one private MCP subprocess per session. */
export class CursorProvider
  extends EventEmitter
  implements IAgentProvider, ISessionEvictable, ProtocolAdapter<CursorSessionState>
{
  readonly id = "cursor" as const;
  readonly descriptor = Object.freeze({
    id: "cursor" as const,
    capabilities: [
      ...CURSOR_SUPPORTED_CAPABILITIES.map((name) => ({ name, support: "supported" as const })),
      { name: "provider-continuation" as const, support: "unsupported" as const },
      { name: "child-cancellation" as const, support: "unsupported" as const },
    ],
  });
  readonly supportsCompletion = false;
  readonly sessionForkOnResume = "clean" as const;
  readonly maxInputCharactersPerTurn = 4_000;
  /** Path B forker; calls this provider's runSideChannelQuery on a forked copy of the parent session. */
  readonly forker: SessionForker = new CleanForker(this);

  /**
   * Opens the throwaway ACP transport for {@link runSideChannelQuery}. Defaults
   * to the real subprocess spawn; tests override it to assert the clean-fork
   * invariants without launching `cursor-agent`.
   */
  private sideChannelConnector: CursorSideChannelConnector = (args) =>
    this.createSideChannelTransport(args);

  /** Owns the session pool, idle eviction, and server-managed process cleanup. */
  private readonly runtime: SessionRuntime<CursorSessionState>;
  private sdkSessionIds = new Map<string, string>();
  /** Binds each ACP prompt state to its immutable originating Mcode execution. */
  private readonly turnExecutionByState = new WeakMap<object, string>();
  /** Binds a request that is still opening to its Mcode execution for stop teardown. */
  private readonly pendingTurnExecutionIds = new Map<string, string>();
  /**
   * Session IDs for which a stop was requested before the session was created.
   * Checked after session creation; if found the session is torn down immediately.
   */
  private pendingStops = new Set<string>();
  /** ACP runtimes still opening before SessionRuntime can own their state. */
  private pendingAcpRuntimes = new Map<string, AcpSessionRuntime>();
  private pendingPermissions = new Map<string, PendingAcpPermission>();
  /** Threads in Mcode plan-questions phase; disables Cursor ask_question auto-picks. */
  private planQuestionModeThreads = new Set<string>();
  /**
   * Mcode session ids the runtime currently holds. The runtime owns the pool
   * but exposes only `get(id)`, so the provider mirrors the live id set to be
   * able to iterate sessions (e.g. sticky-instruction invalidation). Populated
   * in `spawn`, pruned in `close`.
   */
  private liveSessionIds = new Set<string>();
  /** Browser lease staged only until a fresh normal ACP session opens. */
  private pendingBrowserLeases = new Map<string, BrowserAutomationSessionLeaseStage>();
  /** Non-secret provider state needed while a staged lease is being opened. */
  private pendingBrowserContext = new Map<string, CursorBrowserContext>();
  /** Refreshed browser grant carried across a provider restart. */
  private pendingBrowserGrants = new Map<string, BrowserAutomationSessionLeaseGrant>();
  /** Context captured with a refreshed grant so a changed request cannot reuse it. */
  private pendingBrowserGrantContext = new Map<string, CursorBrowserContext>();
  private readonly settingsService: CursorProviderPorts["settings"];
  private readonly skillService: CursorProviderPorts["skills"];
  private readonly envService: { getEnv(): Record<string, string> };
  private readonly browserAutomationLease: ProviderHostPorts["browser"];
  private readonly threadControlMcp: {
    createHttpConnection(sessionId: string): Promise<ProviderThreadControlHttpConnection | undefined>;
    close(sessionId: string): Promise<void>;
  };

  constructor(
    private readonly host: ProviderHostPorts,
    private readonly cursorPorts: CursorProviderPorts,
    idleSessionTtlMs: number,
  ) {
    super();
    this.settingsService = cursorPorts.settings;
    this.skillService = cursorPorts.skills;
    this.envService = { getEnv: () => ({ ...host.environment.snapshot() }) };
    this.browserAutomationLease = host.browser;
    this.threadControlMcp = {
      createHttpConnection: async (sessionId) => {
        const threadId = sessionId.startsWith("mcode-") ? sessionId.slice(6) : sessionId;
        const connection = await host.threadControl.bootstrap({
          providerId: this.id,
          sessionId,
          threadId,
          protocol: "http",
        });
        return isThreadControlHttpConnection(connection) ? connection : undefined;
      },
      close: (sessionId) => host.threadControl.close(sessionId),
    };
    this.runtime = new SessionRuntime<CursorSessionState>(this, {
      jobObject: { isWindowsJob: false, assign: () => false, setDescription: () => undefined },
      processes: host.processes,
      envService: { getEnv: () => ({ ...this.host.environment.snapshot() }) },
      idleTtlMs: idleSessionTtlMs,
    });
  }

  /** Lists models by running `cursor-agent models` (falls back when discovery fails). */
  async listModels(): Promise<ProviderModelInfo[]> {
    const settings = this.cursorPorts.settings.get();

    for (const cliPath of cursorCliProbeBinaries(settings)) {
      const discovered = await fetchCursorCliModels(cliPath);
      if (discovered?.length) {
        return discovered;
      }
    }

    logger.info("Cursor listModels: using static fallback (CLI discovery unavailable)");
    return [...CURSOR_STATIC_MODEL_FALLBACK];
  }

  /** Queues an ACP `session/prompt` on the session subprocess (serialized per thread). */
  async sendTurn(req: TurnRequest<"cursor">): Promise<void> {
    void req.fallbackModel;
    void req.reasoningLevel;

    const {
      sessionId,
      message,
      cwd,
      model,
      permissionMode,
      attachments,
    } = req;
    // `resumeFrom` defined ⇒ resume the stored ACP session; undefined ⇒ fresh.
    const resume = req.resumeFrom !== undefined;
    if (req.resumeFrom !== undefined) {
      this.sdkSessionIds.set(sessionId, req.resumeFrom);
    }

    const threadId = sessionId.startsWith("mcode-") ? sessionId.slice(6) : sessionId;
    this.pendingTurnExecutionIds.set(sessionId, req.turnExecutionId);
    const emitTurnEvent = (event: AgentEvent): void => { this.emit("event", { ...event, turnExecutionId: req.turnExecutionId }); };
    const browserPermissionCapability = providerBrowserPermissionCapability(
      permissionMode,
      req.interactionMode,
    );
    const browserContext: CursorBrowserContext = {
      workspaceId: req.workspaceId,
      browserPermissionCapability,
    };

    // interactionMode absorbs the retired setPlanQuestionMode: a plan-mode Turn
    // suppresses Cursor's native auto-answer of ask_question; build clears it.
    // The flag is re-derived every Turn, so it is authoritative per Turn.
    if (req.interactionMode === "plan") {
      this.planQuestionModeThreads.add(threadId);
    } else {
      this.planQuestionModeThreads.delete(threadId);
    }

    let existing = this.runtime.get(sessionId);
    const pendingGrant = this.pendingBrowserGrants.get(sessionId);
    const pendingGrantContext = this.pendingBrowserGrantContext.get(sessionId);
    if (pendingGrant && (!pendingGrantContext || !this.sameBrowserContext(pendingGrantContext, browserContext))) {
      this.releaseBrowserLeases(pendingGrant);
      this.pendingBrowserGrants.delete(sessionId);
      this.pendingBrowserGrantContext.delete(sessionId);
    }
    // ACP callbacks are connection-scoped and carry no prompt id. Rotate a
    // completed session before the next logical turn so late notifications
    // stay bound to the old connection's immutable execution state.
    if (existing && existing.activeTurnState === null && existing.cursorPromptOrdinal > 0) {
      await this.runtime.stop(sessionId);
      existing = undefined;
    }
    let browserStage: BrowserAutomationSessionLeaseStage | undefined;
    if (existing) {
      const browserContextChanged =
        existing.workspaceId !== req.workspaceId ||
        existing.browserPermissionCapability !== browserPermissionCapability;
      const browserExpired = existing.browserCredential !== undefined &&
        existing.browserCredential.expiresAt <= Date.now();
      const acquireWillReplace = this.isStale(existing, { cwd, permissionMode });
      if (browserContextChanged || browserExpired || acquireWillReplace) {
        if (!browserContextChanged && browserExpired && existing.browserCredential) {
          const refreshed = this.browserAutomationLease.refresh(existing.browserCredential.leaseId);
          if (refreshed.ok) {
            this.pendingBrowserGrants.set(sessionId, refreshed.grant);
            this.pendingBrowserGrantContext.set(sessionId, browserContext);
            existing.browserCredential = undefined;
          }
        }
        if (acquireWillReplace && !this.pendingBrowserGrants.has(sessionId)) {
          browserStage = this.pendingBrowserLeases.get(sessionId);
          const stagedContext = this.pendingBrowserContext.get(sessionId);
          if (browserStage && (!stagedContext || !this.sameBrowserContext(stagedContext, browserContext))) {
            this.releaseBrowserLeases(browserStage);
            this.pendingBrowserLeases.delete(sessionId);
            this.pendingBrowserContext.delete(sessionId);
            browserStage = undefined;
          }
          if (this.browserAutomationLease.isConfigured() && !browserStage) {
            browserStage = this.browserAutomationLease.stage({
              providerId: this.id,
              providerSessionId: req.resumeFrom ?? sessionId,
              mcodeSessionId: sessionId,
              threadId: req.threadId,
              workspaceId: req.workspaceId,
              permissionCapability: browserPermissionCapability,
            });
            this.pendingBrowserLeases.set(sessionId, browserStage);
            this.pendingBrowserContext.set(sessionId, browserContext);
          }
        }
        await this.runtime.stop(sessionId);
      }
    }
    if (!this.runtime.get(sessionId)) {
      if (this.pendingBrowserGrants.has(sessionId)) {
        const staleStage = this.pendingBrowserLeases.get(sessionId);
        this.releaseBrowserLeases(staleStage);
        this.pendingBrowserLeases.delete(sessionId);
        this.pendingBrowserContext.delete(sessionId);
      } else {
        browserStage = this.pendingBrowserLeases.get(sessionId);
        const stagedContext = this.pendingBrowserContext.get(sessionId);
        if (browserStage && (!stagedContext || !this.sameBrowserContext(stagedContext, browserContext))) {
          this.releaseBrowserLeases(browserStage);
          this.pendingBrowserLeases.delete(sessionId);
          this.pendingBrowserContext.delete(sessionId);
          browserStage = undefined;
        }
      }
      if (
        this.browserAutomationLease.isConfigured() &&
        !browserStage &&
        !this.pendingBrowserGrants.has(sessionId)
      ) {
        browserStage = this.browserAutomationLease.stage({
          providerId: this.id,
          providerSessionId: req.resumeFrom ?? sessionId,
          mcodeSessionId: sessionId,
          threadId: req.threadId,
          workspaceId: req.workspaceId,
          permissionCapability: browserPermissionCapability,
        });
        this.pendingBrowserLeases.set(sessionId, browserStage);
        this.pendingBrowserContext.set(sessionId, browserContext);
      }
    }

    let entry: CursorSessionState;
    try {
      // The runtime discards a stale pooled session (dead child / cwd /
       // permission-mode mismatch, see `isStale`) and spawns a fresh one.
       // The server process port owns the returned child PID.
      entry = await this.runtime.acquire({
        sessionId,
        threadId,
        cwd,
        permissionMode,
        resumeFrom: resume ? this.sdkSessionIds.get(sessionId) : undefined,
      });
    } catch (err) {
      this.releaseBrowserLeases(browserStage);
      this.pendingBrowserLeases.delete(sessionId);
      this.pendingBrowserContext.delete(sessionId);
      const refreshed = this.pendingBrowserGrants.get(sessionId);
      this.releaseBrowserLeases(refreshed);
      this.pendingBrowserGrants.delete(sessionId);
      this.pendingBrowserGrantContext.delete(sessionId);
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error("Cursor ACP spawn failed", { sessionId, error: errMsg });
      emitTurnEvent({ type: AgentEventType.Error, threadId, error: errMsg } satisfies AgentEvent);
      emitTurnEvent({ type: AgentEventType.Ended, threadId, turnExecutionId: req.turnExecutionId } satisfies AgentEvent);
      if (this.pendingTurnExecutionIds.get(sessionId) === req.turnExecutionId) {
        this.pendingTurnExecutionIds.delete(sessionId);
      }
      return;
    }
    this.pendingBrowserLeases.delete(sessionId);
    this.pendingBrowserContext.delete(sessionId);
    if (browserStage && entry === existing) this.releaseBrowserLeases(browserStage);

    // A stop requested before the session finished spawning: tear it down now.
    if (this.pendingStops.delete(sessionId)) {
      logger.info("Pending stop consumed, tearing down new Cursor session", { sessionId });
      void this.runtime.stop(sessionId);
      emitTurnEvent({ type: AgentEventType.Ended, threadId, turnExecutionId: req.turnExecutionId } satisfies AgentEvent);
      if (this.pendingTurnExecutionIds.get(sessionId) === req.turnExecutionId) {
        this.pendingTurnExecutionIds.delete(sessionId);
      }
      return;
    }

    this.runtime.recordUsage(sessionId);
    entry.lastUsedAt = Date.now();
    const scheduled = entry.turnChain.then(() =>
      this.runTurn(entry, { message, model, resume, attachments, turnExecutionId: req.turnExecutionId }),
    );
    entry.turnChain = scheduled.then(
      () => {},
      () => {},
    );
    try {
      await scheduled;
    } finally {
      if (this.pendingTurnExecutionIds.get(sessionId) === req.turnExecutionId) {
        this.pendingTurnExecutionIds.delete(sessionId);
      }
    }
  }


  /**
   * Cancel the active ACP session. Once the logical ACP session is open, a stop
   * issues a graceful ACP cancel (and flags `pendingUserStopAbort` when a prompt
   * is in flight so the in-progress turn settles as a user stop) — the runtime
   * is not torn down, the warm session stays pooled for the next turn, matching
   * prior behavior. When the entry exists but the ACP session has not opened
   * yet, hand it to `runtime.stop` (interrupt → close → hard kill). Records a
   * pending stop if the session has not spawned at all.
   */
  async stopSession(sessionId: string): Promise<void> {
    const entry = this.runtime.get(sessionId);
    this.cancelPendingForThread(sessionId);
    if (entry?.acpSessionId && entry.activeTurnState) {
      entry.pendingUserStopAbort = true;
    }
    if (entry?.acpSessionId) {
      await entry.acpRuntime.cancel().catch(() => {});
    } else if (entry) {
      // Entry exists but ACP session hasn't opened yet; tear down immediately.
      const threadId = sessionId.startsWith("mcode-") ? sessionId.slice(6) : sessionId;
      const turnExecutionId = entry.activeTurnState
        ? this.turnExecutionByState.get(entry.activeTurnState)
        : this.pendingTurnExecutionIds.get(sessionId);
      await this.runtime.stop(sessionId);
      if (turnExecutionId) {
        this.emit("event", { type: AgentEventType.Ended, threadId, turnExecutionId } satisfies AgentEvent);
      }
    } else if (this.pendingAcpRuntimes?.has(sessionId)) {
      this.pendingStops.add(sessionId);
      await this.pendingAcpRuntimes?.get(sessionId)?.close();
    } else {
      this.pendingStops.add(sessionId);
      setTimeout(() => this.pendingStops.delete(sessionId), 10_000);
    }
  }

  /**
   * Force-discard the pooled session so the next sendTurn spawns fresh. Unlike
   * {@link stopSession} — which keeps a warm ACP session pooled and only issues
   * a graceful cancel — this tears the runtime down (interrupt → close → hard
   * kill), so a stale ACP connection is replaced rather than reused on retry.
   */
  async discardSession(sessionId: string): Promise<void> {
    if (this.runtime.get(sessionId) === undefined) return;
    await this.runtime.stop(sessionId);
  }


  /** Tear down all sessions, cancel pending permissions, and stop the eviction timer. */
  shutdown(): void {
    this.drainAllPendingCancelled();
    for (const [sessionId, runtime] of this.pendingAcpRuntimes ?? []) {
      this.pendingStops.add(sessionId);
      void runtime.close();
    }
    for (const sessionId of this.liveSessionIds) {
      this.browserAutomationLease.releaseSession(this.id, sessionId);
    }
    void this.runtime.shutdown().catch((err: unknown) => {
      logger.warn("Cursor runtime shutdown failed", { error: String(err) });
    });
    this.planQuestionModeThreads.clear();
    this.sdkSessionIds.clear();
    this.liveSessionIds.clear();
    for (const stage of this.pendingBrowserLeases.values()) {
      this.browserAutomationLease.release(stage.leaseId);
    }
    for (const grant of this.pendingBrowserGrants.values()) {
      this.browserAutomationLease.release(grant.leaseId);
    }
    this.pendingBrowserLeases.clear();
    this.pendingBrowserContext.clear();
    this.pendingBrowserGrants.clear();
    this.pendingBrowserGrantContext.clear();
    logger.info("CursorProvider shutdown complete");
  }

  resolvePermission(requestId: string, decision: PermissionDecision): boolean {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return false;
    this.pendingPermissions.delete(requestId);
    try {
      this.emit("permission_resolved", { requestId, decision });
    } catch {
      /* ignore subscriber errors */
    }
    pending.resolve({ outcome: mapDecisionToAcpOutcome(decision, pending.options) });
    return true;
  }

  listPendingPermissions(threadId: string): PermissionRequest[] {
    const out: PermissionRequest[] = [];
    for (const p of this.pendingPermissions.values()) {
      if (p.threadId === threadId) out.push(p.request);
    }
    return out;
  }

  /**
   * Invoked once the SkillWatcher debouncer finishes flushing filesystem events so
   * sticky Cursor preambles can pick up regenerated skill inventories.
   */
  onSkillRegistryDebouncedInvalidation(): void {
    for (const id of this.liveSessionIds) {
      const e = this.runtime.get(id);
      if (e) e.stickyHeavyInstructionsSent = false;
    }
  }

  private cancelPendingForThread(mcodeSessionId: string): void {
    for (const [requestId, p] of this.pendingPermissions) {
      if (p.mcodeSessionId !== mcodeSessionId) continue;
      this.pendingPermissions.delete(requestId);
      p.resolve({ outcome: { outcome: "cancelled" } });
      try {
        this.emit("permission_resolved", { requestId, decision: "cancelled" });
      } catch {
        /* ignore */
      }
    }
  }

  private drainAllPendingCancelled(): void {
    for (const [requestId, p] of this.pendingPermissions) {
      p.resolve({ outcome: { outcome: "cancelled" } });
      try {
        this.emit("permission_resolved", { requestId, decision: "cancelled" });
      } catch {
        /* ignore */
      }
    }
    this.pendingPermissions.clear();
  }

  /**
   * Spawns a fresh Cursor ACP session for the runtime: launches the
   * `cursor-agent acp` subprocess (probing CLI candidates), runs the ACP
   * `initialize`/`authenticate` handshake, then opens the logical ACP session
   * (`session/load` on resume, falling back to `session/new`). Returns the
   * child PID in `pids` so the runtime routes cleanup through the server process
   * port. The provider does not manage process trees inline.
   */
  async spawn(args: SpawnArgs): Promise<SpawnResult<CursorSessionState>> {
    const { sessionId, threadId, cwd, permissionMode, resumeFrom } = args;
    const pm: "full" | "default" = permissionMode === "full" ? "full" : "default";
    const settings = this.settingsService.get();
    const browserStage = this.pendingBrowserLeases.get(sessionId);
    const refreshedGrant = this.pendingBrowserGrants.get(sessionId);
    let browserGrant: BrowserAutomationSessionLeaseGrant | null = null;
    let state: CursorAcpSessionEntry | undefined;
    try {
      state = await this.spawnChild(sessionId, threadId, cwd, pm, settings);
      if (this.pendingStops?.has(sessionId)) {
        throw new Error("Cursor ACP session stopped during startup");
      }
      if (state.browserHttpMcpSupported) {
        if (refreshedGrant) {
          browserGrant = refreshedGrant;
          this.pendingBrowserGrants.delete(sessionId);
          this.pendingBrowserGrantContext.delete(sessionId);
          if (browserStage) this.releaseBrowserLeases(browserStage);
        } else if (browserStage) {
          browserGrant = this.browserAutomationLease.issue(browserStage);
          if (!browserGrant) {
            throw new Error("Cursor browser automation lease issuance failed");
          }
        }
      } else {
        this.releaseBrowserLeases(browserStage, refreshedGrant);
        this.browserAutomationLease.releaseSession(this.id, sessionId);
        this.pendingBrowserGrants.delete(sessionId);
        this.pendingBrowserGrantContext.delete(sessionId);
      }
      if (browserStage && !state.browserHttpMcpSupported) {
        logger.info("Cursor ACP does not advertise HTTP MCP; browser automation is unavailable", {
          threadId,
        });
      }
      const mcpServers = buildCursorBrowserMcpServers(browserGrant);

      // Open logical ACP session before runtime registration so every setup
      // failure tears down child and browser state through one boundary.
      state.mcodeLogicalSessionReloaded = await this.openLogicalSession(
        state,
        resumeFrom !== undefined,
        mcpServers,
      );
      if (this.pendingStops?.has(sessionId)) {
        throw new Error("Cursor ACP session stopped during startup");
      }
      state.mcodeRuntimeInstructions = renderMcodeInstructions(buildMcodeInstructionPlan({
        sourceThreadId: threadId,
        threadControlGranted: true,
        browserAutomationGranted: Boolean(browserGrant),
      }));
      state.mcodeRuntimeInstructionsSent = false;
      if (browserGrant) {
        state.browserCredential = {
          credentialId: browserGrant.credentialId,
          expiresAt: browserGrant.expiresAt,
          leaseId: browserGrant.leaseId,
        };
      }
    } catch (err) {
      await this.cleanupSpawnFailure(sessionId, state, browserGrant, browserStage, refreshedGrant);
      this.pendingStops?.delete(sessionId);
      this.pendingAcpRuntimes?.delete(sessionId);
      await this.threadControlMcp?.close(sessionId);
      throw err;
    }

    this.pendingAcpRuntimes?.delete(sessionId);
    this.liveSessionIds.add(sessionId);
    return { state, pids: state.child.pid != null ? [state.child.pid] : [] };
  }

  /** Eviction guard: a turn is in flight while `activeTurnState` is set. */
  isBusy(state: CursorSessionState): boolean {
    return state.activeTurnState != null;
  }

  /**
   * Graceful protocol interrupt: ACP `session/cancel` for the open logical
   * session. Does not kill the child — the runtime's hard kill handles the OS
   * process via the surfaced PID.
   */
  async interrupt(state: CursorSessionState): Promise<void> {
    state.pendingUserStopAbort = false;
    if (state.acpSessionId) {
      await state.acpRuntime.cancel().catch(() => {});
    }
  }

  /**
   * Provider teardown that is not the OS kill: cancel any pending permissions
   * for this session (so orphaned approval cards clear) and drop it from the
   * live-id mirror. The child process is killed by the runtime's hard kill.
   */
  async close(state: CursorSessionState): Promise<void> {
    this.cancelPendingForThread(state.mcodeSessionId);
    this.liveSessionIds.delete(state.mcodeSessionId);
    if (!this.pendingBrowserGrants.has(state.mcodeSessionId) && !this.pendingBrowserLeases.has(state.mcodeSessionId)) {
      this.browserAutomationLease.releaseSession(this.id, state.mcodeSessionId);
    }
    await this.threadControlMcp?.close(state.mcodeSessionId);
  }

  private sameBrowserContext(left: CursorBrowserContext, right: CursorBrowserContext): boolean {
    return left.workspaceId === right.workspaceId &&
      left.browserPermissionCapability === right.browserPermissionCapability;
  }

  private releaseBrowserLeases(...leases: Array<{ leaseId: string } | null | undefined>): void {
    const released = new Set<string>();
    for (const lease of leases) {
      if (!lease || released.has(lease.leaseId)) continue;
      released.add(lease.leaseId);
      this.browserAutomationLease.release(lease.leaseId);
    }
  }

  private async cleanupSpawnFailure(
    sessionId: string,
    state: CursorAcpSessionEntry | undefined,
    ...leases: Array<{ leaseId: string } | null | undefined>
  ): Promise<void> {
    this.releaseBrowserLeases(...leases);
    this.browserAutomationLease.releaseSession(this.id, sessionId);
    this.pendingBrowserLeases.delete(sessionId);
    this.pendingBrowserContext.delete(sessionId);
    this.pendingBrowserGrants.delete(sessionId);
    this.pendingBrowserGrantContext.delete(sessionId);
    this.liveSessionIds.delete(sessionId);
    await state?.acpRuntime?.close();
  }

  /** A pooled session must be discarded before reuse if the child died or the cwd/permission mode changed. */
  isStale(state: CursorSessionState, args: { cwd: string; permissionMode: string }): boolean {
    const dead = state.child.exitCode != null || state.child.signalCode != null;
    if (dead) return true;
    const pm: "full" | "default" = args.permissionMode === "full" ? "full" : "default";
    return state.permissionMode !== pm || state.cwd !== args.cwd;
  }

  private async spawnChild(
    mcodeSessionId: string,
    threadId: string,
    cwd: string,
    permissionMode: "full" | "default",
    settings: Settings,
  ): Promise<CursorAcpSessionEntry> {
    const cliCandidates = cursorCliProbeBinaries(settings);
    let lastErr: unknown = null;
    for (const cliPath of cliCandidates) {
      try {
        return await this.spawnOneCli(cliPath, mcodeSessionId, threadId, cwd, permissionMode);
      } catch (e) {
        this.pendingAcpRuntimes?.delete(mcodeSessionId);
        lastErr = e;
        const msg = e instanceof Error ? e.message : String(e);
        if (/Failed to spawn cursor-agent/i.test(msg)) continue;
        break;
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error(String(lastErr ?? "Failed to spawn cursor-agent (acp)"));
  }

  private async spawnOneCli(
    cliPath: string,
    mcodeSessionId: string,
    threadId: string,
    cwd: string,
    permissionMode: "full" | "default",
  ): Promise<CursorAcpSessionEntry> {
    const args = buildCursorAcpArgs({ permissionMode });
    let entry!: CursorAcpSessionEntry;
    const acpRuntime = await AcpSessionRuntime.start({
      spawnSpec: {
        command: cliPath,
        args,
        cwd,
        env: this.envService.getEnv(),
      },
      callbacks: {
        onPermissionRequest: async (request) => this.bridgePermission(entry, request),
        onSessionUpdate: async (update) => this.deliverSessionUpdate(entry, update),
        readTextFile: async (filePath) => this.safeReadWorkspaceFile(cwd, filePath),
        writeTextFile: async (filePath, content) => this.safeWriteWorkspaceFile(cwd, filePath, content),
        onExtensionRequest: async () => ({}),
        onExtensionNotification: async () => {},
      },
      clientFactory: (callbacks) => {
        return {
          requestPermission: async (request) => {
            if (!entry) return { outcome: { outcome: "cancelled" } };
            return this.bridgePermission(entry, request);
          },
          sessionUpdate: callbacks.onSessionUpdate,
          readTextFile: async ({ path: filePath }) => ({
            content: entry ? this.safeReadWorkspaceFile(entry.cwd, filePath) : "",
          }),
          writeTextFile: async ({ path: filePath, content }) => {
            if (!entry) throw new Error("Cursor ACP session is not ready");
            this.safeWriteWorkspaceFile(entry.cwd, filePath, content);
            return {};
          },
          extMethod: async (method, params) => {
            if (!entry) return {};
            const client = this.buildAcpClient(entry);
            return client.extMethod ? (await client.extMethod(method, params)) ?? {} : {};
          },
          extNotification: async (method, params) => {
            if (!entry) return;
            const client = this.buildAcpClient(entry);
            if (client.extNotification) await client.extNotification(method, params);
          },
        };
      },
      selectAuthMethod: (methods) => methods.find((method) => method.id === "cursor_login")?.id ?? methods[0]?.id,
      ignoreAuthenticationErrors: true,
      processes: this.host.processes,
    });
    (this.pendingAcpRuntimes ??= new Map()).set(mcodeSessionId, acpRuntime);
    const child = acpRuntime.state.child;
    const connection = acpRuntime.state.connection;
    entry = {
      workspaceId: this.pendingBrowserContext.get(mcodeSessionId)?.workspaceId ?? "unknown-workspace",
      browserPermissionCapability:
        this.pendingBrowserContext.get(mcodeSessionId)?.browserPermissionCapability ?? "interact",
      browserHttpMcpSupported: false,
      mcodeSessionId,
      threadId,
      child,
      connection,
      acpRuntime,
      acpSessionId: "",
      cwd,
      permissionMode,
      lastUsedAt: Date.now(),
      todoSnapshot: createCursorTodoSnapshot(),
      turnChain: Promise.resolve(),
      activeTurnState: null,
      stickyHeavyInstructionsSent: false,
      cursorPromptOrdinal: 0,
      stderrTailLines: [],
      cursorModelAppliedPair: null,
      pendingUserStopAbort: false,
      supportsHttpMcp: false,
      mcodeRuntimeInstructions: "",
      mcodeRuntimeInstructionsSent: false,
      mcodeLogicalSessionReloaded: false,
    };

    child.stderr?.on("data", (chunk: Buffer) => {
      const verboseLogs = this.settingsService.get().provider.cursor.verboseFailureLogs;
      for (const line of chunk.toString().split("\n")) {
        const trimmed = line.trim();
        if (trimmed) {
          if (verboseLogs) {
            logger.debug("cursor-agent acp stderr", { threadId, line: trimmed });
          }
          const tail = entry.stderrTailLines;
          tail.push(trimmed.slice(0, 2000));
          while (tail.length > CURSOR_STDERR_TAIL_MAX) tail.shift();
        }
      }
    });

    child.on("exit", () => {
      const pooled = this.runtime.get(mcodeSessionId);
      // After ACP respawn, the same sessionId maps to a new child; ignore stale exits.
      if (pooled?.child !== child) return;
      this.cancelPendingForThread(mcodeSessionId);
      // The child died unexpectedly; ask the runtime to drop the pooled entry
      // (runs interrupt → close → hard kill of the already-dead PID, all no-ops
      // here beyond removing it from the pool).
      void this.runtime.stop(mcodeSessionId);
    });

    const initResult = await acpRuntime.initialize() as { agentCapabilities?: { mcpCapabilities?: { http?: boolean } } };
    const supportsHttpMcp = cursorSupportsHttpMcp(initResult);
    entry.browserHttpMcpSupported = supportsHttpMcp;
    entry.supportsHttpMcp = supportsHttpMcp;

    return entry as CursorAcpSessionEntry;
  }

  /**
   * Runs the ACP `initialize` handshake and a best-effort `authenticate` on a
   * fresh connection. Shared by the pooled session spawn and the throwaway
   * side-channel transport.
   */
  private async acpHandshake(connection: ClientSideConnection, threadId: string): Promise<boolean> {
    const initResult = validateAcpInitializeResult(await connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: "mcode", title: "Mcode", version: "0.0.1" },
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
      },
    }));

    const authMethods = initResult.authMethods ?? [];
    const methodId =
      authMethods.find((method: { id: string }) => method.id === "cursor_login")?.id ?? authMethods[0]?.id;
    if (methodId) {
      await connection.authenticate({ methodId }).catch((err: unknown) => {
        logger.info("Cursor ACP authenticate noop", {
          threadId,
          error: String(err),
        });
      });
    }
    return cursorSupportsHttpMcp(initResult);
  }

  private buildAcpClient(entry: CursorAcpSessionEntry): Client {
    const emitAcpEvent = (event: AgentEvent): void => {
      const executionId = entry.activeTurnState
        ? this.turnExecutionByState.get(entry.activeTurnState)
        : undefined;
      this.emit("event", executionId ? { ...event, turnExecutionId: executionId } : event);
    };
    return {
      requestPermission: async (req) => this.bridgePermission(entry, req),
      sessionUpdate: async (params) => this.deliverSessionUpdate(entry, params),
      readTextFile: async (r) => ({ content: this.safeReadWorkspaceFile(entry.cwd, r.path) }),
      writeTextFile: async (r) => {
        this.safeWriteWorkspaceFile(entry.cwd, r.path, r.content);
        return {};
      },
      extMethod: async (method, params) => {
        const cursorPrefs = this.settingsService.get().provider.cursor;
        if (method === "cursor/ask_question") {
          const record =
            params !== null && typeof params === "object" && !Array.isArray(params)
              ? (params as Record<string, unknown>)
              : {};
          const inPlanQuestionMode = this.planQuestionModeThreads.has(entry.threadId);
          const autoAnswer =
            !inPlanQuestionMode && cursorPrefs.autoAnswerAskQuestions;
          return buildCursorAskQuestionExtResponse(
            record,
            autoAnswer,
            (summary) => {
              logger.info("Cursor ask_question resolved automatically", {
                threadId: entry.threadId,
                detail: summary.lines,
              });
              if (cursorPrefs.echoAskQuestionsToTimeline) {
                const clip = summary.lines.join(" · ").slice(0, 900);
                emitAcpEvent({
                  type: AgentEventType.System,
                  threadId: entry.threadId,
                  subtype: `cursor:ask_question:auto:${clip}`,
                } satisfies AgentEvent);
              }
            },
          );
        }
        if (method === "cursor/create_plan") {
          const record =
            params !== null && typeof params === "object" && !Array.isArray(params)
              ? (params as Record<string, unknown>)
              : {};
          const planMarkdown = extractCursorCreatePlanMarkdown(record);
          if (planMarkdown) {
            this.emit("exit_plan_mode", {
              threadId: entry.threadId,
              planMarkdown,
            });
          } else {
            logger.warn("cursor/create_plan missing plan markdown", {
              threadId: entry.threadId,
              keys: Object.keys(record),
            });
          }
          return { outcome: { outcome: "accepted" } };
        }
        if (method === "cursor/task") {
          const record =
            params !== null && typeof params === "object" && !Array.isArray(params)
              ? (params as Record<string, unknown>)
              : null;
          if (!entry.activeTurnState || !record) return CURSOR_ACP_UNSUPPORTED_RESULT;
          const events = cursorTaskExtToAgentEvents(
            entry.threadId,
            record,
            entry.activeTurnState,
          );
          for (const ev of events) {
            emitAcpEvent(ev);
          }
          return {};
        }
        // cursor/update_todos arrives as a request (not notification) in the
        // ACP SDK dispatch. Handle it here so the task panel stays in sync.
        if (method === "cursor/update_todos") {
          if (params === null || typeof params !== "object" || Array.isArray(params)) {
            return CURSOR_ACP_UNSUPPORTED_RESULT;
          }
          const events = cursorUpdateTodosExtNotificationToAgentEvents(
            entry.threadId,
            params as Record<string, unknown>,
            entry.todoSnapshot,
          );
          for (const ev of events) {
            emitAcpEvent(ev);
          }
          return {};
        }
        logger.debug("Cursor ACP extMethod unhandled", {
          threadId: entry.threadId,
          method,
        });
        return CURSOR_ACP_UNSUPPORTED_RESULT;
      },
      extNotification: async (method, params) => {
        if (
          method === "cursor/update_todos" &&
          params !== null &&
          typeof params === "object" &&
          !Array.isArray(params)
        ) {
          const events = cursorUpdateTodosExtNotificationToAgentEvents(
            entry.threadId,
            params as Record<string, unknown>,
            entry.todoSnapshot,
          );
          for (const ev of events) {
          emitAcpEvent(ev);
          }
          return;
        }
        void method;
        void params;
      },
    };
  }

  private async bridgePermission(
    entry: CursorAcpSessionEntry,
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    if (entry.permissionMode === "full") {
      const optionId = pickFullAccessAllowOption(params.options);
      if (!optionId) return { outcome: { outcome: "cancelled" } };
      return { outcome: { outcome: "selected", optionId } };
    }

    const requestId = randomUUID();
    const toolTitle = typeof params.toolCall.title === "string" ? params.toolCall.title : "Tool";
    const request = synthesizeCursorAcpPermissionRequest({
      requestId,
      threadId: entry.threadId,
      toolTitle,
      rawToolInput: params.toolCall.rawInput,
    });

    return await new Promise((resolve) => {
      this.pendingPermissions.set(requestId, {
        mcodeSessionId: entry.mcodeSessionId,
        threadId: entry.threadId,
        options: params.options,
        request,
        resolve,
      });
      queueMicrotask(() => {
        try {
          this.emit("permission_request", request);
        } catch {
          /* ignore */
        }
      });
    });
  }

  private async deliverSessionUpdate(
    entry: CursorAcpSessionEntry,
    params: SessionNotification,
  ): Promise<void> {
    if (!entry.acpSessionId || params.sessionId !== entry.acpSessionId) return;
    const state = entry.activeTurnState;
    if (!state) return;

    const mapped = mapCursorAcpSessionNotification(
      params,
      entry.threadId,
      state,
      entry.todoSnapshot,
    );

    const cursorCfg = this.settingsService.get().provider.cursor;
    if (
      cursorCfg.traceSessionUpdates &&
      shouldEmitCursorSessionTrace(params, mapped.length)
    ) {
      logger.info("Cursor ACP session/update trace", {
        threadId: entry.threadId,
        mappedCount: mapped.length,
        notification: summarizeCursorSessionNotification(params),
        mappedEvents: summarizeEmittedAgentEventsForTrace(mapped),
      });
    }

    for (const ev of mapped) {
      const executionId = this.turnExecutionByState.get(state);
      this.emit("event", executionId ? { ...ev, turnExecutionId: executionId } : ev);
    }
  }

  private safeReadWorkspaceFile(cwd: string, filePath: string): string {
    const root = path.resolve(cwd);
    const resolved = path.resolve(root, filePath);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return "";
    try {
      if (!existsSync(resolved)) return "";
      return readFileSync(resolved, "utf-8");
    } catch {
      return "";
    }
  }

  private safeWriteWorkspaceFile(cwd: string, filePath: string, content: string): void {
    const root = path.resolve(cwd);
    const resolved = path.resolve(root, filePath);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error("Path outside workspace root");
    }
    mkdirSync(path.dirname(resolved), { recursive: true });
    writeFileSync(resolved, content, "utf-8");
  }

  /** Ensures `entry.acpSessionId` is ready (new or load). */
  private async openLogicalSession(
    entry: CursorAcpSessionEntry,
    resume: boolean,
    mcpServers: McpServer[] = [],
  ): Promise<boolean> {
    if (entry.acpSessionId) return true;

    const stored = this.sdkSessionIds.get(entry.mcodeSessionId);
    const internalMcp = entry.supportsHttpMcp
      ? await this.threadControlMcp?.createHttpConnection(entry.mcodeSessionId)
      : undefined;
    const effectiveMcpServers = [
      ...(internalMcp ? buildCursorInternalMcpServers(internalMcp) : []),
      ...mcpServers,
    ];
    const opened = await entry.acpRuntime.openSession({
      resumeFrom: resume ? stored : undefined,
      cwd: entry.cwd,
      mcpServers: effectiveMcpServers,
    });
    entry.acpSessionId = opened.sessionId;
    this.sdkSessionIds.set(entry.mcodeSessionId, opened.sessionId);
    this.emit("event", {
      type: AgentEventType.System,
      threadId: entry.threadId,
      subtype: `sdk_session_id:${opened.sessionId}`,
    } satisfies AgentEvent);
    return opened.reloaded;
  }

  private async applyModel(entry: CursorAcpSessionEntry, model: string): Promise<void> {
    const trimmed = model.trim();
    if (!trimmed || !entry.acpSessionId) return;

    const paired = entry.cursorModelAppliedPair;
    if (
      paired &&
      paired.acpSessionId === entry.acpSessionId &&
      paired.modelId === trimmed
    ) {
      return;
    }

    try {
      await entry.connection.unstable_setSessionModel({
        sessionId: entry.acpSessionId,
        modelId: trimmed,
      });
      entry.cursorModelAppliedPair = { acpSessionId: entry.acpSessionId, modelId: trimmed };
    } catch (err: unknown) {
      entry.cursorModelAppliedPair = null;
      logger.debug("Cursor ACP setSessionModel noop", {
        threadId: entry.threadId,
        error: String(err),
      });
    }
  }

  /** Respawns `cursor-agent acp` after an unexpected disconnect and preserves turn pacing state. */
  private async respawnCursorSessionAfterAcpClose(
    dead: CursorAcpSessionEntry,
  ): Promise<CursorAcpSessionEntry> {
    const sessionId = dead.mcodeSessionId;
    this.logAcpChildDisconnect(dead, "ACP connection closed");
    await this.runtime.stop(sessionId);
    const browserStage = this.browserAutomationLease.isConfigured() && dead.browserHttpMcpSupported
      ? this.browserAutomationLease.stage({
        providerId: this.id,
        providerSessionId: this.sdkSessionIds.get(sessionId) ?? sessionId,
        mcodeSessionId: sessionId,
        threadId: dead.threadId,
        workspaceId: dead.workspaceId,
        permissionCapability: dead.browserPermissionCapability,
      })
      : undefined;
    if (browserStage) {
      this.pendingBrowserLeases.set(sessionId, browserStage);
      this.pendingBrowserContext.set(sessionId, {
        workspaceId: dead.workspaceId,
        browserPermissionCapability: dead.browserPermissionCapability,
      });
    }
    let fresh: CursorAcpSessionEntry;
    try {
      fresh = await this.runtime.acquire({
        sessionId,
        threadId: dead.threadId,
        cwd: dead.cwd,
        permissionMode: dead.permissionMode,
        resumeFrom: this.sdkSessionIds.get(sessionId),
      });
    } catch (error) {
      if (browserStage) this.browserAutomationLease.release(browserStage.leaseId);
      this.pendingBrowserLeases.delete(sessionId);
      this.pendingBrowserContext.delete(sessionId);
      throw error;
    }
    this.pendingBrowserLeases.delete(sessionId);
    this.pendingBrowserContext.delete(sessionId);
    fresh.stickyHeavyInstructionsSent = dead.stickyHeavyInstructionsSent;
    fresh.cursorPromptOrdinal = dead.cursorPromptOrdinal;
    fresh.mcodeRuntimeInstructionsSent = carryCursorMcodeSentState(
      fresh.mcodeLogicalSessionReloaded,
      dead.mcodeRuntimeInstructionsSent,
    );
    fresh.lastUsedAt = Date.now();
    logger.info("Cursor ACP subprocess respawned after disconnect", {
      threadId: fresh.threadId,
      acpSessionId: this.sdkSessionIds.get(sessionId),
      childPid: fresh.child.pid,
    });
    return fresh;
  }

  /** Logs child exit metadata when the ACP stdio stream closes mid-turn. */
  private logAcpChildDisconnect(entry: CursorAcpSessionEntry, error: string): void {
    const cursorCfg = this.settingsService.get().provider.cursor;
    const stderrTail =
      cursorCfg.verboseFailureLogs && entry.stderrTailLines.length > 0
        ? entry.stderrTailLines.slice(-16)
        : undefined;
    logger.warn("Cursor ACP connection closed mid-turn", {
      threadId: entry.threadId,
      acpSessionId: entry.acpSessionId,
      promptOrdinal: entry.cursorPromptOrdinal,
      childPid: entry.child.pid,
      childExitCode: entry.child.exitCode,
      childSignalCode: entry.child.signalCode,
      verboseFailureLogs: cursorCfg.verboseFailureLogs,
      stderrTail,
      error,
    });
  }

  private async runTurn(
    entry: CursorAcpSessionEntry,
    opts: {
      message: string;
      model: string;
      resume: boolean;
      attachments?: AttachmentMeta[];
      turnExecutionId: string;
    },
  ): Promise<void> {
    const { message, model, resume, attachments, turnExecutionId } = opts;
    const emitTurnEvent = (event: AgentEvent): void => { this.emit("event", { ...event, turnExecutionId }); };
    const cursorCfg = this.settingsService.get().provider.cursor;
    let currentEntry = entry;
    let promptMessage = message;
    let promptAttachments = attachments;
    const originalUserMessage = message;
    const originalAttachments = attachments;
    let isContinueRetry = false;
    let instructionMarkdown: string | undefined;
    let instructionMarkdownReady = false;
    try {
      currentEntry.cursorPromptOrdinal += 1;
      if (
        !cursorCfg.alwaysSendFullInstructions &&
        cursorCfg.fullPreambleEveryNTurns > 0 &&
        currentEntry.cursorPromptOrdinal % cursorCfg.fullPreambleEveryNTurns === 0
      ) {
        currentEntry.stickyHeavyInstructionsSent = false;
      }

      const maxAttempts = cursorCfg.retryTransientFailuresOnce ? 2 : 1;
      let promptResponse: Awaited<ReturnType<ClientSideConnection["prompt"]>>;
      let attempt = 0;
      for (;;) {
        await this.openLogicalSession(currentEntry, resume);
        await this.applyModel(currentEntry, model);
        currentEntry.stderrTailLines.length = 0;

        let blocks;
        let mcodeInstructionsIncluded = false;
        if (isContinueRetry) {
          const continuationInstructions = currentEntry.mcodeRuntimeInstructionsSent
            ? undefined
            : currentEntry.mcodeRuntimeInstructions;
          blocks = buildCursorAcpPromptBlocks(
            promptMessage,
            promptAttachments,
            continuationInstructions,
          );
          mcodeInstructionsIncluded = Boolean(continuationInstructions);
        } else {
          if (!instructionMarkdownReady) {
            const guidance = buildCursorAgentGuidanceMarkdown(currentEntry.cwd);
            const skillsBlock = formatCursorSkillsAndCommandsForPrompt(
              this.skillService.list(currentEntry.cwd, "cursor"),
            );
            const instructionParts = [guidance, skillsBlock].filter(
              (s): s is string => typeof s === "string" && s.length > 0,
            );
            const combined =
              instructionParts.length > 0 ? instructionParts.join("\n\n---\n\n") : undefined;

            if (cursorCfg.alwaysSendFullInstructions) {
              instructionMarkdown = combined ?? readCursorUserInstructions();
            } else {
              const { instructionMarkdown: blob, markHeavyCommitted } =
                resolveCursorStickyInstructionBlob({
                  combinedGuidanceAndSkillsMarkdown: combined,
                  readFallbackAgents: readCursorUserInstructions,
                  stickyHeavyCommitted: currentEntry.stickyHeavyInstructionsSent,
                });
              instructionMarkdown = blob;
              if (markHeavyCommitted) {
                currentEntry.stickyHeavyInstructionsSent = true;
              }
            }
            instructionMarkdownReady = true;
            const mcode = appendCursorMcodeInstructions(
              instructionMarkdown,
              currentEntry.mcodeRuntimeInstructions,
              currentEntry.mcodeRuntimeInstructionsSent,
            );
            instructionMarkdown = mcode.instructionMarkdown;
            mcodeInstructionsIncluded = mcode.included;
          }
          blocks = buildCursorAcpPromptBlocks(
            promptMessage,
            promptAttachments,
            instructionMarkdown,
          );
          mcodeInstructionsIncluded = Boolean(
            !currentEntry.mcodeRuntimeInstructionsSent &&
              currentEntry.mcodeRuntimeInstructions &&
              instructionMarkdown?.includes(currentEntry.mcodeRuntimeInstructions),
          );
        }

        try {
          attempt += 1;
          currentEntry.activeTurnState = createCursorAcpTurnState();
          this.turnExecutionByState.set(currentEntry.activeTurnState, turnExecutionId);
          promptResponse = await currentEntry.acpRuntime.prompt({
            sessionId: currentEntry.acpSessionId,
            prompt: blocks,
          });
          if (mcodeInstructionsIncluded) currentEntry.mcodeRuntimeInstructionsSent = true;
          break;
        } catch (attemptErr) {
          const raw = attemptErr instanceof Error ? attemptErr.message : String(attemptErr);
          // Do not retry after explicit Stop; cancel-like errors are expected and a
          // second prompt would fight the user's abort.
          if (currentEntry.pendingUserStopAbort) {
            throw attemptErr;
          }
          if (
            attempt >= maxAttempts ||
            !cursorCfg.retryTransientFailuresOnce ||
            !isLikelyTransientCursorPromptFailure(raw)
          ) {
            throw attemptErr;
          }
          if (looksLikeAcpConnectionClosed(raw)) {
            currentEntry = await this.respawnCursorSessionAfterAcpClose(currentEntry);
            promptMessage = buildCursorAcpContinueAfterDisconnectPrompt(originalUserMessage);
            promptAttachments = originalAttachments;
            isContinueRetry = true;
            continue;
          }
          // Rate limit (`resource_exhausted`): the backend rejected the request
          // before doing any work, so resend the SAME prompt after a jittered
          // backoff. The wait stays invisible in the thread — runTurn emits no
          // Error/Ended while it sleeps, so the turn reads as ordinary latency.
          if (looksLikeCursorRateLimit(raw)) {
            const backoffMs = computeCursorRateLimitBackoffMs(cursorCfg.rateLimitRetryBackoffMs);
            logger.warn("Cursor ACP prompt rate-limited; backing off before one retry", {
              threadId: currentEntry.threadId,
              attempt,
              backoffMs,
              error: raw,
            });
            await interruptibleDelay(backoffMs, () => currentEntry.pendingUserStopAbort);
            if (currentEntry.pendingUserStopAbort) {
              throw attemptErr;
            }
            continue;
          }
          logger.warn("Cursor ACP prompt retry after transient CLI failure", {
            threadId: currentEntry.threadId,
            attempt,
            error: raw,
          });
        }
      }

      const text = resolveCursorAssistantMessageContent(currentEntry.activeTurnState.accumulator);
      if (text.length > 0) {
        emitTurnEvent({
          type: AgentEventType.Message,
          threadId: currentEntry.threadId,
          content: text,
          tokens: null,
        } satisfies AgentEvent);
      }

      const usage = promptResponse.usage;
      emitTurnEvent({
        type: AgentEventType.TurnComplete,
        threadId: currentEntry.threadId,
        reason: promptResponse.stopReason,
        costUsd: null,
        tokensIn: usage?.inputTokens ?? 0,
        tokensOut: usage?.outputTokens ?? 0,
        providerId: "cursor",
      } satisfies AgentEvent);

      emitTurnEvent({
        type: AgentEventType.Ended,
        threadId: currentEntry.threadId,
        turnExecutionId,
      } satisfies AgentEvent);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const userStoppedStream = shouldSuppressCursorPromptError(errMsg, {
        pendingUserStopAbort: currentEntry.pendingUserStopAbort,
      });
      const stderrTail =
        cursorCfg.verboseFailureLogs && currentEntry.stderrTailLines.length > 0
          ? currentEntry.stderrTailLines.slice(-16)
          : undefined;
      if (!userStoppedStream) {
        logger.error("Cursor ACP prompt failed", {
          threadId: currentEntry.threadId,
          stickyHeavyCommitted: currentEntry.stickyHeavyInstructionsSent,
          promptOrdinal: currentEntry.cursorPromptOrdinal,
          acpSessionId: currentEntry.acpSessionId,
          verboseFailureLogs: cursorCfg.verboseFailureLogs,
          childPid: currentEntry.child.pid,
          childExitCode: currentEntry.child.exitCode,
          childSignalCode: currentEntry.child.signalCode,
          stderrTail,
          error: errMsg,
        });
        emitTurnEvent({
          type: AgentEventType.Error,
          threadId: currentEntry.threadId,
          error: errMsg,
        } satisfies AgentEvent);
      } else {
        logger.info("Cursor prompt ended after Stop (expected disconnect)", {
          threadId: currentEntry.threadId,
          errorSample: errMsg.slice(0, 200),
        });
        const interrupted =
          currentEntry.activeTurnState?.accumulator !== undefined
            ? resolveCursorAssistantMessageContent(currentEntry.activeTurnState.accumulator).trim()
            : "";
        if (interrupted.length > 0) {
          emitTurnEvent({
            type: AgentEventType.Message,
            threadId: currentEntry.threadId,
            content: interrupted,
            tokens: null,
          } satisfies AgentEvent);
        }
      }
      emitTurnEvent({
        type: AgentEventType.Ended,
        threadId: currentEntry.threadId,
        turnExecutionId,
      } satisfies AgentEvent);
    } finally {
      currentEntry.activeTurnState = null;
      currentEntry.pendingUserStopAbort = false;
    }
  }

  /**
   * Clean side-channel handoff query (path B). Reconstructs the parent thread's
   * persisted Cursor session into a throwaway ACP connection, runs the summary
   * prompt against that fork, and returns the assistant text. It writes nothing
   * to the parent thread's `messages` table and emits no provider events, so the
   * canonical session is left exactly as it was. The throwaway subprocess is
   * killed before returning.
   *
   * Because loading the same session id into a second connection branches the
   * conversation rather than advancing the canonical server-side session, the
   * parent is never mutated.
   *
   * Falls back to a transient (path-D) error when there is no persisted session
   * to reconstruct, the load fails, or the fork produces no text — the pipeline
   * then builds a deterministic handoff instead of mutating the parent.
   * `conversationHistory` (the sessionless B-prime body Claude uses) is not
   * consumed here: the slice's contract is a clean reconstruction of the
   * persisted session, so a missing/unresumable session degrades to path D.
   */
  async runSideChannelQuery(args: {
    parentThreadId: string;
    parentSdkSessionId: string;
    prompt: string;
    abortSignal?: AbortSignal;
    conversationHistory?: string;
    cwd: string;
  }): Promise<string> {
    const { parentThreadId, parentSdkSessionId, prompt, abortSignal, cwd } = args;
    void args.conversationHistory; // sessionless B-prime fallback is out of scope for this slice.

    if (!parentSdkSessionId) {
      throw transientHandoffError(
        `No persisted Cursor session for parent thread ${parentThreadId}; cannot run clean side-channel query`,
      );
    }
    if (abortSignal?.aborted) {
      throw transientHandoffError("Cursor side-channel query aborted before start");
    }

    // Populated from session updates only; never emitted, so the parent thread
    // gains no rows and the UI timeline sees nothing.
    const turnState = createCursorAcpTurnState();
    const todoSnapshot = createCursorTodoSnapshot();
    const sideChannelThreadId = `sidechannel-${randomUUID()}`;

    const client: Client = {
      // A summary query needs no tools, and a throwaway side-channel must never
      // mutate the user's workspace; deny every permission request.
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      sessionUpdate: async (params: SessionNotification) => {
        const update = validateAcpSessionUpdate(params);
        if (update.sessionId !== parentSdkSessionId) return;
        // Map for the accumulator side effect; discard the events (no emission).
        mapCursorAcpSessionNotification(update, sideChannelThreadId, turnState, todoSnapshot);
      },
      readTextFile: async (r) => ({ content: this.safeReadWorkspaceFile(cwd, r.path) }),
      writeTextFile: async () => {
        throw new Error("Cursor side-channel is read-only");
      },
      extMethod: async () => ({}),
      extNotification: async () => {},
    };

    let transport: CursorSideChannelTransport;
    try {
      transport = await this.sideChannelConnector({ cwd, client });
    } catch (err) {
      throw transientHandoffError(
        `Failed to open Cursor side-channel connection: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Dispose exactly once: an abort during loadSession/prompt and the finally
    // block both reach for teardown, so the first caller owns it and the other
    // awaits the same promise rather than racing a second kill.
    let disposal: Promise<void> | null = null;
    const disposeOnce = (): Promise<void> => {
      if (!disposal) disposal = Promise.resolve(transport.dispose());
      return disposal;
    };
    const onAbort = (): void => {
      void disposeOnce();
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    try {
      try {
        await transport.loadSession({ cwd, mcpServers: [], sessionId: parentSdkSessionId });
      } catch (err) {
        throw transientHandoffError(
          `Cursor side-channel could not reconstruct parent session ${parentSdkSessionId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      await transport.prompt({
        sessionId: parentSdkSessionId,
        prompt: [{ type: "text", text: prompt }],
      });

      const text = resolveCursorAssistantMessageContent(turnState.accumulator).trim();
      if (!text) {
        throw transientHandoffError("Cursor side-channel query returned empty output");
      }
      return text;
    } finally {
      abortSignal?.removeEventListener("abort", onAbort);
      await disposeOnce();
    }
  }

  /**
   * Default {@link sideChannelConnector}: spawns a fresh `cursor-agent acp`
   * subprocess, runs the ACP handshake, and returns a transport that wraps the
   * connection plus a process-tree kill on dispose. The subprocess is never
   * registered with the session pool, so it cannot disturb the parent thread's
   * pooled session.
   */
  private async createSideChannelTransport(args: {
    cwd: string;
    client: Client;
  }): Promise<CursorSideChannelTransport> {
    const { cwd, client } = args;
    const settings = this.settingsService.get();
    const cliCandidates = cursorCliProbeBinaries(settings);

    let child: ChildProcess | null = null;
    let lastErr: unknown = null;
    for (const cliPath of cliCandidates) {
      try {
        const candidate = spawn(cliPath, buildCursorAcpArgs({ permissionMode: "default" }), {
          stdio: ["pipe", "pipe", "pipe"],
          cwd,
          shell: process.platform === "win32",
          env: this.envService.getEnv(),
        });
        if (!candidate.stdin || !candidate.stdout) {
          throw new Error("Failed to spawn cursor-agent: stdio pipes unavailable");
        }
        child = candidate;
        break;
      } catch (e) {
        lastErr = e;
        const m = e instanceof Error ? e.message : String(e);
        if (/Failed to spawn cursor-agent/i.test(m)) continue;
        break;
      }
    }
    if (!child?.stdin || !child.stdout) {
      throw lastErr instanceof Error
        ? lastErr
        : new Error(String(lastErr ?? "Failed to spawn cursor-agent (side-channel)"));
    }

    // Read the pipes off `child` directly: the guard above narrows
    // `child.stdin`/`child.stdout` on that exact reference, a narrowing that
    // would not survive being aliased through another binding.
    const out = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
    const inp = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
    const spawned = child;
    const stream = ndJsonStream(out, inp);
    const connection = new ClientSideConnection(() => client, stream);
    try {
      await this.acpHandshake(connection, "cursor-side-channel");
    } catch (error) {
      if (spawned.pid !== undefined) {
        await this.host.processes.terminateTree(spawned.pid).catch(() => undefined);
      }
      throw error;
    }

    return {
      loadSession: (a) => connection.loadSession(a),
      prompt: (a) => connection.prompt(a),
      dispose: async () => {
        try {
          if (spawned.pid != null) await this.host.processes.terminateTree(spawned.pid);
        } catch {
          /* best-effort: the subprocess may already be gone */
        }
      },
    };
  }
}
