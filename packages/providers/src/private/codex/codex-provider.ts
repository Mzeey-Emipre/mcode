/**
 * Codex provider adapter using the persistent `codex app-server` subprocess.
 *
 * Each session owns one `CodexAppServer` process that stays alive between turns.
 * JSON-RPC 2.0 notifications are translated to `AgentEvent` objects by
 * `CodexEventMapper` and forwarded to subscribers via EventEmitter.
 *
 * Turn lifecycle:
 *   sendMessage → server.sendTurn → notifications stream in → turn.completed/failed
 */

import * as NodeEvents from "node:events";
import * as NodeCrypto from "node:crypto";
import { logger } from "@mcode/shared";
import { buildMcodeInstructionPlan, renderMcodeInstructions } from "@mcode/thread-orchestration";
import {
  providerBrowserPermissionCapability,
  type ProviderBrowserCredentialMetadata,
  type ProviderBrowserLeaseGrant,
  type ProviderBrowserLeaseHandle,
  type ProviderHostPorts,
} from "../../host-ports.js";
import type { CodexProviderPorts } from "../../factory-types.js";
import { SessionRuntime } from "../session-runtime.js";
import type { ProtocolAdapter, SpawnArgs, SpawnResult } from "../session-runtime.js";
import type {
  IAgentProvider,
  IApprovalReviewCapable,
  ApprovalReviewSupport,
  IGoalCapable,
  ISessionEvictable,
  SessionForker,
  ForkRequest,
  HandoffArtifact,
  HandoffMeta,
  TurnRequest,
  AgentEvent,
  GoalState,
  GoalLookupResult,
  PermissionDecision,
  PermissionRequest,
  ProviderModelInfo,
  ProviderUsageInfo,
  ProviderRuntimeEvent,
  ProviderTurnDiffUpdate,
  ProviderCapabilityName,
} from "@mcode/contracts";
import {
  AgentEventType,
  CODEX_STATIC_MODELS,
  isGoalOpen,
  providerRuntimeEvent,
  supportsCodexUltraOrchestration,
} from "@mcode/contracts";
import { checkCodexVersion, meetsMinVersion } from "./codex-version.js";
import { CodexAppServer, warmCodexAppServer } from "./codex-app-server.js";
import type { CodexApprovalRequest } from "./codex-app-server.js";
import { CodexEventMapper } from "./codex-event-mapper.js";
import {
  buildCodexInput,
  hasCodexInternalThreadControlMcp,
  mapCodexRateLimitsToUsage,
  mergeCodexUsageInfo,
  nativeCollabSpawnThreadIds,
  nativeSubAgentThreadId,
} from "./codex-input-mapper.js";
import { traceCodexIngest } from "./codex-trace.js";
import type {
  TurnInputPart,
  CodexNotification,
  CodexTurnOptions,
  CompletedItem,
  SandboxMode,
  ThreadGoal,
} from "./codex-types.js";
import { toCodexEffort } from "./codex-types.js";
import {
  mapDecisionToCodexResponse,
  synthesizeCodexPermissionRequest,
} from "./codex-permission-mapper.js";
import { CodexPromptResolutionError, parseCodexSlashInvocation } from "./codex-prompt.js";

export {
  hasCodexInternalThreadControlMcp,
  mapCodexRateLimitsToUsage,
  mergeCodexUsageInfo,
} from "./codex-input-mapper.js";

/**
 * Liveness-probe interval for a silent turn, not a turn deadline. The timer
 * resets on every notification (including swallowed lifecycle traffic and
 * inbound approval requests, via the app-server `activity` event). When a
 * turn stays fully silent for this long, the watchdog pings the app-server
 * with a cheap RPC: responsive → re-arm (a healthy turn can run forever);
 * unresponsive → end the turn so the session does not stay `isBusy` (exempt
 * from idle eviction) with the UI stuck "thinking" indefinitely. While a
 * permission approval awaits the user, the watchdog re-arms without probing.
 */
const TURN_TIMEOUT_MS = 5 * 60 * 1000;
const SIDE_CHANNEL_TIMEOUT_MS = 120_000;
const USAGE_WARMUP_TIMEOUT_MS = 10_000;
const CODEX_MCP_STARTUP_TIMEOUT_MS = 10_000;
const USAGE_WARMUP_RETRY_MS = 60_000;
const CODEX_MIN_VERSION = "0.37.0";
// The installed 0.153.4 app-server exposes approvalsReviewer plus the gated
// item/autoApprovalReview lifecycle used by this adapter.
const CODEX_AUTO_REVIEW_VALIDATED_VERSION = "0.153.4";
const MAX_PENDING_CHILD_EVENTS = 128;
const MAX_CHILD_EVENT_DELIVERY_KEYS = 512;

type BrowserAutomationCredentialMetadata = ProviderBrowserCredentialMetadata;
type BrowserAutomationSessionLeaseStage = ProviderBrowserLeaseHandle;
type MemoryPressureLevel = "normal" | "warning" | "critical";

/** Translate a Codex aggregate into the provider-neutral evidence states. */
export function nativeTurnDiffEvidence(patch: unknown) {
  if (typeof patch !== "string") return { state: "rejected" as const };
  if (patch.length === 0) return { state: "indeterminate-empty" as const };
  return { state: "snapshot" as const, patch, nativeFidelity: "agent" as const };
}

const CODEX_SUPPORTED_CAPABILITIES = [
  "build",
  "plan",
  "goals",
  "permissions",
  "usage",
  "session-eviction",
  "clean-fork",
  "orchestration",
  "browser-access",
  "thread-control",
  "child-cancellation",
  "turn-diff",
  "approval-review",
] as const satisfies readonly ProviderCapabilityName[];

const TURN_SCOPED_EVENT_TYPES = new Set<AgentEvent["type"]>([
  "turnStarted", "message", "generatedAttachment", "toolUse", "toolResult",
  "turnComplete", "error", "ended", "compacting", "compactSummary",
  "modelFallback", "textDelta", "toolInputDelta", "toolProgress", "contextEstimate",
  "assistantMessageBoundary",
]);

function isTurnScopedEvent(event: AgentEvent): boolean {
  return TURN_SCOPED_EVENT_TYPES.has(event.type);
}

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

type CodexEndedOutcome = "completed" | "errored" | "cancelled";

type CodexCliPreflightResult =
  | { ok: true; version: string }
  | { ok: false; reason: "unavailable"; error: string }
  | { ok: false; reason: "unsupported"; version: string };

/** Returns true when two provider usage snapshots are equivalent. */
export function isSameProviderUsageInfo(a: ProviderUsageInfo, b: ProviderUsageInfo): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}


/** Internal: a newer `sendMessage` aborted this turn wait (not user-facing). */
class CodexTurnSupersededError extends Error {
  constructor() {
    super("Codex turn superseded");
    this.name = "CodexTurnSupersededError";
  }
}

/** Internal: silent turn AND the app-server failed a liveness probe; ends the turn without a user error. */
class CodexTurnIdleTimeoutError extends Error {
  constructor() {
    super(
      `Codex turn abandoned: no notifications for ${TURN_TIMEOUT_MS / 1000}s and the app-server failed a liveness probe`,
    );
    this.name = "CodexTurnIdleTimeoutError";
  }
}

function transientHandoffError(message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = "ETIMEDOUT";
  return err;
}

type CodexInternalMcpStartupOutcome =
  | { status: "ready" }
  | { status: "failed"; source: "native"; error?: string }
  | { status: "timeout"; error: string }
  | { status: "cancelled" };

function observeCodexInternalMcpStartup(server: CodexAppServer): {
  promise: Promise<CodexInternalMcpStartupOutcome>;
  cancel: () => void;
} {
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolvePromise!: (outcome: CodexInternalMcpStartupOutcome) => void;
  const promise = new Promise<CodexInternalMcpStartupOutcome>((resolve) => {
    resolvePromise = resolve;
  });
  const finish = (outcome: CodexInternalMcpStartupOutcome): void => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    server.off("notification", onNotification);
    resolvePromise(outcome);
  };
  const onNotification = (notification: unknown): void => {
    const outcome = codexInternalMcpStartupOutcome(notification);
    if (outcome) finish(outcome);
  };
  server.on("notification", onNotification);
  timer = setTimeout(
    () => finish({ status: "timeout", error: "Codex internal MCP startup timed out" }),
    CODEX_MCP_STARTUP_TIMEOUT_MS,
  );
  return { promise, cancel: () => finish({ status: "cancelled" }) };
}

function codexInternalMcpStartupOutcome(notification: unknown): CodexInternalMcpStartupOutcome | undefined {
  const value = notification as { method?: unknown; params?: Record<string, unknown> };
  if (value.method !== "mcpServer/startupStatus/updated") return undefined;
  if (value.params?.name !== "mcode_internal_thread_control") return undefined;
  const status = typeof value.params.status === "string" ? value.params.status : "";
  if (status === "ready") return { status: "ready" };
  if (status === "cancelled") return { status: "cancelled" };
  if (status !== "failed" && status !== "error") return undefined;
  return failedCodexInternalMcpStartup(value.params);
}

function failedCodexInternalMcpStartup(params: Record<string, unknown>): CodexInternalMcpStartupOutcome {
  const error = typeof params.error === "string" ? params.error : typeof params.failureReason === "string" ? params.failureReason : undefined;
  return error ? { status: "failed", source: "native", error } : { status: "failed", source: "native" };
}

/**
 * Per-session state owned by the {@link SessionRuntime}. Holds the live
 * app-server, its event mapper, and the turn-sequencing bookkeeping that the
 * provider's `runTurn` reads. The runtime owns eviction timing, but
 * `lastUsedAt` is retained here because `resolvePermission` stamps it so user
 * attention on a permission card counts as activity.
 */
interface CodexSessionState {
  /** Session id this state belongs to; lets `close`/drain reference provider-owned maps. */
  sessionId: string;
  /** Thread id derived from the session id; reused for event emission on teardown. */
  threadId: string;
  /** Working directory used for this app-server session. */
  cwd: string;
  server: CodexAppServer;
  mapper: CodexEventMapper;
  lastUsedAt: number;
  /** Sandbox mode used when this session was started; used to detect permission mode changes. */
  sandboxMode: string;
  /** Monotonic counter so overlapping `runTurn` waits ignore stale completions. */
  runTurnSeq: number;
  /** Codex `turn.id` from the latest `turn/started` for this session. */
  pendingTurnId: string | null;
  /** Execution currently awaiting or owning an authoritative native turn id. */
  currentTurnExecutionId?: string;
  /** Mcode identity retained for native diff routing after provider dispatch. */
  turnDiffRouting?: { turnId: string; turnExecutionId: string; deliveryAttempt: number };
  /** Per-native-turn revision sequence for complete diff aggregates. */
  turnDiffRevision: number;
  /** Native turn id returned by `turn/start` for the current execution. */
  currentNativeTurnId?: string;
  /** Current turn binding phase; notifications cannot invent identities while unbound. */
  turnBindingPhase: "idle" | "awaiting" | "bound";
  /** True until the current `turn/start` RPC response arrives. */
  turnStartResponsePending: boolean;
  /** Native turn notification buffered until the authoritative RPC response arrives. */
  pendingTurnStartNotification?: { nativeTurnId: string; executionId: string };
  /** Immutable Mcode execution identity keyed by native Codex turn id. */
  turnExecutionIdsByNativeTurn: Map<string, string>;
  /** Current generation execution identity keyed by authoritative child thread id. */
  nativeThreadExecutionIds: Map<string, string>;
  /** Execution currently owning the active main turn, retained through drains. */
  activeParentTurnExecutionId?: string;
  /** Execution identity waiting for the next native turn/started notification. */
  nextTurnExecutionId?: string;
  /** Bounded conflict fingerprints already logged for this session. */
  nativeExecutionConflictKeys: Set<string>;
  /** Current generation for each authoritative child thread linkage. */
  childExecutionGenerations: Map<string, { executionId: string; generation: number }>;
  /** Monotonic child generation counter, bounded by the child map lifetime. */
  nextChildGeneration: number;
  /** Child threads already queried for authoritative model metadata this session. */
  childMetadataFetches: Set<string>;
  /** Child events awaiting an authoritative parent/child execution mapping. */
  pendingChildEvents: PendingChildEvent[];
  /** Native child event identities already emitted from this session. */
  deliveredChildEventKeys: Set<string>;
  /** Clears the in-flight `runTurn` listener when a new turn preempts it. */
  abortPendingTurnWait?: () => void;
  /** Non-secret browser credential lifecycle metadata for this main session. */
  browserCredential?: BrowserAutomationCredentialMetadata;
  browserLeaseId?: string;
  /** Workspace fixed to the provider process at spawn. */
  workspaceId: string;
  /** Browser permission class fixed to the provider process at spawn. */
  browserPermissionCapability: "observe" | "interact" | "privileged";
  /** Whether this session was started with the internal Mcode thread-control MCP. */
  threadControlEligible: boolean;
}

/** One pending codex approval bridged into the Phase 1 permission flow. */
interface PendingPermissionEntry {
  sessionId: string;
  threadId: string;
  toolName: string;
  input: unknown;
  title?: string;
  method: string;
  params: Record<string, unknown>;
  resolve: (response: unknown) => void;
}

interface PreparedCodexTurn {
  request: TurnRequest<"codex">;
  cliPath: string;
  threadId: string;
  sandbox: SandboxMode;
  browserPermissionCapability: "observe" | "interact" | "privileged";
  input: TurnInputPart[];
  turnOptions: CodexTurnOptions;
  threadControlEligible: boolean;
}

type CodexInternalMcp = { configOverrides: string[]; env: Record<string, string> };

interface CodexInternalMcpSetup {
  internalMcp: CodexInternalMcp | undefined;
  setupError: string | undefined;
  close: () => Promise<void>;
}

interface CodexSpawnContext {
  args: SpawnArgs;
  cliPath: string;
  sessionId: string;
  threadId: string;
  cwd: string;
  resumeFrom: string | undefined;
  sandbox: SandboxMode;
  approvalPolicy: "never" | "on-request";
  pendingSpawn: { input: string | TurnInputPart[]; turnOptions: CodexTurnOptions; turnExecutionId: string; threadControlEligible: boolean } | undefined;
  stagedExecutionId: string | undefined;
  threadControlEligible: boolean;
  browserAccess: { stage: BrowserAutomationSessionLeaseStage; workspaceId: string; permissionCapability: "observe" | "interact" | "privileged" } | undefined;
  internalMcp: CodexInternalMcp | undefined;
  internalMcpSetupError: string | undefined;
  closeInternalMcpAuthority: () => Promise<void>;
  browserGrant: ProviderBrowserLeaseGrant | null;
  spawnEnv: Record<string, string>;
}

interface CodexTurnRun {
  entry: CodexSessionState;
  seq: number;
  hadInflightTurn: boolean;
}

interface CodexTurnCompletionState {
  serverDied: boolean;
  endedOutcome: CodexEndedOutcome | undefined;
  deferredEnded: AgentEvent | undefined;
  earlyCompletionTurnId: string | undefined;
}

/** Return the generated image path from an app-server imageGeneration item. */
export function generatedImagePathFromCodexItem(item: Record<string, unknown> | undefined): string | null {
  if (!item || item.type !== "imageGeneration") return null;
  const status = typeof item.status === "string" ? item.status.toLowerCase() : "";
  if (status === "failed" || status === "error") return null;
  const savedPath = (item as { savedPath?: unknown }).savedPath;
  if (typeof savedPath !== "string") return null;
  const trimmed = savedPath.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * True when a turn lifecycle notification belongs to the app-server's main
 * thread. Sub-agent (collab receiver) threads stream their own `turn/started`
 * and `turn/completed` over the same connection, tagged with their own
 * `threadId`; letting those drive the provider's turn bookkeeping ends the
 * main turn early (UI drops the running indicator while streaming continues,
 * and the still-busy session becomes evictable). Notifications without a
 * `threadId`, or before the main thread id is known, are treated as main.
 */
function isMainThreadNotification(
  server: { threadId: string | null },
  params: Record<string, unknown> | undefined,
): boolean {
  const notifThreadId = typeof params?.threadId === "string" && params.threadId.length > 0
    ? params.threadId
    : undefined;
  return !notifThreadId || !server.threadId || notifThreadId === server.threadId;
}

interface PendingChildEvent {
  event: ProviderRuntimeEvent;
  nativeThreadId: string;
  nativeTurnId?: string;
  childGeneration?: number;
  executionIdAtBuffer?: string;
  eventKey?: string;
}

function nativeTurnIdFromParams(params: Record<string, unknown> | undefined): string | undefined {
  if (typeof params?.turnId === "string" && params.turnId.length > 0) return params.turnId;
  const turn = params?.turn;
  return isRecord(turn) && typeof turn.id === "string" && turn.id.length > 0 ? turn.id : undefined;
}

function nativeThreadIdFromParams(params: Record<string, unknown> | undefined): string | undefined {
  return typeof params?.threadId === "string" && params.threadId.length > 0
    ? params.threadId
    : undefined;
}

type NativeExecutionAssignment = "inserted" | "same" | "conflict";

function assignNativeExecution(
  map: Map<string, string>,
  key: string,
  executionId: string,
  conflictKeys?: Set<string>,
): NativeExecutionAssignment {
  const existingExecutionId = map.get(key);
  if (existingExecutionId === undefined) {
    map.set(key, executionId);
    return "inserted";
  }
  if (existingExecutionId === executionId) return "same";

  const diagnosticKey = `${key}\u0000${existingExecutionId}\u0000${executionId}`;
  if (!conflictKeys || (!conflictKeys.has(diagnosticKey) && conflictKeys.size < 64)) {
    conflictKeys?.add(diagnosticKey);
    logger.warn("Codex native execution mapping conflict", {
      key,
      existingExecutionId,
      executionId,
    });
  }
  return "conflict";
}

function pruneExecutionMap(map: Map<string, string>): void {
  while (map.size > 128) {
    const oldest = map.keys().next().value as string | undefined;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}

function pruneChildGenerationMap(
  map: Map<string, { executionId: string; generation: number }>,
): void {
  while (map.size > 128) {
    const oldest = map.keys().next().value as string | undefined;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}

function executionForDrain(state: CodexSessionState): string | undefined {
  return state.currentTurnExecutionId
    ?? (state.pendingTurnId && state.turnExecutionIdsByNativeTurn.get(state.pendingTurnId))
    ?? state.activeParentTurnExecutionId;
}

function bufferPendingChildEvent(
  state: CodexSessionState,
  event: ProviderRuntimeEvent,
  nativeThreadId: string,
  nativeTurnId: string | undefined,
  eventKey?: string,
): void {
  state.pendingChildEvents.push({
    event,
    nativeThreadId,
    ...(nativeTurnId ? { nativeTurnId } : {}),
    childGeneration: state.childExecutionGenerations.get(nativeThreadId)?.generation,
    executionIdAtBuffer: state.currentTurnExecutionId ?? state.activeParentTurnExecutionId,
    ...(eventKey ? { eventKey } : {}),
  });
  while (state.pendingChildEvents.length > MAX_PENDING_CHILD_EVENTS) {
    state.pendingChildEvents.shift();
  }
}

function childEventIdentity(event: ProviderRuntimeEvent): string | undefined {
  const evidence = event.extension?.child;
  if (!evidence) return undefined;
  if (evidence.nativeEventId) return evidence.nativeEventId;
  return `codex-child:${NodeCrypto.createHash("sha256").update(JSON.stringify([
    event.event.type,
    evidence.nativeThreadId,
    evidence.nativeTurnId ?? "",
    evidence.parentCollaborationItemId,
    evidence.nativeItemId ?? "",
    evidence.itemEventKey ?? "",
  ])).digest("hex")}`;
}

function withTurnExecutionId(event: ProviderRuntimeEvent, turnExecutionId: string | undefined): ProviderRuntimeEvent {
  if (!turnExecutionId) return event;
  return { ...event, event: { ...event.event, turnExecutionId } as AgentEvent };
}

function rememberChildEventKey(state: CodexSessionState, eventKey: string): void {
  state.deliveredChildEventKeys.add(eventKey);
  while (state.deliveredChildEventKeys.size > MAX_CHILD_EVENT_DELIVERY_KEYS) {
    const oldest = state.deliveredChildEventKeys.values().next().value as string | undefined;
    if (!oldest) return;
    state.deliveredChildEventKeys.delete(oldest);
  }
}

function completedAssistantText(item: CompletedItem | undefined): string {
  if (!item || (item.type !== "agentMessage" && item.type !== "message")) return "";
  const parts = Array.isArray(item.content) ? item.content : [];
  return parts
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("")
    .trim();
}

/** Codex provider adapter implementing IAgentProvider with a persistent app-server process per session. */
export class CodexProvider extends NodeEvents.EventEmitter implements IAgentProvider, IApprovalReviewCapable, IGoalCapable, ISessionEvictable, ProtocolAdapter<CodexSessionState> {
  readonly id = "codex" as const;
  readonly descriptor = Object.freeze({
    id: "codex" as const,
    capabilities: CODEX_SUPPORTED_CAPABILITIES.map((name) => ({ name, support: "supported" as const })),
  });
  /** Codex CLI is an agentic tool with no one-shot text completion mode. */
  readonly supportsCompletion = false;
  readonly sessionForkOnResume = "clean" as const;
  readonly maxInputCharactersPerTurn = 16_000;

  async getApprovalReviewSupport(input: {
    permissionMode: "full" | "supervised";
    interactionMode: "plan" | "build";
    requestedMode: "manual" | "automatic";
    model: string;
  }): Promise<ApprovalReviewSupport> {
    if (input.permissionMode === "full") {
      return { status: "unavailable", supportedModes: ["manual"], reason: "full-access-bypasses-approval-review", liveChangeScope: "none" };
    }
    const { cliPath } = await this.codexPorts.settings.get();
    const version = checkCodexVersion(cliPath);
    if (!version.ok) {
      return { status: "unavailable", supportedModes: ["manual"], reason: "provider-version-unavailable", liveChangeScope: "none" };
    }
    if (version.version !== CODEX_AUTO_REVIEW_VALIDATED_VERSION) {
      return { status: "unavailable", supportedModes: ["manual"], reason: "provider-version-unsupported", liveChangeScope: "none" };
    }
    return { status: "available", supportedModes: ["manual", "automatic"], reason: "experimental-api-enabled", liveChangeScope: "none" };
  }
  /** Path B forker; calls this provider's throwaway app-server side channel. */
  readonly forker: SessionForker = new CleanForker(this);

  /** Returns the static Codex model catalog. Codex does not support dynamic model discovery. */
  async listModels(): Promise<ProviderModelInfo[]> {
    return CODEX_STATIC_MODELS.map((m) => ({ ...m }));
  }

  /** Return the latest Codex account rate-limit state pushed by the app-server. */
  async getUsage(): Promise<ProviderUsageInfo> {
    if (this.usageInfo.quotaCategories.length > 0) return this.usageInfo;
    return this.warmUsageCache();
  }

  private emitRuntimeEvent(runtimeEvent: ProviderRuntimeEvent): void {
    super.emit("event", runtimeEvent);
  }

  /** Owns the session pool, idle eviction (with busy guard), and JobObject/kill. */
  private readonly runtime: SessionRuntime<CodexSessionState>;
  private sdkSessionIds = new Map<string, string>();
  /**
   * Session IDs for which a stop was requested before the session was created.
   * Checked after session creation; if found the session is torn down immediately.
   */
  private pendingStops = new Set<string>();
  private liveSessionIds = new Set<string>();
  /** Pending host-side permission approvals keyed by requestId. */
  private pendingPermissions = new Map<string, PendingPermissionEntry>();
  /** When true, active mappers spool output chunks to artifacts immediately. */
  private outputTruncationMode = false;
  /** Active goal state mirrored from native Codex goal RPCs and notifications. */
  private goalsBySession = new Map<string, GoalState>();
  /** Last account rate limits pushed by the Codex app-server. */
  private usageInfo: ProviderUsageInfo = { providerId: "codex", quotaCategories: [] };
  private usageWarmupPromise: Promise<ProviderUsageInfo> | null = null;
  private lastUsageWarmupAt = 0;
  /** Goal objectives waiting for a Codex app-server thread to exist. */
  private pendingGoalObjectives = new Map<string, string>();
  /**
   * Turn input + options carried from `sendTurn` to `spawn` so a freshly
   * spawned session can run its first turn. The runtime's `acquire` only hands
   * back the state, so the per-turn payload is staged here keyed by sessionId.
   */
  private pendingSpawnTurns = new Map<
    string,
    {
      input: string | TurnInputPart[];
      turnOptions: CodexTurnOptions;
      turnExecutionId: string;
      turnId: string;
      deliveryAttempt: number;
      threadControlEligible: boolean;
    }
  >();
  /** Browser scope staged only until a fresh main app-server process starts. */
  private pendingBrowserAccess = new Map<string, {
    stage: BrowserAutomationSessionLeaseStage;
    workspaceId: string;
    permissionCapability: "observe" | "interact" | "privileged";
  }>();

  constructor(
    private readonly host: ProviderHostPorts,
    private readonly codexPorts: CodexProviderPorts,
    idleSessionTtlMs: number,
  ) {
    super();
    this.runtime = new SessionRuntime<CodexSessionState>(this, {
      jobObject: {
        isWindowsJob: false,
        assign: () => false,
        setDescription: () => undefined,
      },
      envService: { getEnv: () => ({ ...this.host.environment.snapshot() }) },
      idleTtlMs: idleSessionTtlMs,
    });
  }

  /**
   * Primes the provider-owned Codex usage cache from a throwaway app-server.
   * Consumers still read through getUsage(); this only fills the shared source
   * before any real Codex session emits rate-limit notifications.
   */
  async warmUsageCache(force = false): Promise<ProviderUsageInfo> {
    if (!force && this.usageInfo.quotaCategories.length > 0) return this.usageInfo;
    const now = Date.now();
    if (!force && now - this.lastUsageWarmupAt < USAGE_WARMUP_RETRY_MS) {
      return this.usageInfo;
    }
    if (this.usageWarmupPromise) return this.usageWarmupPromise;

    this.lastUsageWarmupAt = now;
    this.usageWarmupPromise = this.fetchUsageViaWarmup()
      .finally(() => {
        this.usageWarmupPromise = null;
      });
    return this.usageWarmupPromise;
  }

  private async fetchUsageViaWarmup(): Promise<ProviderUsageInfo> {
    const settings = await this.codexPorts.settings.get();
    const cliPath = settings.cliPath;
    const result = await warmCodexAppServer(
      cliPath,
      this.host.runtime.platform,
      USAGE_WARMUP_TIMEOUT_MS,
      () => ({ ...this.host.environment.snapshot() }),
    );
    if (result.rateLimitsPayload !== undefined) {
      this.applyUsageSnapshot(result.rateLimitsPayload, undefined, "replace");
    }
    return this.usageInfo;
  }

  private applyUsageSnapshot(
    payload: unknown,
    threadId?: string,
    mode: "merge" | "replace" = "merge",
  ): boolean {
    const mappedUsage = mapCodexRateLimitsToUsage(payload);
    const nextUsage = mode === "replace"
      ? mappedUsage
      : mergeCodexUsageInfo(this.usageInfo, mappedUsage);
    if (isSameProviderUsageInfo(this.usageInfo, nextUsage)) return false;

    this.usageInfo = nextUsage;
    if (threadId) {
      this.emitRuntimeEvent(providerRuntimeEvent({
        type: AgentEventType.QuotaUpdate,
        threadId,
        providerId: "codex",
        categories: this.usageInfo.quotaCategories,
      } satisfies AgentEvent));
    }
    return true;
  }

  private clearUsageCache(): void {
    this.usageInfo = { providerId: "codex", quotaCategories: [] };
    this.lastUsageWarmupAt = 0;
  }

  private refreshUsageFromServer(server: CodexAppServer, threadId: string): void {
    const readRateLimits = (server as { readRateLimits?: () => Promise<unknown> }).readRateLimits;
    if (!readRateLimits) return;
    void readRateLimits.call(server)
      .then((payload) => this.applyUsageSnapshot(payload, threadId, "replace"))
      .catch((err: unknown) => {
        logger.debug("Codex account rate-limit read failed", { error: String(err) });
      });
  }

  /** Switch Codex mapper output buffering for active and future sessions. */
  setOutputTruncationMode(enabled: boolean): void {
    if (this.outputTruncationMode === enabled) return;
    this.outputTruncationMode = enabled;
    for (const state of this.runtime.states()) {
      state.mapper.setOutputTruncationMode(enabled);
    }
  }

  /** Convert an Mcode session id into the owning thread id. */
  private threadIdFromSession(sessionId: string): string {
    return sessionId.startsWith("mcode-") ? sessionId.slice(6) : sessionId;
  }

  /** Check Codex CLI availability and minimum version without applying caller policy. */
  private checkCodexCliPreflight(cliPath: string): CodexCliPreflightResult {
    const versionResult = checkCodexVersion(cliPath);
    if (!versionResult.ok) {
      return { ok: false, reason: "unavailable", error: versionResult.error };
    }
    if (!meetsMinVersion(versionResult.version, CODEX_MIN_VERSION)) {
      return { ok: false, reason: "unsupported", version: versionResult.version };
    }
    return { ok: true, version: versionResult.version };
  }

  /** Emit a failed turn's error and terminal events, optionally deferring Ended. */
  private emitTurnFailure(
    threadId: string,
    error: string,
    outcome?: CodexEndedOutcome,
    emitEnded = true,
    turnExecutionId?: string,
  ): AgentEvent | undefined {
    this.emitRuntimeEvent(providerRuntimeEvent({
      type: AgentEventType.Error,
      threadId,
      error,
      ...(turnExecutionId ? { turnExecutionId } : {}),
    } satisfies AgentEvent));
    if (!turnExecutionId) return undefined;
    const ended = {
      type: AgentEventType.Ended,
      threadId,
      ...(outcome ? { outcome } : {}),
      turnExecutionId,
    } satisfies AgentEvent;
    if (emitEnded) this.emitRuntimeEvent(providerRuntimeEvent(ended));
    return ended;
  }

  /** Reports a local internal MCP setup failure without changing turn lifecycle state. */
  private emitInternalMcpStartupFailure(
    threadId: string,
    serverThreadId: string,
    error: string,
    turnExecutionId?: string,
  ): void {
    this.emitRuntimeEvent(providerRuntimeEvent({
      type: AgentEventType.McpServerStartupStatus,
      threadId,
      providerId: this.id,
      serverThreadId,
      name: "mcode_internal_thread_control",
      status: "failed",
      error,
      ...(turnExecutionId ? { turnExecutionId } : {}),
    } satisfies AgentEvent));
  }

  /** Convert a native Codex goal into Mcode's provider-neutral goal state. */
  private mapCodexGoal(sessionId: string, goal: ThreadGoal, turnId?: string | null): GoalState {
    return {
      threadId: this.threadIdFromSession(sessionId),
      objective: goal.objective,
      status: goal.status,
      tokenBudget: goal.tokenBudget,
      tokensUsed: goal.tokensUsed,
      timeUsedSeconds: goal.timeUsedSeconds,
      createdAt: goal.createdAt,
      updatedAt: goal.updatedAt,
      providerId: "codex",
      source: "codex",
      turnId: turnId ?? null,
      controls: {
        canInspect: true,
        canClear: goal.status !== "complete",
      },
    };
  }

  /** Build a provisional Codex goal state before the app-server thread exists. */
  private provisionalGoalState(sessionId: string, objective: string): GoalState {
    const now = Date.now();
    const existing = this.goalsBySession.get(sessionId);
    return {
      threadId: this.threadIdFromSession(sessionId),
      objective,
      status: "active",
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: existing
        ? Math.max(0, Math.floor((now - existing.createdAt) / 1000))
        : 0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      providerId: "codex",
      source: "codex",
      controls: {
        canInspect: true,
        canClear: true,
      },
    };
  }

  /** Mirror goal events from the mapper into the provider cache. */
  private recordGoalEvent(sessionId: string, event: AgentEvent): void {
    if (event.type === AgentEventType.GoalUpdated) {
      if (isGoalOpen(event.goal)) {
        this.goalsBySession.set(sessionId, event.goal);
      } else {
        this.goalsBySession.delete(sessionId);
        this.pendingGoalObjectives.delete(sessionId);
      }
      return;
    }
    if (event.type === AgentEventType.GoalCleared) {
      this.goalsBySession.delete(sessionId);
      this.pendingGoalObjectives.delete(sessionId);
    }
  }

  /** Emit a goal update and update the local mirror. */
  private emitGoalUpdated(sessionId: string, goal: GoalState): void {
    if (isGoalOpen(goal)) {
      this.goalsBySession.set(sessionId, goal);
    } else {
      this.goalsBySession.delete(sessionId);
    }
    this.emitRuntimeEvent(providerRuntimeEvent({
      type: AgentEventType.GoalUpdated,
      threadId: goal.threadId ?? this.threadIdFromSession(sessionId),
      goal,
    } satisfies AgentEvent));
  }

  /** Emit a goal clear and update the local mirror. */
  private emitGoalCleared(
    sessionId: string,
    reason: "cleared" | "rollback" | "completed",
  ): void {
    this.goalsBySession.delete(sessionId);
    this.pendingGoalObjectives.delete(sessionId);
    this.emitRuntimeEvent(providerRuntimeEvent({
      type: AgentEventType.GoalCleared,
      threadId: this.threadIdFromSession(sessionId),
      providerId: "codex",
      reason,
    } satisfies AgentEvent));
  }

  /** Evict idle Codex sessions while preserving active turns. */
  async shedMemoryPressure(level: MemoryPressureLevel): Promise<void> {
    const result = await this.runtime.evictNonBusy(`memory-pressure:${level}`);
    logger.info("Codex session pool shed memory pressure", {
      level,
      before: result.before,
      after: result.after,
      evicted: result.evicted.length,
    });
  }

  /**
   * Set a native Codex thread goal. If the app-server thread has not started
   * yet, queue the objective and apply it immediately before the first turn.
   */
  async setGoal(sessionId: string, condition: string): Promise<GoalState> {
    this.pendingGoalObjectives.set(sessionId, condition);
    const provisional = this.provisionalGoalState(sessionId, condition);
    this.goalsBySession.set(sessionId, provisional);

    const state = this.runtime.get(sessionId);
    if (!state?.server.isAlive) {
      return provisional;
    }

    const nativeGoal = await state.server.setGoal(condition);
    const goal = this.mapCodexGoal(sessionId, nativeGoal);
    this.pendingGoalObjectives.delete(sessionId);
    this.goalsBySession.set(sessionId, goal);
    return goal;
  }

  /** Clear a native Codex thread goal or any queued objective. */
  async clearGoal(sessionId: string): Promise<boolean> {
    const hadPending = this.pendingGoalObjectives.delete(sessionId);
    const hadLocal = this.goalsBySession.delete(sessionId);
    const state = this.runtime.get(sessionId);
    if (!state?.server.isAlive) {
      return hadPending || hadLocal;
    }
    const cleared = await state.server.clearGoal();
    return cleared || hadPending || hadLocal;
  }

  /** Read the active native Codex thread goal, falling back to queued state. */
  async getGoal(sessionId: string): Promise<GoalState | undefined> {
    const state = this.runtime.get(sessionId);
    if (!state?.server.isAlive) {
      const cachedGoal = this.goalsBySession.get(sessionId);
      return isGoalOpen(cachedGoal) ? cachedGoal : undefined;
    }
    const nativeGoal = await state.server.getGoal();
    if (!nativeGoal) {
      this.goalsBySession.delete(sessionId);
      return undefined;
    }
    const goal = this.mapCodexGoal(sessionId, nativeGoal);
    if (!isGoalOpen(goal)) {
      this.goalsBySession.delete(sessionId);
      return undefined;
    }
    this.goalsBySession.set(sessionId, goal);
    return goal;
  }

  /** Return active goal lookup metadata without spawning inactive Codex sessions. */
  async getGoalLookup(sessionId: string): Promise<GoalLookupResult> {
    const state = this.runtime.get(sessionId);
    if (!state?.server.isAlive) {
      const cachedGoal = this.goalsBySession.get(sessionId);
      return {
        goal: isGoalOpen(cachedGoal) ? cachedGoal : null,
        authoritative: false,
        source: "codex-cache",
        reason: "not-materialized",
      };
    }

    const nativeGoal = await state.server.getGoal();
    if (!nativeGoal) {
      this.goalsBySession.delete(sessionId);
      return {
        goal: null,
        authoritative: true,
        source: "codex-native",
      };
    }

    const goal = this.mapCodexGoal(sessionId, nativeGoal);
    if (!isGoalOpen(goal)) {
      this.goalsBySession.delete(sessionId);
      return {
        goal: null,
        authoritative: true,
        source: "codex-native",
        reason: "closed",
      };
    }

    this.goalsBySession.set(sessionId, goal);
    return {
      goal,
      authoritative: true,
      source: "codex-native",
    };
  }

  /**
   * Starts or continues a session by sending a message to the Codex app-server.
   * For new sessions, spawns a subprocess and runs the JSON-RPC handshake first.
   * The method returns immediately; events stream via the `event` EventEmitter channel.
   */
  async sendTurn(req: TurnRequest<"codex">): Promise<void> {
    const turn = await this.prepareCodexTurn(req);
    if (!turn) return;
    const existing = await this.reconcileCodexSession(turn);
    const reusable = this.isReusableCodexSession(existing, turn.sandbox);
    if (!this.canStartCodexTurn(turn, reusable)) return;
    this.stageCodexTurn(turn);
    const state = await this.acquireCodexTurn(turn);
    if (!state) return;
    this.finishAcquiredCodexTurn(turn, state, existing, reusable);
  }

  private async prepareCodexTurn(request: TurnRequest<"codex">): Promise<PreparedCodexTurn | undefined> {
    const settings = await this.codexPorts.settings.get();
    if (request.resumeFrom !== undefined) this.sdkSessionIds.set(request.sessionId, request.resumeFrom);
    const threadId = this.threadIdForSession(request.sessionId);
    const input = await this.resolveCodexTurnInput(request, threadId);
    if (!input) return undefined;
    return {
      request,
      threadId,
      input,
      cliPath: settings.cliPath,
      sandbox: request.permissionMode === "full" ? "danger-full-access" : "workspace-write",
      browserPermissionCapability: providerBrowserPermissionCapability(request.permissionMode, request.interactionMode),
      turnOptions: this.codexTurnOptions(request, settings.fastMode),
      threadControlEligible: request.threadControlEligible === true,
    };
  }

  private threadIdForSession(sessionId: string): string {
    return sessionId.startsWith("mcode-") ? sessionId.slice(6) : sessionId;
  }

  private async resolveCodexTurnInput(request: TurnRequest<"codex">, threadId: string): Promise<TurnInputPart[] | undefined> {
    const skillCatalog = await this.codexSkillCatalog(request.message, request.cwd);
    try {
      return await buildCodexInput(request.message, request.attachments, skillCatalog, request.mentions ?? []);
    } catch (error) {
      if (!(error instanceof CodexPromptResolutionError)) throw error;
      logger.debug("Codex prompt expansion failed", { promptName: error.promptName, cause: error.cause instanceof Error ? error.cause.message : String(error.cause) });
      this.emitTurnFailure(threadId, error.message, undefined, true, request.turnExecutionId);
      return undefined;
    }
  }

  private async codexSkillCatalog(message: string, cwd: string) {
    const nativeSkills = this.codexPorts.catalog.currentSkills(cwd);
    const invocation = parseCodexSlashInvocation(message);
    const prompts = invocation?.requestedName.startsWith("prompts:")
      ? (await this.codexPorts.catalog.refreshCustomPrompts()).prompts
      : this.codexPorts.catalog.currentPrompts();
    return [...nativeSkills, ...prompts];
  }

  private codexTurnOptions(request: TurnRequest<"codex">, defaultFastMode: boolean): CodexTurnOptions {
    const fastMode = request.providerOptions.fastMode ?? defaultFastMode;
    const orchestrationMode = request.orchestrationMode === "proactive" && supportsCodexUltraOrchestration(request.model)
      ? "proactive"
      : "standard";
    const effort = toCodexEffort(request.reasoningLevel, orchestrationMode);
    return {
      model: request.model || undefined,
      approvalsReviewer: request.approvalReviewMode === "automatic" ? "auto_review" : "user",
      ...(effort ? { effort } : {}),
      ...(fastMode ? { serviceTier: "priority" } : {}),
    };
  }

  private async reconcileCodexSession(turn: PreparedCodexTurn): Promise<CodexSessionState | undefined> {
    const existing = this.runtime.get(turn.request.sessionId);
    if (this.requiresBrowserSessionRestart(existing, turn)) {
      await this.runtime.stop(turn.request.sessionId);
      return undefined;
    }
    if (existing && existing.server.isAlive && existing.sandboxMode !== turn.sandbox) this.restartCodexSessionForSandbox(existing, turn);
    if (this.requiresThreadControlSessionRestart(existing, turn)) return this.restartCodexSessionForThreadControl(existing, turn);
    return existing;
  }

  private requiresBrowserSessionRestart(existing: CodexSessionState | undefined, turn: PreparedCodexTurn): boolean {
    return Boolean(existing && this.host.browser.isConfigured() && (existing.workspaceId !== turn.request.workspaceId || existing.browserPermissionCapability !== turn.browserPermissionCapability || (existing.browserCredential && existing.browserCredential.expiresAt <= Date.now())));
  }

  private restartCodexSessionForSandbox(existing: CodexSessionState, turn: PreparedCodexTurn): void {
    const sessionId = turn.request.sessionId;
    logger.info("Codex session restarted due to permission mode change", { sessionId, from: existing.sandboxMode, to: turn.sandbox });
    this.drainPending((entry) => entry.sessionId === sessionId);
    this.sdkSessionIds.delete(sessionId);
    void this.runtime.stop(sessionId).catch((error: unknown) => {
      logger.warn("Codex session kill on permission change failed", { error: String(error) });
    });
  }

  private requiresThreadControlSessionRestart(existing: CodexSessionState | undefined, turn: PreparedCodexTurn): existing is CodexSessionState {
    return Boolean(existing && existing.server.isAlive && existing.threadControlEligible !== turn.threadControlEligible);
  }

  private async restartCodexSessionForThreadControl(existing: CodexSessionState, turn: PreparedCodexTurn): Promise<undefined> {
    const sessionId = turn.request.sessionId;
    logger.info("Codex session restarted due to Mcode thread-control eligibility change", { sessionId, from: existing.threadControlEligible, to: turn.threadControlEligible });
    this.drainPending((entry) => entry.sessionId === sessionId);
    await this.runtime.stop(sessionId);
    return undefined;
  }

  private isReusableCodexSession(existing: CodexSessionState | undefined, sandbox: string): existing is CodexSessionState {
    return Boolean(existing && existing.server.isAlive && existing.sandboxMode === sandbox);
  }

  private canStartCodexTurn(turn: PreparedCodexTurn, reusable: boolean): boolean {
    if (reusable) return true;
    const preflight = this.checkCodexCliPreflight(turn.cliPath);
    if (preflight.ok) return true;
    const error = preflight.reason === "unavailable" ? preflight.error : `Codex CLI version ${preflight.version} is not supported. Minimum required: ${CODEX_MIN_VERSION}. Update with: npm install -g @openai/codex`;
    this.emitTurnFailure(turn.threadId, error, undefined, true, turn.request.turnExecutionId);
    return false;
  }

  private stageCodexTurn(turn: PreparedCodexTurn): void {
    const { request } = turn;
    const sessionId = request.sessionId;
    this.pendingSpawnTurns.set(sessionId, { input: turn.input, turnOptions: turn.turnOptions, turnExecutionId: request.turnExecutionId, turnId: request.turnId, deliveryAttempt: request.deliveryAttempt ?? 1, threadControlEligible: turn.threadControlEligible });
    if (!this.host.browser.isConfigured()) return;
    const stage = this.host.browser.stage({ providerId: this.id, providerSessionId: request.resumeFrom ?? sessionId, mcodeSessionId: sessionId, threadId: request.threadId, workspaceId: request.workspaceId, permissionCapability: turn.browserPermissionCapability });
    const previous = this.pendingBrowserAccess.get(sessionId);
    if (previous) this.host.browser.release(previous.stage.leaseId);
    this.pendingBrowserAccess.set(sessionId, { stage, workspaceId: request.workspaceId, permissionCapability: turn.browserPermissionCapability });
  }

  private async acquireCodexTurn(turn: PreparedCodexTurn): Promise<CodexSessionState | undefined> {
    const { request, threadId } = turn;
    try {
      return await this.runtime.acquire({ sessionId: request.sessionId, threadId, cwd: request.cwd, permissionMode: request.permissionMode, resumeFrom: request.resumeFrom !== undefined ? this.sdkSessionIds.get(request.sessionId) : undefined });
    } catch (error) {
      this.releaseStagedCodexTurn(request.sessionId);
      const message = error instanceof Error ? error.message : String(error);
      logger.error("CodexAppServer start failed", { sessionId: request.sessionId, error: message });
      this.emitTurnFailure(threadId, message, undefined, true, request.turnExecutionId);
      return undefined;
    }
  }

  private releaseStagedCodexTurn(sessionId: string): void {
    this.pendingSpawnTurns.delete(sessionId);
    const stagedBrowser = this.pendingBrowserAccess.get(sessionId);
    this.pendingBrowserAccess.delete(sessionId);
    if (stagedBrowser) this.host.browser.release(stagedBrowser.stage.leaseId);
  }

  private finishAcquiredCodexTurn(turn: PreparedCodexTurn, state: CodexSessionState, existing: CodexSessionState | undefined, reusable: boolean): void {
    const sessionId = turn.request.sessionId;
    this.runtime.recordUsage(sessionId);
    const stagedBrowser = this.pendingBrowserAccess.get(sessionId);
    this.pendingBrowserAccess.delete(sessionId);
    if (state === existing && stagedBrowser) this.host.browser.release(stagedBrowser.stage.leaseId);
    if (this.consumePendingCodexStop(turn)) return;
    if (reusable && this.pendingSpawnTurns.delete(sessionId)) this.runReusedCodexTurn(turn, state);
  }

  private consumePendingCodexStop(turn: PreparedCodexTurn): boolean {
    const sessionId = turn.request.sessionId;
    if (!this.pendingStops.delete(sessionId)) return false;
    logger.info("Pending stop consumed, tearing down new Codex session", { sessionId });
    this.pendingSpawnTurns.delete(sessionId);
    void this.runtime.stop(sessionId);
    this.emitRuntimeEvent(providerRuntimeEvent({ type: AgentEventType.Ended, threadId: turn.threadId, turnExecutionId: turn.request.turnExecutionId } satisfies AgentEvent));
    return true;
  }

  private runReusedCodexTurn(turn: PreparedCodexTurn, state: CodexSessionState): void {
    state.lastUsedAt = Date.now();
    state.turnDiffRouting = { turnId: turn.request.turnId, turnExecutionId: turn.request.turnExecutionId, deliveryAttempt: turn.request.deliveryAttempt ?? 1 };
    state.turnDiffRevision = 0;
    void this.runTurnAfterGoal(turn.request.sessionId, turn.threadId, state.server, turn.input, turn.turnOptions, turn.request.turnExecutionId);
  }

  /**
   * Spawns a fresh Codex app-server session: version-checked CLI launch, the
   * JSON-RPC handshake, mapper + event wiring, and the first turn for the
   * staged payload. Returns an empty `pids` array because {@link CodexAppServer}
   * keeps its child PID private and attaches it to the Windows JobObject
   * itself; the runtime's JobObject/taskkill are therefore best-effort no-ops
   * for Codex and teardown is delegated to `server.kill()` in {@link close}.
   */
  async spawn(args: SpawnArgs): Promise<SpawnResult<CodexSessionState>> {
    const context = await this.prepareCodexSpawn(args);
    const { internalMcp, threadId } = context;
    const browserTokenEnvName = "MCODE_BROWSER_MCP_TOKEN";
    const mcodeInstructions = this.codexSpawnInstructions(context);

    const server = this.createCodexAppServer(context, mcodeInstructions, browserTokenEnvName);
    const mapper = this.createCodexEventMapper(threadId);

    this.attachCodexServerEvents(context, server, mapper);
    const internalMcpStartup = internalMcp ? observeCodexInternalMcpStartup(server) : undefined;
    const internalMcpStartupOutcome = await this.startCodexAppServer(context, server, internalMcpStartup, browserTokenEnvName);
    this.reportCodexInternalMcpSetupFailure(context, server, internalMcpStartupOutcome);
    await this.verifyCodexInternalMcpSetup(context, server, internalMcpStartup, internalMcpStartupOutcome);
    this.refreshUsageFromServer(server, threadId);

    this.attachCodexThreadIdentity(context, server, mapper);
    const state = this.createCodexSessionState(context, server, mapper);
    this.scheduleStagedCodexTurn(context, server);

    return { state, pids: [] };
  }

  private async prepareCodexSpawn(args: SpawnArgs): Promise<CodexSpawnContext> {
    const settings = await this.codexPorts.settings.get();
    const pendingSpawn = this.pendingSpawnTurns.get(args.sessionId);
    const threadControlEligible = pendingSpawn?.threadControlEligible === true;
    const internalMcpSetup = await this.bootstrapCodexInternalMcp(args, threadControlEligible, pendingSpawn?.turnExecutionId);
    const browserAccess = this.pendingBrowserAccess.get(args.sessionId);
    const browserGrant = browserAccess ? this.host.browser.issue(browserAccess.stage) : null;
    const spawnEnv = { ...args.env };
    if (browserGrant) spawnEnv.MCODE_BROWSER_MCP_TOKEN = browserGrant.token;
    return {
      args,
      cliPath: settings.cliPath,
      sessionId: args.sessionId,
      threadId: args.threadId,
      cwd: args.cwd,
      resumeFrom: args.resumeFrom,
      sandbox: args.permissionMode === "full" ? "danger-full-access" : "workspace-write",
      approvalPolicy: args.permissionMode === "full" ? "never" : "on-request",
      pendingSpawn,
      stagedExecutionId: pendingSpawn?.turnExecutionId,
      threadControlEligible,
      browserAccess,
      internalMcp: internalMcpSetup.internalMcp,
      internalMcpSetupError: internalMcpSetup.setupError,
      closeInternalMcpAuthority: internalMcpSetup.close,
      browserGrant,
      spawnEnv,
    };
  }

  private async bootstrapCodexInternalMcp(
    args: SpawnArgs,
    threadControlEligible: boolean,
    turnExecutionId: string | undefined,
  ): Promise<CodexInternalMcpSetup> {
    const close = this.codexInternalMcpAuthorityCloser(args.sessionId);
    if (!threadControlEligible) return { internalMcp: undefined, setupError: undefined, close };
    try {
      const internalMcp = await this.host.threadControl.bootstrap({ providerId: this.id, sessionId: args.sessionId, threadId: args.threadId, turnId: turnExecutionId ?? args.threadId, protocol: "codex" }) as CodexInternalMcp | undefined;
      return { internalMcp, setupError: undefined, close };
    } catch (error) {
      await close();
      return { internalMcp: undefined, setupError: error instanceof Error ? error.message : String(error), close };
    }
  }

  private codexInternalMcpAuthorityCloser(sessionId: string): () => Promise<void> {
    let closed = false;
    return async () => {
      if (closed) return;
      closed = true;
      try {
        await this.host.threadControl.close(sessionId);
      } catch (error) {
        logger.warn("Codex internal MCP authority close failed", { sessionId, error: error instanceof Error ? error.message : String(error) });
      }
    };
  }

  private codexSpawnInstructions(context: CodexSpawnContext): string {
    const nestedDelegationModel = context.pendingSpawn?.turnOptions.model === "gpt-5.6-luna" ? "gpt-5.6-sol" : undefined;
    return renderMcodeInstructions(buildMcodeInstructionPlan({
      sourceThreadId: context.threadId,
      threadControlGranted: Boolean(context.internalMcp),
      browserAutomationGranted: Boolean(context.browserGrant),
      nestedDelegationModel,
    }));
  }

  private createCodexAppServer(
    context: CodexSpawnContext,
    developerInstructions: string,
    browserTokenEnvName: string,
  ): CodexAppServer {
    return new CodexAppServer({
      cliPath: context.cliPath,
      platform: this.host.runtime.platform,
      workingDirectory: context.cwd,
      model: undefined,
      sandbox: context.sandbox,
      approvalPolicy: context.approvalPolicy,
      resumeThreadId: context.resumeFrom || undefined,
      developerInstructions,
      approvalHandler: context.approvalPolicy === "on-request"
        ? (request) => this.handleApprovalRequest(context.sessionId, context.threadId, request)
        : undefined,
      processAttachment: this.host.processes,
      getSpawnEnv: () => ({ ...context.spawnEnv, ...context.internalMcp?.env }),
      configOverrides: this.codexAppServerConfigOverrides(context, browserTokenEnvName),
    });
  }

  private codexAppServerConfigOverrides(context: CodexSpawnContext, browserTokenEnvName: string): string[] {
    const browserOverrides = context.browserGrant
      ? [
          `mcp_servers.mcode-browser.url=${JSON.stringify(context.browserGrant.mcpUrl)}`,
          `mcp_servers.mcode-browser.bearer_token_env_var=${JSON.stringify(browserTokenEnvName)}`,
          'plugins."browser@openai-bundled".enabled=false',
        ]
      : [];
    return [...(context.internalMcp?.configOverrides ?? []), ...browserOverrides];
  }

  private createCodexEventMapper(threadId: string): CodexEventMapper {
    const mapper = new CodexEventMapper(threadId, undefined, (event) => this.emit("file_mutation_start", event));
    mapper.setOutputTruncationMode(this.outputTruncationMode);
    this.emitRuntimeEvent(mapper.sessionStartedEvent());
    return mapper;
  }

  private attachCodexServerEvents(context: CodexSpawnContext, server: CodexAppServer, mapper: CodexEventMapper): void {
    server.on("invalidNotification", () => {
      for (const event of mapper.mapNotification(undefined)) this.emitRuntimeEvent(event);
    });
    server.on("notification", (notification: CodexNotification) => this.handleCodexServerNotification(context, server, mapper, notification));
    server.on("fatal", (error: string) => this.handleCodexServerFatal(context, server, mapper, error));
    this.attachFatalDrain(context.sessionId, server);
    server.on("exit", () => {
      if (!server.isAlive) void this.runtime.stop(context.sessionId);
    });
  }

  private handleCodexServerNotification(
    context: CodexSpawnContext,
    server: CodexAppServer,
    mapper: CodexEventMapper,
    notification: CodexNotification,
  ): void {
    const rawNotification = notification;
    const entry = this.runtime.get(context.sessionId);
    const mainNotification = isMainThreadNotification(server, rawNotification.params);
    const nativeThreadId = nativeThreadIdFromParams(rawNotification.params);
    const nativeTurnId = nativeTurnIdFromParams(rawNotification.params);
    this.handleCodexUsageNotification(rawNotification, server, context.threadId);
    const replayThreadId = this.bindCodexTurnStarted(entry, rawNotification.method, mainNotification, nativeThreadId, nativeTurnId);
    const events = this.mapCodexNotificationEvents(context.threadId, notification, mapper, rawNotification);
    this.bindReceiverThreadExecution(entry, mapper, rawNotification.method, mainNotification, nativeThreadId, nativeTurnId);
    const executionId = this.codexNotificationExecutionId(entry, mainNotification, nativeThreadId, nativeTurnId);
    this.emitCodexTurnDiff(entry, rawNotification, mainNotification, nativeTurnId, executionId);
    const startupExecutionId = rawNotification.method === "mcpServer/startupStatus/updated" ? context.stagedExecutionId : undefined;
    this.deliverCodexNotificationEvents({ entry, sessionId: context.sessionId, mapper, mappedEvents: events, mainNotification, nativeThreadId, nativeTurnId, eventExecutionId: executionId, startupEventExecutionId: startupExecutionId });
    if (entry && replayThreadId) this.replayPendingChildEvents(entry, context.sessionId, replayThreadId);
    this.fetchCompletedChildMetadata(context.sessionId, context.threadId, server, mapper, rawNotification.method, nativeThreadId, executionId);
    this.handleDiscoveredCodexChildren({ entry, sessionId: context.sessionId, threadId: context.threadId, server, mapper, notification: rawNotification, nativeThreadId, eventExecutionId: executionId });
  }

  /** Subscribe to complete native turn diffs without routing their bytes through renderer events. */
  onTurnDiff(handler: (event: ProviderTurnDiffUpdate) => void): () => void {
    super.on("turn_diff", handler);
    return () => { this.removeListener("turn_diff", handler); };
  }

  /** Push a complete native aggregate only after its Mcode execution binding is authoritative. */
  private emitCodexTurnDiff(
    entry: CodexSessionState | undefined,
    notification: { method?: string; params?: Record<string, unknown> },
    mainNotification: boolean,
    nativeTurnId: string | undefined,
    executionId: string | undefined,
  ): void {
    if (notification.method !== "turn/diff/updated" || !mainNotification || !entry?.turnDiffRouting) return;
    if (!nativeTurnId || nativeTurnId !== entry.currentNativeTurnId || executionId !== entry.turnDiffRouting.turnExecutionId) return;
    const revision = ++entry.turnDiffRevision;
    this.emit("turn_diff", {
      ...entry.turnDiffRouting,
      revision,
      ...nativeTurnDiffEvidence(notification.params?.diff),
    } satisfies ProviderTurnDiffUpdate);
  }

  private handleCodexServerFatal(
    context: CodexSpawnContext,
    server: CodexAppServer,
    mapper: CodexEventMapper,
    error: string,
  ): void {
    logger.error("CodexAppServer fatal", { sessionId: context.sessionId, error, breadcrumb: server.lastTransportBreadcrumb });
    const executionId = this.runtime.get(context.sessionId)?.activeParentTurnExecutionId ?? context.stagedExecutionId;
    for (const event of mapper.drainPendingAssistantBoundary(false)) {
      this.emitRuntimeEvent(providerRuntimeEvent(executionId ? { ...event, turnExecutionId: executionId } : event));
    }
    this.emitTurnFailure(context.threadId, error, undefined, true, executionId);
    void this.runtime.stop(context.sessionId);
  }

  private async startCodexAppServer(
    context: CodexSpawnContext,
    server: CodexAppServer,
    startup: ReturnType<typeof observeCodexInternalMcpStartup> | undefined,
    browserTokenEnvName: string,
  ): Promise<CodexInternalMcpStartupOutcome | undefined> {
    try {
      return await this.startCodexAppServerWithMcp(server, startup);
    } catch (error) {
      if (context.browserGrant) this.host.browser.release(context.browserGrant.leaseId);
      startup?.cancel();
      await context.closeInternalMcpAuthority();
      if (startup) await server.kill().catch(() => undefined);
      throw error;
    } finally {
      delete context.spawnEnv[browserTokenEnvName];
      this.pendingBrowserAccess.delete(context.sessionId);
    }
  }

  private async startCodexAppServerWithMcp(
    server: CodexAppServer,
    startup: ReturnType<typeof observeCodexInternalMcpStartup> | undefined,
  ): Promise<CodexInternalMcpStartupOutcome | undefined> {
    if (!startup) {
      await server.start();
      return undefined;
    }
    const [, outcome] = await Promise.all([server.start(), startup.promise]);
    return outcome;
  }

  private reportCodexInternalMcpSetupFailure(
    context: CodexSpawnContext,
    server: CodexAppServer,
    outcome: CodexInternalMcpStartupOutcome | undefined,
  ): void {
    if (context.internalMcpSetupError) {
      this.emitInternalMcpStartupFailure(context.threadId, server.threadId ?? context.threadId, context.internalMcpSetupError, context.stagedExecutionId);
      return;
    }
    if (outcome?.status === "timeout") {
      this.emitInternalMcpStartupFailure(context.threadId, server.threadId ?? context.threadId, outcome.error, context.stagedExecutionId);
    }
  }

  private async verifyCodexInternalMcpSetup(
    context: CodexSpawnContext,
    server: CodexAppServer,
    startup: ReturnType<typeof observeCodexInternalMcpStartup> | undefined,
    outcome: CodexInternalMcpStartupOutcome | undefined,
  ): Promise<void> {
    if (!context.internalMcp || outcome?.status !== "ready") return;
    try {
      const effectiveConfig = await server.readConfig(context.cwd);
      if (!hasCodexInternalThreadControlMcp(effectiveConfig)) throw new Error("Codex app-server did not register mcode_internal_thread_control in effective configuration");
    } catch (error) {
      startup?.cancel();
      await context.closeInternalMcpAuthority();
      this.emitInternalMcpStartupFailure(context.threadId, server.threadId ?? context.threadId, error instanceof Error ? error.message : String(error), context.stagedExecutionId);
    }
  }

  private attachCodexThreadIdentity(context: CodexSpawnContext, server: CodexAppServer, mapper: CodexEventMapper): void {
    server.on("threadIdChanged", (newThreadId: string) => this.recordCodexThreadIdentity(context, mapper, newThreadId));
    if (server.resumeFailed) {
      logger.warn("Codex session context lost; resume failed, started fresh thread", { sessionId: context.sessionId });
      this.emitRuntimeEvent(providerRuntimeEvent({ type: AgentEventType.System, threadId: context.threadId, subtype: "context_lost" } satisfies AgentEvent));
    }
    if (server.threadId) this.recordCodexThreadIdentity(context, mapper, server.threadId);
  }

  private recordCodexThreadIdentity(context: CodexSpawnContext, mapper: CodexEventMapper, nativeThreadId: string): void {
    mapper.setMainCodexThreadId(nativeThreadId);
    this.sdkSessionIds.set(context.sessionId, nativeThreadId);
    this.emitRuntimeEvent(providerRuntimeEvent({ type: AgentEventType.System, threadId: context.threadId, subtype: "sdk_session_id:" + nativeThreadId } satisfies AgentEvent));
  }

  private createCodexSessionState(context: CodexSpawnContext, server: CodexAppServer, mapper: CodexEventMapper): CodexSessionState {
    const state: CodexSessionState = {
      sessionId: context.sessionId, threadId: context.threadId, cwd: context.cwd, server, mapper,
      lastUsedAt: Date.now(), sandboxMode: context.sandbox, runTurnSeq: 0, pendingTurnId: null,
      turnBindingPhase: "idle", turnStartResponsePending: false, turnExecutionIdsByNativeTurn: new Map(),
      nativeThreadExecutionIds: new Map(), nativeExecutionConflictKeys: new Set(), childExecutionGenerations: new Map(), turnDiffRevision: 0,
      nextChildGeneration: 0, pendingChildEvents: [], deliveredChildEventKeys: new Set(),
      workspaceId: context.browserAccess?.workspaceId ?? "unknown-workspace",
      browserPermissionCapability: context.browserAccess?.permissionCapability ?? "interact",
      threadControlEligible: context.threadControlEligible, childMetadataFetches: new Set(),
    };
    if (context.browserGrant) {
      state.browserCredential = { credentialId: context.browserGrant.credentialId, expiresAt: context.browserGrant.expiresAt };
      state.browserLeaseId = context.browserGrant.leaseId;
    }
    this.liveSessionIds.add(context.sessionId);
    return state;
  }

  private scheduleStagedCodexTurn(context: CodexSpawnContext, server: CodexAppServer): void {
    const staged = this.pendingSpawnTurns.get(context.sessionId);
    if (!staged || this.pendingStops.has(context.sessionId)) return;
    this.pendingSpawnTurns.delete(context.sessionId);
    setImmediate(() => this.startStagedCodexTurn(context, server, staged));
  }

  private startStagedCodexTurn(
    context: CodexSpawnContext,
    server: CodexAppServer,
    staged: { input: string | TurnInputPart[]; turnOptions: CodexTurnOptions; turnExecutionId: string; turnId: string; deliveryAttempt: number },
  ): void {
    const state = this.runtime.get(context.sessionId);
    if (!state) return;
    state.turnDiffRouting = { turnId: staged.turnId, turnExecutionId: staged.turnExecutionId, deliveryAttempt: staged.deliveryAttempt };
    state.turnDiffRevision = 0;
    void this.runTurnAfterGoal(context.sessionId, context.threadId, server, staged.input, staged.turnOptions, staged.turnExecutionId);
  }

  private handleCodexUsageNotification(
    notification: { method?: string; params?: Record<string, unknown> },
    server: CodexAppServer,
    threadId: string,
  ): void {
    if (notification.method === "account/rateLimits/updated") this.applyUsageSnapshot(notification.params, threadId);
    if (notification.method === "account/updated") {
      this.clearUsageCache();
      this.refreshUsageFromServer(server, threadId);
    }
  }

  private bindCodexTurnStarted(
    state: CodexSessionState | undefined,
    method: string | undefined,
    mainNotification: boolean,
    nativeThreadId: string | undefined,
    nativeTurnId: string | undefined,
  ): string | undefined {
    if (!state || method !== "turn/started") return undefined;
    if (mainNotification) {
      this.bindMainCodexTurnStarted(state, nativeTurnId);
      return undefined;
    }
    return this.bindChildCodexTurnStarted(state, nativeThreadId, nativeTurnId);
  }

  private bindMainCodexTurnStarted(state: CodexSessionState, nativeTurnId: string | undefined): void {
    const executionId = state.nextTurnExecutionId ?? state.currentTurnExecutionId ?? state.activeParentTurnExecutionId;
    if (executionId) state.activeParentTurnExecutionId = executionId;
    if (nativeTurnId && executionId && state.currentTurnExecutionId === executionId) {
      this.bindMainNativeTurnStart(state, nativeTurnId, executionId);
    }
    state.nextTurnExecutionId = undefined;
    state.childMetadataFetches.clear();
  }

  private bindMainNativeTurnStart(state: CodexSessionState, nativeTurnId: string, executionId: string): void {
    if (state.turnStartResponsePending) {
      state.pendingTurnStartNotification = { nativeTurnId, executionId };
      return;
    }
    if (state.currentNativeTurnId === nativeTurnId) {
      state.pendingTurnId = nativeTurnId;
      state.turnBindingPhase = "bound";
      return;
    }
    if (state.turnExecutionIdsByNativeTurn.get(nativeTurnId) === executionId) {
      state.currentNativeTurnId = nativeTurnId;
      state.pendingTurnId = nativeTurnId;
      state.turnBindingPhase = "bound";
      return;
    }
    if (state.turnExecutionIdsByNativeTurn.has(nativeTurnId)) {
      assignNativeExecution(state.turnExecutionIdsByNativeTurn, nativeTurnId, executionId, state.nativeExecutionConflictKeys);
    }
  }

  private bindChildCodexTurnStarted(
    state: CodexSessionState,
    nativeThreadId: string | undefined,
    nativeTurnId: string | undefined,
  ): string | undefined {
    if (!state.activeParentTurnExecutionId) return undefined;
    const executionId = nativeThreadId ? state.childExecutionGenerations.get(nativeThreadId)?.executionId : undefined;
    const replayThreadId = nativeTurnId && executionId && nativeThreadId
      ? this.bindChildNativeTurnStart(state, nativeThreadId, nativeTurnId, executionId)
      : undefined;
    pruneExecutionMap(state.nativeThreadExecutionIds);
    pruneExecutionMap(state.turnExecutionIdsByNativeTurn);
    return replayThreadId;
  }

  private bindChildNativeTurnStart(state: CodexSessionState, nativeThreadId: string, nativeTurnId: string, executionId: string): string | undefined {
    const assignment = assignNativeExecution(state.turnExecutionIdsByNativeTurn, nativeTurnId, executionId, state.nativeExecutionConflictKeys);
    return assignment === "conflict" ? undefined : nativeThreadId;
  }

  private mapCodexNotificationEvents(
    threadId: string,
    notification: CodexNotification,
    mapper: CodexEventMapper,
    rawNotification: { method?: string; params?: Record<string, unknown> },
  ): ProviderRuntimeEvent[] {
    const generatedImageEvents = this.mapGeneratedImageEvents(threadId, notification).map(providerRuntimeEvent);
    const mapperEvents = mapper.mapValidatedNotification(notification).events;
    const events = [...generatedImageEvents, ...mapperEvents];
    traceCodexIngest(threadId, rawNotification.method, rawNotification.params, events.map((event) => event.event));
    return events;
  }

  private bindReceiverThreadExecution(
    state: CodexSessionState | undefined,
    mapper: CodexEventMapper,
    method: string | undefined,
    mainNotification: boolean,
    nativeThreadId: string | undefined,
    nativeTurnId: string | undefined,
  ): void {
    if (!state || !nativeThreadId || mainNotification || !mapper.hasReceiverThread(nativeThreadId) || !state.activeParentTurnExecutionId) return;
    state.nativeThreadExecutionIds.set(nativeThreadId, state.activeParentTurnExecutionId);
    if (nativeTurnId && method === "turn/started") state.turnExecutionIdsByNativeTurn.set(nativeTurnId, state.activeParentTurnExecutionId);
  }

  private codexNotificationExecutionId(
    state: CodexSessionState | undefined,
    mainNotification: boolean,
    nativeThreadId: string | undefined,
    nativeTurnId: string | undefined,
  ): string | undefined {
    if (!state) return undefined;
    return this.executionForCodexNativeTurn(state, nativeTurnId)
      ?? this.executionForCodexReceiverThread(state, mainNotification, nativeThreadId, nativeTurnId)
      ?? this.executionForCodexMainThread(state, mainNotification, nativeTurnId);
  }

  private executionForCodexNativeTurn(state: CodexSessionState, nativeTurnId: string | undefined): string | undefined {
    return nativeTurnId ? state.turnExecutionIdsByNativeTurn.get(nativeTurnId) : undefined;
  }

  private executionForCodexReceiverThread(
    state: CodexSessionState,
    mainNotification: boolean,
    nativeThreadId: string | undefined,
    nativeTurnId: string | undefined,
  ): string | undefined {
    if (nativeTurnId || mainNotification || !nativeThreadId) return undefined;
    return state.nativeThreadExecutionIds.get(nativeThreadId);
  }

  private executionForCodexMainThread(state: CodexSessionState, mainNotification: boolean, nativeTurnId: string | undefined): string | undefined {
    if (!mainNotification || !state.currentTurnExecutionId || state.turnBindingPhase === "idle") return undefined;
    if (!nativeTurnId || state.turnStartResponsePending || nativeTurnId === state.currentNativeTurnId) return state.currentTurnExecutionId;
    return undefined;
  }

  private deliverCodexNotificationEvents(args: {
    entry: CodexSessionState | undefined;
    sessionId: string;
    mapper: CodexEventMapper;
    mappedEvents: ProviderRuntimeEvent[];
    mainNotification: boolean;
    nativeThreadId: string | undefined;
    nativeTurnId: string | undefined;
    eventExecutionId: string | undefined;
    startupEventExecutionId: string | undefined;
  }): void {
    for (const event of args.mappedEvents) this.deliverCodexNotificationEvent(args, event);
  }

  private deliverCodexNotificationEvent(
    args: Omit<Parameters<CodexProvider["deliverCodexNotificationEvents"]>[0], "mappedEvents">,
    event: ProviderRuntimeEvent,
  ): void {
    const eventKey = childEventIdentity(event);
    if (this.isDuplicateCodexChildEvent(args.entry, eventKey)) return;
    if (this.shouldBufferCodexChildEvent(args, event)) {
      if (args.entry && args.nativeThreadId) bufferPendingChildEvent(args.entry, event, args.nativeThreadId, args.nativeTurnId, eventKey);
      return;
    }
    this.emitCodexNotificationEvent(args, event, eventKey);
  }

  private isDuplicateCodexChildEvent(state: CodexSessionState | undefined, eventKey: string | undefined): boolean {
    if (!eventKey || !state) return false;
    return state.deliveredChildEventKeys.has(eventKey) || state.pendingChildEvents.some((item) => item.eventKey === eventKey);
  }

  private shouldBufferCodexChildEvent(
    args: Omit<Parameters<CodexProvider["deliverCodexNotificationEvents"]>[0], "mappedEvents">,
    event: ProviderRuntimeEvent,
  ): boolean {
    if (this.requiresCodexChildTurnBinding(args, event)) return true;
    return !this.canEmitCodexNotificationEvent(args, event);
  }

  private requiresCodexChildTurnBinding(
    args: Omit<Parameters<CodexProvider["deliverCodexNotificationEvents"]>[0], "mappedEvents">,
    event: ProviderRuntimeEvent,
  ): boolean {
    if (event.event.type === AgentEventType.System && event.event.systemNotice) return false;
    if (!args.entry || args.mainNotification || !args.nativeThreadId || args.nativeTurnId) return false;
    return args.mapper.hasReceiverThread(args.nativeThreadId) && Boolean(event.extension?.child);
  }

  private canEmitCodexNotificationEvent(
    args: Omit<Parameters<CodexProvider["deliverCodexNotificationEvents"]>[0], "mappedEvents">,
    event: ProviderRuntimeEvent,
  ): boolean {
    if (!args.entry || args.eventExecutionId || !isTurnScopedEvent(event.event)) return true;
    return args.mainNotification || !args.nativeThreadId;
  }

  private emitCodexNotificationEvent(
    args: Omit<Parameters<CodexProvider["deliverCodexNotificationEvents"]>[0], "mappedEvents">,
    event: ProviderRuntimeEvent,
    eventKey: string | undefined,
  ): void {
    if (eventKey && args.entry) rememberChildEventKey(args.entry, eventKey);
    this.recordGoalEvent(args.sessionId, event.event);
    this.emitRuntimeEvent(withTurnExecutionId(event, args.eventExecutionId ?? args.startupEventExecutionId));
  }

  private fetchCompletedChildMetadata(
    sessionId: string,
    threadId: string,
    server: CodexAppServer,
    mapper: CodexEventMapper,
    method: string | undefined,
    nativeThreadId: string | undefined,
    turnExecutionId: string | undefined,
  ): void {
    if (!nativeThreadId || method !== "turn/completed" || !mapper.hasReceiverThread(nativeThreadId)) return;
    this.fetchChildThreadMetadata(sessionId, threadId, server, mapper, nativeThreadId, turnExecutionId, true);
  }

  private handleDiscoveredCodexChildren(args: {
    entry: CodexSessionState | undefined;
    sessionId: string;
    threadId: string;
    server: CodexAppServer;
    mapper: CodexEventMapper;
    notification: { method?: string; params?: Record<string, unknown> };
    nativeThreadId: string | undefined;
    eventExecutionId: string | undefined;
  }): void {
    const childThreadId = nativeSubAgentThreadId(args.notification);
    if (childThreadId) this.handleCodexSubAgentThread(args, childThreadId);
    for (const childThreadId of nativeCollabSpawnThreadIds(args.notification)) {
      this.fetchChildThreadMetadata(args.sessionId, args.threadId, args.server, args.mapper, childThreadId, args.eventExecutionId);
    }
  }

  private handleCodexSubAgentThread(
    args: Parameters<CodexProvider["handleDiscoveredCodexChildren"]>[0],
    childThreadId: string,
  ): void {
    if (this.isCurrentCodexParentNotification(args)) this.registerCodexChildGeneration(args.entry as CodexSessionState, args.sessionId, childThreadId);
    this.fetchChildThreadMetadata(args.sessionId, args.threadId, args.server, args.mapper, childThreadId, args.eventExecutionId, true);
  }

  private isCurrentCodexParentNotification(args: Parameters<CodexProvider["handleDiscoveredCodexChildren"]>[0]): boolean {
    const executionId = args.entry?.currentTurnExecutionId;
    if (!args.entry || !executionId || args.eventExecutionId !== executionId) return false;
    if (args.server.threadId && args.nativeThreadId === args.server.threadId) return true;
    return Boolean(args.nativeThreadId && args.entry.nativeThreadExecutionIds.get(args.nativeThreadId) === executionId);
  }

  private registerCodexChildGeneration(state: CodexSessionState, sessionId: string, childThreadId: string): void {
    const executionId = state.currentTurnExecutionId;
    if (!executionId) return;
    state.nextChildGeneration += 1;
    state.childExecutionGenerations.set(childThreadId, { executionId, generation: state.nextChildGeneration });
    pruneChildGenerationMap(state.childExecutionGenerations);
    state.nativeThreadExecutionIds.set(childThreadId, executionId);
    pruneExecutionMap(state.nativeThreadExecutionIds);
    this.replayPendingChildEvents(state, sessionId, childThreadId);
  }

  /** Replays buffered child events once the parent activity links the child generation. */
  private replayPendingChildEvents(
    state: CodexSessionState,
    sessionId: string,
    childThreadId: string,
  ): void {
    const childMapping = state.childExecutionGenerations.get(childThreadId);
    const executionId = childMapping?.executionId;
    if (!executionId) return;

    const replayable = state.pendingChildEvents.filter((item) => item.nativeThreadId === childThreadId);
    state.pendingChildEvents = state.pendingChildEvents.filter((item) => item.nativeThreadId !== childThreadId);
    for (const item of replayable) this.replayPendingChildEvent(state, sessionId, item, childMapping, executionId);
  }

  private replayPendingChildEvent(
    state: CodexSessionState,
    sessionId: string,
    item: PendingChildEvent,
    childMapping: { executionId: string; generation: number },
    executionId: string,
  ): void {
    if (!this.matchesChildEventGeneration(item, childMapping, executionId)) return;
    if (item.eventKey && state.deliveredChildEventKeys.has(item.eventKey)) return;
    if (item.eventKey) rememberChildEventKey(state, item.eventKey);
    this.recordGoalEvent(sessionId, item.event.event);
    this.emitRuntimeEvent(withTurnExecutionId(item.event, executionId));
  }

  private matchesChildEventGeneration(
    item: PendingChildEvent,
    childMapping: { executionId: string; generation: number },
    executionId: string,
  ): boolean {
    if (item.childGeneration !== undefined) return item.childGeneration === childMapping.generation;
    return !item.executionIdAtBuffer || item.executionIdAtBuffer === executionId;
  }

  /** Fetches one native child thread's authoritative identity and model settings without affecting the parent turn. */
  private fetchChildThreadMetadata(
    sessionId: string,
    threadId: string,
    server: CodexAppServer,
    mapper: CodexEventMapper,
    childThreadId: string,
    turnExecutionId?: string,
    captureParentMessage = false,
  ): void {
    const state = this.runtime.get(sessionId);
    if (!state || state.mapper !== mapper || state.childMetadataFetches.has(childThreadId)) return;
    state.childMetadataFetches.add(childThreadId);
    const runTurnSeq = state.runTurnSeq;

    void this.lookupChildThreadMetadata({ sessionId, threadId, server, mapper, childThreadId, turnExecutionId, captureParentMessage, runTurnSeq })
      .catch((error: unknown) => {
        logger.debug("Codex child metadata lookup failed", {
          sessionId,
          childThreadId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        const currentState = this.runtime.get(sessionId);
        if (currentState?.mapper === mapper && currentState.runTurnSeq === runTurnSeq) {
          currentState.childMetadataFetches.delete(childThreadId);
        }
      });
  }

  private async lookupChildThreadMetadata(args: {
    sessionId: string;
    threadId: string;
    server: CodexAppServer;
    mapper: CodexEventMapper;
    childThreadId: string;
    turnExecutionId: string | undefined;
    captureParentMessage: boolean;
    runTurnSeq: number;
  }): Promise<void> {
    for (const delayMs of [0, 100, 300, 1_000] as const) {
      await this.waitForChildMetadataRetry(delayMs);
      const state = this.activeChildMetadataState(args.sessionId, args.mapper, args.runTurnSeq);
      if (!state) return;
      const metadata = await this.readChildThreadMetadata(args.server, args.childThreadId);
      if (!metadata) continue;
      const currentState = this.activeChildMetadataState(args.sessionId, args.mapper, args.runTurnSeq);
      if (!currentState) return;
      this.emitChildThreadMetadata(args, currentState, metadata);
      if (this.isCompleteChildMetadata(metadata, args.captureParentMessage)) return;
    }
  }

  private async waitForChildMetadataRetry(delayMs: number): Promise<void> {
    if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }

  private activeChildMetadataState(sessionId: string, mapper: CodexEventMapper, runTurnSeq: number): CodexSessionState | undefined {
    const state = this.runtime.get(sessionId);
    return state?.mapper === mapper && state.runTurnSeq === runTurnSeq ? state : undefined;
  }

  private async readChildThreadMetadata(server: CodexAppServer, childThreadId: string): Promise<Awaited<ReturnType<CodexAppServer["getChildThreadMetadata"]>> | undefined> {
    try { return await server.getChildThreadMetadata(childThreadId); }
    catch { return undefined; }
  }

  private emitChildThreadMetadata(
    args: { sessionId: string; threadId: string; mapper: CodexEventMapper; childThreadId: string; turnExecutionId: string | undefined },
    state: CodexSessionState,
    metadata: NonNullable<Awaited<ReturnType<CodexAppServer["getChildThreadMetadata"]>>>,
  ): void {
    const events = args.mapper.applyChildThreadMetadata(args.childThreadId, metadata);
    traceCodexIngest(args.threadId, "child/thread-read", { childThreadId: args.childThreadId }, events.map((event) => event.event));
    const executionId = args.turnExecutionId ?? state.nativeThreadExecutionIds.get(args.childThreadId);
    for (const event of events) { this.recordGoalEvent(args.sessionId, event.event); this.emitRuntimeEvent(withTurnExecutionId(event, executionId)); }
  }

  private isCompleteChildMetadata(metadata: { identity?: string; parentMessage?: string }, captureParentMessage: boolean): boolean {
    return Boolean(metadata.identity && (!captureParentMessage || metadata.parentMessage));
  }

  /** Eviction guard: a turn is in flight while sendTurn is awaiting completion. */
  isBusy(state: CodexSessionState): boolean {
    return state.pendingTurnId != null || state.abortPendingTurnWait !== undefined;
  }

  /** Graceful protocol interrupt of the in-flight turn (does not kill the process). */
  async interrupt(state: CodexSessionState): Promise<void> {
    const turnExecutionId = executionForDrain(state);
    for (const event of state.mapper.drainPendingAssistantBoundary(false)) {
      this.emitRuntimeEvent(providerRuntimeEvent(
        turnExecutionId ? { ...event, turnExecutionId } : event,
      ));
    }
    const nativeTurnId = state.currentNativeTurnId;
    if (nativeTurnId) {
      try {
        await state.server.interruptTurnAndDrain(nativeTurnId);
      } catch (error) {
        if (turnExecutionId) {
          this.emitRuntimeEvent(providerRuntimeEvent({
            type: AgentEventType.Ended,
            threadId: state.threadId,
            turnExecutionId,
            reason: "provider_lost",
          } satisfies AgentEvent));
        }
        throw error;
      }
    } else {
      await state.server.interruptTurn();
      if (turnExecutionId) {
        this.emitRuntimeEvent(providerRuntimeEvent({
          type: AgentEventType.Ended,
          threadId: state.threadId,
          turnExecutionId,
          reason: "provider_lost",
        } satisfies AgentEvent));
      }
    }
    state.pendingTurnStartNotification = undefined;
    state.turnStartResponsePending = false;
    state.turnBindingPhase = "idle";
    state.currentNativeTurnId = undefined;
    state.pendingTurnId = null;
    state.childExecutionGenerations.clear();
    state.nativeThreadExecutionIds.clear();
    state.pendingChildEvents = [];
  }

  /**
   * Provider teardown: drain pending permissions for this session as
   * cancelled (so orphaned approval cards clear), then kill the app-server.
   * Drives every teardown path (stop, shutdown, eviction, stale-discard).
   */
  async close(state: CodexSessionState): Promise<void> {
    await this.host.threadControl.close(state.sessionId);
    const turnExecutionId = executionForDrain(state);
    for (const event of state.mapper.drainPendingAssistantBoundary(false)) {
      this.emitRuntimeEvent(providerRuntimeEvent(
        turnExecutionId ? { ...event, turnExecutionId } : event,
      ));
    }
    this.liveSessionIds.delete(state.sessionId);
    state.pendingTurnStartNotification = undefined;
    state.turnStartResponsePending = false;
    state.turnBindingPhase = "idle";
    state.currentNativeTurnId = undefined;
    state.pendingTurnId = null;
    state.childExecutionGenerations.clear();
    state.nativeThreadExecutionIds.clear();
    state.pendingChildEvents = [];
    state.nativeExecutionConflictKeys.clear();
    this.drainPending((e) => e.sessionId === state.sessionId);
    if (state.browserLeaseId) this.host.browser.release(state.browserLeaseId);
    else if (state.browserCredential) this.host.browser.revokeCredential(state.browserCredential.credentialId);
    await state.server.kill();
  }

  /** A pooled session must be discarded before reuse if process, cwd, or sandbox changed. */
  isStale(state: CodexSessionState, args: { cwd: string; permissionMode: string }): boolean {
    if (!state.server.isAlive) return true;
    const sandbox = args.permissionMode === "full" ? "danger-full-access" : "workspace-write";
    return state.sandboxMode !== sandbox || state.cwd !== args.cwd;
  }

  /**
   * Run a handoff prompt against a throwaway Codex app-server session.
   * The pooled parent session is left untouched; the throwaway process is killed.
   */
  async runSideChannelQuery(args: {
    parentThreadId: string;
    parentSdkSessionId: string;
    prompt: string;
    abortSignal?: AbortSignal;
    conversationHistory?: string;
    cwd: string;
  }): Promise<string> {
    const { parentThreadId, prompt, abortSignal, conversationHistory, cwd } = args;
    if (abortSignal?.aborted) throw transientHandoffError("Codex side-channel query aborted before start");

    const settings = await this.codexPorts.settings.get();
    const cliPath = settings.cliPath;
    const preflight = this.checkCodexCliPreflight(cliPath);
    if (!preflight.ok) {
      const errorMessage = preflight.reason === "unavailable"
        ? preflight.error
        : `Codex CLI version ${preflight.version} is too old for side-channel handoff`;
      throw transientHandoffError(errorMessage);
    }

    const server = new CodexAppServer({
      cliPath,
      platform: this.host.runtime.platform,
      workingDirectory: cwd,
      sandbox: "read-only",
      // No approvalHandler is registered here, so side-channel tool requests
      // are denied while the handoff prompt still runs in the parent session.
      approvalPolicy: "on-request",
      // Side-channel work must never resume the MCP-enabled parent session.
      // Conversation history is supplied explicitly when available.
      resumeThreadId: undefined,
      processAttachment: this.host.processes,
      getSpawnEnv: () => ({ ...this.host.environment.snapshot() }),
    });

    let settled = false;
    const output = { deltaText: "", completedText: "" };
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const cleanup = async (): Promise<void> => {
      clearTimeout(timeout);
      abortSignal?.removeEventListener("abort", onAbort);
      await server.kill().catch((err: unknown) =>
        logger.debug("Codex side-channel kill failed", { parentThreadId, error: String(err) }),
      );
    };

    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      void cleanup();
    };

    abortSignal?.addEventListener("abort", onAbort, { once: true });

    try {
      await server.start();

      const sideChannelPrompt = conversationHistory
        ? `Conversation history up to the fork point:\n\n${conversationHistory}\n\n---\n\n${prompt}`
        : prompt;

      const result = await new Promise<string>((resolve, reject) => {
        const finish = (value: string): void => {
          abortSignal?.removeEventListener("abort", abortDuringTurn);
          server.removeListener("notification", onNotification);
          server.removeListener("fatal", onFatal);
          resolve(value);
        };
        const rejectTransient = (message: string): void => {
          abortSignal?.removeEventListener("abort", abortDuringTurn);
          server.removeListener("notification", onNotification);
          server.removeListener("fatal", onFatal);
          reject(transientHandoffError(message));
        };
        const abortDuringTurn = (): void => rejectTransient("Codex side-channel query aborted");

        timeout = setTimeout(
          () => rejectTransient("Codex side-channel query timed out"),
          SIDE_CHANNEL_TIMEOUT_MS,
        );

        const onNotification = (notification: unknown): void => {
          this.handleSideChannelNotification(notification as CodexNotification, output, finish, rejectTransient);
        };

        const onFatal = (error: string): void => rejectTransient(error);
        server.on("notification", onNotification);
        server.once("fatal", onFatal);
        abortSignal?.addEventListener("abort", abortDuringTurn, { once: true });

        void server.sendTurn(
          [{ type: "text", text: sideChannelPrompt }],
          {
            effort: "low",
            ...(settings.fastMode && { serviceTier: "priority" }),
          },
        )
          .catch((err: unknown) => rejectTransient(err instanceof Error ? err.message : String(err)));
      });

      settled = true;
      return result;
    } finally {
      await cleanup();
    }
  }

  private handleSideChannelNotification(
    notification: CodexNotification,
    output: { deltaText: string; completedText: string },
    finish: (value: string) => void,
    reject: (message: string) => void,
  ): void {
    if (notification.method === "item/agentMessage/delta") { output.deltaText += notification.params.delta ?? ""; return; }
    if (notification.method === "item/completed") { this.recordSideChannelCompletedText(notification, output); return; }
    if (notification.method === "turn/completed") this.finishSideChannelTurn(notification, output, finish, reject);
  }

  private recordSideChannelCompletedText(notification: CodexNotification, output: { completedText: string }): void {
    const text = completedAssistantText((notification.params as { item?: CompletedItem }).item);
    if (text) output.completedText = text;
  }

  private finishSideChannelTurn(
    notification: CodexNotification,
    output: { deltaText: string; completedText: string },
    finish: (value: string) => void,
    reject: (message: string) => void,
  ): void {
    const turn = (notification.params as { turn?: { status?: string; error?: { message?: string } } }).turn;
    if (turn?.status === "failed") { reject(turn.error?.message ?? "Codex side-channel query failed"); return; }
    const text = (output.completedText || output.deltaText).trim();
    if (!text) { reject("Codex side-channel query returned empty output"); return; }
    finish(text);
  }

  /** Apply a queued native goal to the app-server before dispatching a turn. */
  private async applyPendingGoal(sessionId: string, server: CodexAppServer): Promise<void> {
    const objective = this.pendingGoalObjectives.get(sessionId);
    if (!objective) return;
    const nativeGoal = await server.setGoal(objective);
    const goal = this.mapCodexGoal(sessionId, nativeGoal);
    this.pendingGoalObjectives.delete(sessionId);
    this.emitGoalUpdated(sessionId, goal);
  }

  /** Applies any queued goal, then sends the turn. */
  private async runTurnAfterGoal(
    sessionId: string,
    threadId: string,
    server: CodexAppServer,
    input: string | TurnInputPart[],
    turnOptions: CodexTurnOptions | undefined,
    turnExecutionId: string,
  ): Promise<void> {
    try {
      await this.applyPendingGoal(sessionId, server);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error("Codex goal install failed", { sessionId, error });
      this.emitGoalCleared(sessionId, "rollback");
      this.emitTurnFailure(threadId, error, "errored", true, turnExecutionId);
      return;
    }
    await this.runTurn(sessionId, threadId, server, input, turnOptions, turnExecutionId);
  }

  /**
   * Sends a single turn to the app-server and waits for matching `turn/completed`.
   * Overlapping sends preempt prior waits so stale completions cannot finish
   * the wrong promise. Emits `ended` when the turn finishes for this wait only.
   */
  private async runTurn(
    sessionId: string,
    threadId: string,
    server: CodexAppServer,
    input: string | TurnInputPart[],
    turnOptions: CodexTurnOptions | undefined,
    turnExecutionId: string,
  ): Promise<void> {
    const run = this.prepareCodexTurnRun(sessionId, turnExecutionId);
    if (!run) return;
    if (run.hadInflightTurn) await server.interruptTurn();
    const completion: CodexTurnCompletionState = {
      serverDied: false,
      endedOutcome: undefined,
      deferredEnded: undefined,
      earlyCompletionTurnId: undefined,
    };
    try {
      await this.waitForCodexTurn(run, server, input, turnOptions, sessionId, turnExecutionId, completion);
    } catch (error) {
      if (this.handleCodexTurnWaitError(error, run, server, sessionId, threadId, turnExecutionId, completion)) return;
    } finally {
      this.finalizeCodexTurnRun(run, completion, threadId, turnExecutionId);
    }
  }

  private prepareCodexTurnRun(sessionId: string, turnExecutionId: string): CodexTurnRun | undefined {
    const entry = this.runtime.get(sessionId);
    if (!entry) return undefined;
    this.emitCodexPendingAssistantBoundary(entry, turnExecutionId);
    entry.mapper.prepareForTurn();
    const hadInflightTurn = entry.pendingTurnId !== null || entry.abortPendingTurnWait !== undefined;
    entry.currentTurnExecutionId = turnExecutionId;
    entry.currentNativeTurnId = undefined;
    entry.turnBindingPhase = "awaiting";
    entry.turnStartResponsePending = true;
    entry.pendingTurnStartNotification = undefined;
    entry.activeParentTurnExecutionId = turnExecutionId;
    entry.nextTurnExecutionId = turnExecutionId;
    entry.childExecutionGenerations.clear();
    entry.pendingChildEvents = [];
    entry.abortPendingTurnWait?.();
    entry.abortPendingTurnWait = undefined;
    entry.runTurnSeq += 1;
    entry.pendingTurnId = null;
    return { entry, seq: entry.runTurnSeq, hadInflightTurn };
  }

  private emitCodexPendingAssistantBoundary(entry: CodexSessionState, turnExecutionId: string): void {
    for (const event of entry.mapper.drainPendingAssistantBoundary(false)) this.emitCodexTurnEvent(event, turnExecutionId);
  }

  private emitCodexTurnEvent(event: AgentEvent, turnExecutionId: string): void {
    this.emitRuntimeEvent(providerRuntimeEvent({ ...event, turnExecutionId }));
  }

  private async waitForCodexTurn(
    run: CodexTurnRun,
    server: CodexAppServer,
    input: string | TurnInputPart[],
    turnOptions: CodexTurnOptions | undefined,
    sessionId: string,
    turnExecutionId: string,
    completion: CodexTurnCompletionState,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let activityTimer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const cleanup = () => {
        if (settled) return;
        settled = true;
        if (activityTimer) clearTimeout(activityTimer);
        server.removeListener("notification", onNotification);
        server.removeListener("activity", onActivity);
        server.removeListener("fatal", onFatal);
        if (run.entry.abortPendingTurnWait === abortThis) run.entry.abortPendingTurnWait = undefined;
      };
      const armTimer = () => {
        if (activityTimer) clearTimeout(activityTimer);
        activityTimer = setTimeout(() => this.watchCodexTurnSilence(sessionId, server, () => settled, armTimer, cleanup, reject), TURN_TIMEOUT_MS);
      };
      const onActivity = () => armTimer();
      const abortThis = () => { cleanup(); reject(new CodexTurnSupersededError()); };
      const onNotification = (notification: unknown) => {
        armTimer();
        if (this.handleCodexTurnCompletionNotification(notification, server, run, turnExecutionId, completion)) {
          cleanup();
          resolve();
        }
      };
      const onFatal = () => { cleanup(); completion.serverDied = true; reject(new Error("Codex app-server died during turn")); };
      run.entry.abortPendingTurnWait = abortThis;
      armTimer();
      server.on("notification", onNotification);
      server.on("activity", onActivity);
      server.once("fatal", onFatal);
      void this.sendCodexTurnStart(run, server, input, turnOptions, turnExecutionId, completion, cleanup, resolve, reject);
    });
  }

  private watchCodexTurnSilence(
    sessionId: string,
    server: CodexAppServer,
    isSettled: () => boolean,
    rearm: () => void,
    cleanup: () => void,
    reject: (error: Error) => void,
  ): void {
    if (this.hasPendingApprovalFor(sessionId)) { rearm(); return; }
    void server.ping().then((alive) => {
      if (isSettled()) return;
      if (alive) {
        logger.debug("Codex turn silent but server responsive; watchdog re-armed", { sessionId, silenceMs: TURN_TIMEOUT_MS });
        rearm();
        return;
      }
      cleanup();
      reject(new CodexTurnIdleTimeoutError());
    });
  }

  private handleCodexTurnCompletionNotification(
    notification: unknown,
    server: CodexAppServer,
    run: CodexTurnRun,
    turnExecutionId: string,
    completion: CodexTurnCompletionState,
  ): boolean {
    const rawNotification = notification as { method?: string; params?: Record<string, unknown> };
    if (rawNotification.method !== "turn/completed") return false;
    const nativeTurnId = nativeTurnIdFromParams(rawNotification.params);
    if (!this.isCodexCurrentTurnCompletion(server, run.entry, rawNotification.params, nativeTurnId, turnExecutionId)) return false;
    const turn = rawNotification.params?.turn as { status?: string } | undefined;
    if (this.codexCompletionBeforeBinding(run.entry, nativeTurnId, turnExecutionId)) {
      completion.endedOutcome = this.codexTurnCompletionOutcome(turn?.status);
      completion.earlyCompletionTurnId = nativeTurnId;
      return false;
    }
    if (!this.isProvenCodexTurnCompletion(run.entry, nativeTurnId, turnExecutionId)) {
      this.logIgnoredCodexTurnCompletion(run, nativeTurnId);
      return false;
    }
    completion.endedOutcome = this.codexTurnCompletionOutcome(turn?.status);
    return run.seq === run.entry.runTurnSeq;
  }

  private isCodexCurrentTurnCompletion(
    server: CodexAppServer,
    entry: CodexSessionState,
    params: Record<string, unknown> | undefined,
    nativeTurnId: string | undefined,
    turnExecutionId: string,
  ): boolean {
    return this.nativeTurnBelongsToCodexExecution(entry, nativeTurnId, turnExecutionId)
      || isMainThreadNotification(server, params);
  }

  private nativeTurnBelongsToCodexExecution(entry: CodexSessionState, nativeTurnId: string | undefined, turnExecutionId: string): boolean {
    if (!nativeTurnId) return true;
    return nativeTurnId === entry.currentNativeTurnId
      || nativeTurnId === entry.pendingTurnStartNotification?.nativeTurnId
      || entry.turnExecutionIdsByNativeTurn.get(nativeTurnId) === turnExecutionId;
  }

  private codexTurnCompletionOutcome(status: string | undefined): CodexEndedOutcome {
    if (status === "failed") return "errored";
    return status === "interrupted" ? "cancelled" : "completed";
  }

  private codexCompletionBeforeBinding(entry: CodexSessionState, nativeTurnId: string | undefined, turnExecutionId: string): boolean {
    if (!entry.turnStartResponsePending || entry.currentTurnExecutionId !== turnExecutionId || !nativeTurnId) return false;
    return !entry.pendingTurnStartNotification || entry.pendingTurnStartNotification.nativeTurnId === nativeTurnId;
  }

  private isProvenCodexTurnCompletion(entry: CodexSessionState, nativeTurnId: string | undefined, turnExecutionId: string): boolean {
    return entry.currentTurnExecutionId === turnExecutionId && Boolean(entry.currentNativeTurnId) && nativeTurnId === entry.currentNativeTurnId;
  }

  private logIgnoredCodexTurnCompletion(run: CodexTurnRun, nativeTurnId: string | undefined): void {
    logger.debug("Codex turn/completed ignored (stale or unmatched)", {
      tid: nativeTurnId,
      pending: run.entry.pendingTurnId,
      currentNativeTurnId: run.entry.currentNativeTurnId,
      currentExecutionId: run.entry.currentTurnExecutionId,
      seq: run.seq,
      liveSeq: run.entry.runTurnSeq,
    });
  }

  private async sendCodexTurnStart(
    run: CodexTurnRun,
    server: CodexAppServer,
    input: string | TurnInputPart[],
    turnOptions: CodexTurnOptions | undefined,
    turnExecutionId: string,
    completion: CodexTurnCompletionState,
    cleanup: () => void,
    resolve: () => void,
    reject: (error: unknown) => void,
  ): Promise<void> {
    try {
      const turnId = await server.sendTurn(input, turnOptions);
      if (run.seq !== run.entry.runTurnSeq) return;
      run.entry.turnStartResponsePending = false;
      run.entry.pendingTurnStartNotification = undefined;
      this.bindCodexTurnStartResponse(run.entry, turnId, turnExecutionId);
      if (completion.earlyCompletionTurnId === turnId) { cleanup(); resolve(); }
    } catch (error) {
      cleanup();
      reject(error);
    }
  }

  private bindCodexTurnStartResponse(entry: CodexSessionState, turnId: string | null | undefined, turnExecutionId: string): void {
    if (!turnId) {
      entry.turnBindingPhase = "idle";
      throw new Error("Codex turn/start response missing turn id");
    }
    const assignment = assignNativeExecution(entry.turnExecutionIdsByNativeTurn, turnId, turnExecutionId, entry.nativeExecutionConflictKeys);
    if (assignment === "conflict") throw new Error("Codex turn/start response reused native turn id");
    entry.currentNativeTurnId = turnId;
    entry.pendingTurnId = turnId;
    entry.turnBindingPhase = "bound";
    pruneExecutionMap(entry.turnExecutionIdsByNativeTurn);
  }

  private handleCodexTurnWaitError(
    error: unknown,
    run: CodexTurnRun,
    server: CodexAppServer,
    sessionId: string,
    threadId: string,
    turnExecutionId: string,
    completion: CodexTurnCompletionState,
  ): boolean {
    if (error instanceof CodexTurnSupersededError) return true;
    if (error instanceof CodexTurnIdleTimeoutError) {
      completion.endedOutcome = "errored";
      logger.warn("Codex turn idle timeout (suppressed from UI)", { sessionId, timeoutMs: TURN_TIMEOUT_MS });
      this.emitCodexPendingAssistantBoundary(run.entry, turnExecutionId);
      this.resetIdleCodexTurn(run.entry);
      void server.interruptTurn();
      return true;
    }
    if (!completion.serverDied && run.seq === run.entry.runTurnSeq) {
      completion.endedOutcome = "errored";
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Codex turn failed", { sessionId, error: message });
      this.emitCodexPendingAssistantBoundary(run.entry, turnExecutionId);
      completion.deferredEnded = this.emitTurnFailure(threadId, message, completion.endedOutcome, false, turnExecutionId);
    }
    return false;
  }

  private resetIdleCodexTurn(entry: CodexSessionState): void {
    entry.pendingTurnStartNotification = undefined;
    entry.turnStartResponsePending = false;
    entry.turnBindingPhase = "idle";
    entry.currentNativeTurnId = undefined;
    entry.pendingTurnId = null;
    entry.childExecutionGenerations.clear();
    entry.nativeThreadExecutionIds.clear();
    entry.pendingChildEvents = [];
  }

  private finalizeCodexTurnRun(
    run: CodexTurnRun,
    completion: CodexTurnCompletionState,
    threadId: string,
    turnExecutionId: string,
  ): void {
    if (run.seq === run.entry.runTurnSeq) this.clearCodexTurnRunState(run.entry);
    if (!completion.serverDied && run.seq === run.entry.runTurnSeq) {
      this.emitCodexTurnEvent(completion.deferredEnded ?? {
        type: AgentEventType.Ended,
        threadId,
        turnExecutionId,
        ...(completion.endedOutcome ? { outcome: completion.endedOutcome } : {}),
      } satisfies AgentEvent, turnExecutionId);
    }
  }

  private clearCodexTurnRunState(entry: CodexSessionState): void {
    entry.pendingTurnId = null;
    entry.turnBindingPhase = "idle";
    entry.turnStartResponsePending = false;
    entry.pendingTurnStartNotification = undefined;
    entry.pendingChildEvents = [];
  }

  /** Persist Codex-generated image output files before the turn finalizes. */
  private mapGeneratedImageEvents(threadId: string, notification: CodexNotification): AgentEvent[] {
    if (notification.unrecognized || notification.method !== "item/completed") return [];
    const item = notification.params.item;
    if (item?.type !== "imageGeneration") return [];

    const savedPath = generatedImagePathFromCodexItem(item);
    if (!savedPath) {
      logger.debug("Codex imageGeneration completed without a savedPath", {
        threadId,
        itemId: item.id,
      });
      return [];
    }

    try {
      const attachment = this.codexPorts.attachments.persistGeneratedImageFromPath(threadId, savedPath);
      return [{
        type: AgentEventType.GeneratedAttachment,
        threadId,
        attachment,
      }];
    } catch (err) {
      logger.warn("Codex generated image could not be persisted", {
        threadId,
        itemId: item.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * Bridges a codex app-server serverRequest into the Phase 1 permission flow.
   * Allocates a requestId, synthesises a PermissionRequest for the card UI,
   * emits permission_request, and returns a promise that the app-server
   * response listener awaits. Resolved by resolvePermission or by session
   * shutdown/stop (which supply "cancelled").
   */
  private handleApprovalRequest(
    sessionId: string,
    threadId: string,
    request: CodexApprovalRequest,
  ): Promise<unknown> {
    const requestId = NodeCrypto.randomUUID();
    const synthesized = synthesizeCodexPermissionRequest({
      threadId,
      requestId,
      method: request.method,
      params: request.params,
    });

    return new Promise<unknown>((resolve) => {
      this.pendingPermissions.set(requestId, {
        sessionId,
        threadId,
        toolName: synthesized.toolName,
        input: synthesized.input,
        title: synthesized.title,
        method: request.method,
        params: request.params,
        resolve,
      });
      this.emit("permission_request", synthesized satisfies PermissionRequest);
    });
  }

  /**
   * Resolve a pending permission request. Mirrors ClaudeProvider.resolvePermission.
   * Returns true if requestId was found. On resolve, the codex app-server unblocks.
   */
  resolvePermission(requestId: string, decision: PermissionDecision): boolean {
    const entry = this.pendingPermissions.get(requestId);
    if (!entry) return false;
    this.pendingPermissions.delete(requestId);

    // Reset idle timer on the owning session so user attention counts as activity.
    this.runtime.recordUsage(entry.sessionId);
    const session = this.runtime.get(entry.sessionId);
    if (session) session.lastUsedAt = Date.now();

    const response = mapDecisionToCodexResponse(entry.method, decision, entry.params);
    entry.resolve(response);
    this.emit("permission_resolved", { requestId, decision });
    return true;
  }

  /** List pending permissions for a given thread. */
  listPendingPermissions(threadId: string): PermissionRequest[] {
    const out: PermissionRequest[] = [];
    for (const [requestId, entry] of this.pendingPermissions) {
      if (entry.threadId !== threadId) continue;
      out.push({
        requestId,
        threadId: entry.threadId,
        toolName: entry.toolName,
        input: entry.input,
        title: entry.title,
      });
    }
    return out;
  }

  /**
   * Install a fatal listener on a CodexAppServer that drains pending permissions
   * for this session when the child process dies unexpectedly. Kept as its own
   * method so tests can invoke it against a stub EventEmitter.
   */
  private attachFatalDrain(sessionId: string, server: { on: (e: string, h: (...args: unknown[]) => void) => void }): void {
    server.on("fatal", () => {
      this.drainPending((e) => e.sessionId === sessionId);
    });
  }

  /** True when at least one permission approval is awaiting the user for this session. */
  private hasPendingApprovalFor(sessionId: string): boolean {
    for (const entry of this.pendingPermissions.values()) {
      if (entry.sessionId === sessionId) return true;
    }
    return false;
  }

  /**
   * Drain all pending permissions that match a predicate, resolving each as "cancelled".
   * Used by stopSession and shutdown to unblock any in-flight approvals so the
   * codex turn can tear down cleanly.
   */
  private drainPending(predicate: (entry: PendingPermissionEntry) => boolean): void {
    for (const [requestId, entry] of Array.from(this.pendingPermissions)) {
      if (!predicate(entry)) continue;
      this.pendingPermissions.delete(requestId);
      const response = mapDecisionToCodexResponse(entry.method, "cancelled", entry.params);
      entry.resolve(response);
      this.emit("permission_resolved", { requestId, decision: "cancelled" as const });
    }
  }

  /**
   * Kills a running session's subprocess and cancels any pending permissions
   * for its thread. The runtime's `stop` runs `interrupt` → `close` (which
   * drains permissions for the session, see {@link close}) → hard kill. When
   * the session has not spawned yet, record the intent so `sendTurn`/`spawn`
   * tear it down on arrival.
   */
  async stopSession(sessionId: string): Promise<void> {
    const exists = this.runtime.get(sessionId) !== undefined;
    // Resolve host approvals before teardown can block on provider I/O. The
    // close path repeats this drain defensively, but the stop contract must
    // settle waiting requests even when interrupt/close is slow or stuck.
    this.drainPending((e) => e.sessionId === sessionId);
    if (exists) {
      await this.runtime.stop(sessionId);
    } else {
      // Drain any pending permissions for a session still mid-spawn so cards
      // clear immediately; close() will not run until/unless the session lands.
      this.drainPending((e) => e.sessionId === sessionId);
      this.pendingStops.add(sessionId);
      this.pendingSpawnTurns.delete(sessionId);
      const stagedBrowser = this.pendingBrowserAccess.get(sessionId);
      this.pendingBrowserAccess.delete(sessionId);
      if (stagedBrowser) this.host.browser.release(stagedBrowser.stage.leaseId);
      setTimeout(() => this.pendingStops.delete(sessionId), 10_000);
    }
  }

  /** Interrupt one exact native child turn while retaining the parent session. */
  async interruptChildTurn(
    sessionId: string,
    nativeThreadId: string,
    nativeTurnId: string,
  ): Promise<void> {
    const state = this.runtime.get(sessionId);
    if (!state) throw new Error(`Codex session is not active: ${sessionId}`);
    await state.server.interruptChildTurn(nativeThreadId, nativeTurnId);
  }

  /**
   * Force-discard the pooled session so the next sendTurn spawns fresh. Pure
   * pool eviction via the runtime's `stop` (interrupt → close → hard kill),
   * leaving goals and pending permissions intact for the retry turn.
   */
  async discardSession(sessionId: string): Promise<void> {
    if (this.runtime.get(sessionId) === undefined) return;
    await this.runtime.stop(sessionId);
  }

  /** Tears down all sessions, drains pending permissions, and stops the eviction timer. */
  shutdown(): void {
    // Drain everything up front: `runtime.shutdown` stops each session
    // (close drains per-session), but draining all here also clears any
    // permissions whose session never landed in the pool.
    this.drainPending(() => true);
    void this.runtime.shutdown().catch((err: unknown) => {
      logger.warn("Codex runtime shutdown failed", { error: String(err) });
    });
    void this.codexPorts.catalog.shutdown().catch((err: unknown) => {
      logger.warn("Codex catalog shutdown failed", { error: String(err) });
    });
    this.sdkSessionIds.clear();
    this.pendingSpawnTurns.clear();
    this.pendingBrowserAccess.clear();
    this.liveSessionIds.clear();
    logger.info("CodexProvider shutdown complete");
  }
}
