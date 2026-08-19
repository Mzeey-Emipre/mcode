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

import { EventEmitter } from "events";
import { createHash, randomUUID } from "crypto";
import { logger } from "@mcode/shared";
import { buildMcodeInstructionPlan, renderMcodeInstructions } from "@mcode/thread-orchestration";
import {
  providerBrowserPermissionCapability,
  type ProviderBrowserCredentialMetadata,
  type ProviderBrowserLeaseHandle,
  type ProviderHostPorts,
} from "../../host-ports.js";
import type { CodexProviderPorts } from "../../factory-types.js";
import { SessionRuntime } from "../session-runtime.js";
import type { ProtocolAdapter, SpawnArgs, SpawnResult } from "../session-runtime.js";
import type {
  IAgentProvider,
  IGoalCapable,
  ISessionEvictable,
  SessionForker,
  ForkRequest,
  HandoffArtifact,
  HandoffMeta,
  TurnRequest,
  AgentEvent,
  AttachmentMeta,
  GoalState,
  GoalLookupResult,
  MessageMention,
  PermissionDecision,
  PermissionRequest,
  ProviderModelInfo,
  ProviderUsageInfo,
  ProviderCapabilityName,
  ProviderCapabilityIdentity,
  QuotaCategory,
  SkillInfo,
} from "@mcode/contracts";
import { AgentEventType, CODEX_STATIC_MODELS, isGoalOpen, isVirtualBrowserContextAttachment, supportsCodexUltraOrchestration } from "@mcode/contracts";
import { checkCodexVersion, meetsMinVersion } from "./codex-version.js";
import { CodexAppServer, warmCodexAppServer } from "./codex-app-server.js";
import type { CodexApprovalRequest } from "./codex-app-server.js";
import { CodexEventMapper } from "./codex-event-mapper.js";
import { traceCodexIngest } from "./codex-trace.js";
import type {
  TurnInputPart,
  CodexNotification,
  CodexRateLimitWindow,
  CodexRateLimitsPayload,
  CodexTurnOptions,
  CompletedItem,
  ThreadGoal,
} from "./codex-types.js";
import { toCodexEffort } from "./codex-types.js";
import {
  mapDecisionToCodexResponse,
  synthesizeCodexPermissionRequest,
} from "./codex-permission-mapper.js";
import {
  CodexPromptResolutionError,
  expandCodexPromptCommand,
  isCodexPromptCommand,
  parseCodexSlashInvocation,
} from "./codex-prompt.js";

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
const MAX_PENDING_CHILD_EVENTS = 128;
const MAX_CHILD_EVENT_DELIVERY_KEYS = 512;
const MAX_CHILD_THREADS_PER_NOTIFICATION = 128;

type BrowserAutomationCredentialMetadata = ProviderBrowserCredentialMetadata;
type BrowserAutomationSessionLeaseStage = ProviderBrowserLeaseHandle;
type MemoryPressureLevel = "normal" | "warning" | "critical";

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

function codexRateLimitLabel(windowDurationMins: number | undefined, fallback: string): string {
  if (windowDurationMins === 300) return "5-hour limit";
  if (windowDurationMins === 10_080) return "Weekly limit";
  return fallback;
}

/** Maps Codex app-server account rate limits into shared usage categories. */
export function mapCodexRateLimitsToUsage(payload: unknown): ProviderUsageInfo {
  const categories: QuotaCategory[] = [];
  const rateLimits = readCodexRateLimits(payload);
  const windows = [
    { label: "Primary limit", limit: rateLimits?.primary ?? null },
    { label: "Secondary limit", limit: rateLimits?.secondary ?? null },
  ];

  for (const { label, limit } of windows) {
    const usedPercent = limit?.usedPercent;
    if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) {
      continue;
    }
    const windowDurationMins = limit?.windowDurationMins;
    const resetsAt = limit?.resetsAt;
    const used = Math.max(0, Math.min(100, usedPercent));
    const resetDate = codexResetDate(resetsAt);
    categories.push({
      label: codexRateLimitLabel(windowDurationMins, label),
      used,
      total: 100,
      remainingPercent: Math.max(0, Math.min(1, (100 - used) / 100)),
      resetDate,
      isUnlimited: false,
    });
  }

  return { providerId: "codex", quotaCategories: categories };
}

function codexUsageCategoryOrder(category: QuotaCategory): number {
  const label = category.label.trim();
  if (/^5[- ]hour/i.test(label)) return 0;
  if (/^weekly/i.test(label)) return 1;
  return 2;
}

/**
 * Merges Codex account usage snapshots, preserving existing buckets when the
 * app-server sends sparse rolling updates.
 */
export function mergeCodexUsageInfo(
  current: ProviderUsageInfo,
  next: ProviderUsageInfo,
): ProviderUsageInfo {
  if (next.quotaCategories.length === 0) return current;

  const byLabel = new Map<string, QuotaCategory>();
  for (const category of current.quotaCategories) {
    byLabel.set(category.label, category);
  }
  for (const category of next.quotaCategories) {
    byLabel.set(category.label, category);
  }

  return {
    providerId: "codex",
    quotaCategories: [...byLabel.values()].sort((a, b) => (
      codexUsageCategoryOrder(a) - codexUsageCategoryOrder(b)
      || a.label.localeCompare(b.label)
    )),
  };
}

/** Returns true when two provider usage snapshots are equivalent. */
export function isSameProviderUsageInfo(a: ProviderUsageInfo, b: ProviderUsageInfo): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function readCodexRateLimits(payload: unknown): CodexRateLimitsPayload["rateLimits"] {
  if (!isRecord(payload)) return undefined;
  const rateLimits = payload.rateLimits;
  if (!isRecord(rateLimits)) return undefined;
  return {
    primary: readCodexRateLimitWindow(rateLimits.primary),
    secondary: readCodexRateLimitWindow(rateLimits.secondary),
  };
}

function readCodexRateLimitWindow(value: unknown): CodexRateLimitWindow | null {
  if (!isRecord(value)) return null;
  const usedPercent = typeof value.usedPercent === "number" ? value.usedPercent : undefined;
  const windowDurationMins =
    typeof value.windowDurationMins === "number" && Number.isFinite(value.windowDurationMins)
      ? value.windowDurationMins
      : undefined;
  const resetsAt =
    typeof value.resetsAt === "number" && Number.isFinite(value.resetsAt)
      ? value.resetsAt
      : undefined;
  return { usedPercent, windowDurationMins, resetsAt };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reports whether Codex effective configuration registered the internal MCP server. */
export function hasCodexInternalThreadControlMcp(effectiveConfig: unknown): boolean {
  if (!isRecord(effectiveConfig) || !isRecord(effectiveConfig.config)) return false;
  const mcpServers = effectiveConfig.config.mcp_servers;
  return (
    mcpServers !== null &&
    typeof mcpServers === "object" &&
    Object.prototype.hasOwnProperty.call(mcpServers, "mcode_internal_thread_control")
  );
}

function codexResetDate(resetsAt: number | undefined): string | undefined {
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt)) return undefined;
  const resetDate = new Date(resetsAt * 1000);
  return Number.isFinite(resetDate.getTime()) ? resetDate.toISOString() : undefined;
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
    const value = notification as { method?: unknown; params?: Record<string, unknown> };
    if (value.method !== "mcpServer/startupStatus/updated") return;
    if (value.params?.name !== "mcode_internal_thread_control") return;
    const status = typeof value.params.status === "string" ? value.params.status : "";
    if (status === "ready") finish({ status: "ready" });
    else if (status === "failed" || status === "error") {
      // Codex keeps the thread usable when one MCP is unavailable.
      const error = typeof value.params.error === "string"
        ? value.params.error
        : typeof value.params.failureReason === "string"
          ? value.params.failureReason
          : undefined;
      finish({ status: "failed", source: "native", ...(error ? { error } : {}) });
    } else if (status === "cancelled") finish({ status: "cancelled" });
  };
  server.on("notification", onNotification);
  timer = setTimeout(
    () => finish({ status: "timeout", error: "Codex internal MCP startup timed out" }),
    CODEX_MCP_STARTUP_TIMEOUT_MS,
  );
  return { promise, cancel: () => finish({ status: "cancelled" }) };
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

/**
 * Builds the Codex turn input from a message string and optional attachments.
 * Images become `localImage` parts; non-image files become sanitised text notes
 * that omit internal filesystem paths to prevent prompt injection.
 */
async function buildCodexInput(
  message: string,
  attachments?: AttachmentMeta[],
  skills: readonly SkillInfo[] = [],
  mentions: readonly MessageMention[] = [],
): Promise<TurnInputPart[]> {
  const inputs: TurnInputPart[] = [];

  for (const att of attachments ?? []) {
    if (isVirtualBrowserContextAttachment(att.mimeType)) continue;
    if (att.mimeType.startsWith("image/")) {
      inputs.push({ type: "localImage", path: att.sourcePath });
    } else {
      // Strip control characters (including newlines) from user-supplied strings
      // to prevent prompt injection. Do not expose internal filesystem paths.
      const safeName = att.name.replace(/[\x00-\x1f\x7f]/g, "");
      const safeMime = att.mimeType.replace(/[\x00-\x1f\x7f]/g, "");
      inputs.push({ type: "text", text: `[Attached file: ${safeName} (${safeMime})]` });
    }
  }

  for (const mention of mentions) {
    if (mention.kind !== "file" && mention.kind !== "plugin") continue;
    inputs.push({
      type: "mention",
      name: mention.label,
      path: mention.path,
    });
  }

  const wireMessage = rewriteAgentMentionsAsSubagentUris(message, mentions);
  const invocation = await resolveCodexSlashInvocation(wireMessage, skills, mentions);
  if (invocation.skillItem) inputs.push(invocation.skillItem);
  inputs.push({ type: "text", text: invocation.text });
  return inputs;
}

function rewriteAgentMentionsAsSubagentUris(
  message: string,
  mentions: readonly MessageMention[],
): string {
  let text = message;
  const agentMentions = mentions
    .filter((mention) => mention.kind === "agent")
    .sort((a, b) => b.range.start - a.range.start);

  for (const mention of agentMentions) {
    const displayText = `@${mention.label}`;
    if (
      mention.range.start < 0 ||
      mention.range.end > text.length ||
      text.slice(mention.range.start, mention.range.end) !== displayText
    ) {
      continue;
    }
    text =
      text.slice(0, mention.range.start) +
      `subagent://${mention.name}` +
      text.slice(mention.range.end);
  }

  return text;
}

/** Translates Mcode slash invocations into Codex-native skill or prompt input. */
async function resolveCodexSlashInvocation(
  message: string,
  skills: readonly SkillInfo[],
  mentions: readonly MessageMention[],
): Promise<{ text: string; skillItem?: TurnInputPart }> {
  const slash = parseCodexSlashInvocation(message);
  if (!slash) return { text: message };

  const leadingSpace = message.length - message.trimStart().length;
  const commandEnd = leadingSpace + slash.requestedName.length + 1;
  const selectedMention = mentions.find((mention): mention is Extract<
    MessageMention,
    { kind: "command" }
  > => (
    mention.kind === "command"
    && mention.label === slash.requestedName
    && mention.range.start === leadingSpace
    && mention.range.end === commandEnd
    && mention.capabilityIdentity?.providerId === "codex"
  ));
  const selectedIdentity = selectedMention?.capabilityIdentity;
  const candidates = skills.filter((item) => (
    item.name === slash.requestedName || item.nativeName === slash.requestedName
  ));
  const selected = selectedIdentity
    ? candidates.find((item) => matchesCodexCapabilityIdentity(item, selectedIdentity))
    : undefined;
  const promptCommand = selectedIdentity?.kind === "customPrompt"
    ? selected && isCodexPromptCommand(selected, slash.requestedName) ? selected : undefined
    : selectedIdentity
      ? undefined
      : candidates.find((item) => isCodexPromptCommand(item, slash.requestedName));

  if (promptCommand) {
    return { text: await expandCodexPromptCommand(promptCommand, slash.args) };
  }

  const skill = selectedIdentity?.kind === "skill"
    ? selected?.kind === "skill" ? selected : undefined
    : selectedIdentity
      ? undefined
      : candidates.find((item) => item.kind === "skill");
  if (skill) {
    const nativeName = skill.nativeName ?? skill.name.split(":").pop() ?? skill.name;
    const args = slash.args.trimStart();
    const text = `$${nativeName}${args ? ` ${args}` : ""}`;
    return {
      text,
      ...(skill.path
        ? { skillItem: { type: "skill" as const, name: nativeName, path: skill.path } }
        : {}),
    };
  }

  return { text: message };
}

function matchesCodexCapabilityIdentity(
  item: SkillInfo,
  identity: ProviderCapabilityIdentity,
): boolean {
  if (identity.kind === "skill") {
    return item.kind === "skill"
      && (item.path ?? item.nativeName ?? item.name) === identity.nativeId;
  }
  if (identity.kind === "customPrompt") {
    return isCodexPromptCommand(item, item.name)
      && (item.nativeName ?? item.name) === identity.nativeId;
  }
  return item.kind === "command"
    && !isCodexPromptCommand(item, item.name)
    && (item.nativeName ?? item.name) === identity.nativeId;
}

/** Return the generated image path from an app-server imageGeneration item. */
export function generatedImagePathFromCodexItem(item: CompletedItem | undefined): string | null {
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
  event: AgentEvent;
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
  event: AgentEvent,
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

function childEventIdentity(event: AgentEvent): string | undefined {
  if (!("codexChild" in event) || !event.codexChild) return undefined;
  if (event.codexChild.nativeEventId) return event.codexChild.nativeEventId;
  return `codex-child:${createHash("sha256").update(JSON.stringify([
    event.type,
    event.codexChild.nativeThreadId,
    event.codexChild.nativeTurnId ?? "",
    event.codexChild.parentCollaborationItemId,
    event.codexChild.nativeItemId ?? "",
    event.codexChild.itemEventKey ?? "",
  ])).digest("hex")}`;
}

function rememberChildEventKey(state: CodexSessionState, eventKey: string): void {
  state.deliveredChildEventKeys.add(eventKey);
  while (state.deliveredChildEventKeys.size > MAX_CHILD_EVENT_DELIVERY_KEYS) {
    const oldest = state.deliveredChildEventKeys.values().next().value as string | undefined;
    if (!oldest) return;
    state.deliveredChildEventKeys.delete(oldest);
  }
}

/** Returns the child thread id when a native sub-agent activity starts. */
function nativeSubAgentThreadId(notification: { method?: string; params?: Record<string, unknown> }): string | undefined {
  if (notification.method !== "item/started" && notification.method !== "item/completed") return undefined;
  const item = notification.params?.item;
  if (!isRecord(item) || item.type !== "subAgentActivity" || item.kind !== "started") return undefined;
  const childThreadId = item.agentThreadId;
  return typeof childThreadId === "string" && childThreadId.length > 0 ? childThreadId : undefined;
}

/** Returns child thread ids exposed directly by a native collab spawn notification. */
function nativeCollabSpawnThreadIds(notification: { method?: string; params?: Record<string, unknown> }): string[] {
  if (notification.method !== "item/started" && notification.method !== "item/completed") return [];
  const item = notification.params?.item;
  if (!isRecord(item)) return [];
  const collabKind = item.tool ?? item.kind;
  if (item.type !== "collabAgentToolCall" || (collabKind !== "spawnAgent" && collabKind !== "spawn_agent")) {
    return [];
  }

  const childThreadIds = new Set<string>();
  if (Array.isArray(item.receiverThreadIds)) {
    for (const childThreadId of item.receiverThreadIds.slice(0, MAX_CHILD_THREADS_PER_NOTIFICATION)) {
      if (typeof childThreadId === "string" && childThreadId.length > 0) childThreadIds.add(childThreadId);
    }
  }
  if (isRecord(item.agentsStates)) {
    for (const childThreadId of Object.keys(item.agentsStates).slice(0, MAX_CHILD_THREADS_PER_NOTIFICATION)) {
      if (childThreadId.length > 0) childThreadIds.add(childThreadId);
    }
  }
  return [...childThreadIds].slice(0, MAX_CHILD_THREADS_PER_NOTIFICATION);
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
export class CodexProvider extends EventEmitter implements IAgentProvider, IGoalCapable, ISessionEvictable, ProtocolAdapter<CodexSessionState> {
  readonly id = "codex" as const;
  readonly descriptor = Object.freeze({
    id: "codex" as const,
    capabilities: CODEX_SUPPORTED_CAPABILITIES.map((name) => ({ name, support: "supported" as const })),
  });
  /** Codex CLI is an agentic tool with no one-shot text completion mode. */
  readonly supportsCompletion = false;
  readonly sessionForkOnResume = "clean" as const;
  readonly maxInputCharactersPerTurn = 16_000;
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
    { input: string | TurnInputPart[]; turnOptions: CodexTurnOptions; turnExecutionId: string }
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
      this.emit("event", {
        type: AgentEventType.QuotaUpdate,
        threadId,
        providerId: "codex",
        categories: this.usageInfo.quotaCategories,
      } satisfies AgentEvent);
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
  ): AgentEvent {
    this.emit("event", { type: AgentEventType.Error, threadId, error, ...(turnExecutionId ? { turnExecutionId } : {}) } satisfies AgentEvent);
    const ended = {
      type: AgentEventType.Ended,
      threadId,
      ...(outcome ? { outcome } : {}),
    } satisfies AgentEvent;
    if (emitEnded) this.emit("event", turnExecutionId ? { ...ended, turnExecutionId } : ended);
    return ended;
  }

  /** Reports a local internal MCP setup failure without changing turn lifecycle state. */
  private emitInternalMcpStartupFailure(
    threadId: string,
    serverThreadId: string,
    error: string,
    turnExecutionId?: string,
  ): void {
    this.emit("event", {
      type: AgentEventType.McpServerStartupStatus,
      threadId,
      providerId: this.id,
      serverThreadId,
      name: "mcode_internal_thread_control",
      status: "failed",
      error,
      ...(turnExecutionId ? { turnExecutionId } : {}),
    } satisfies AgentEvent);
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
    this.emit("event", {
      type: AgentEventType.GoalUpdated,
      threadId: goal.threadId ?? this.threadIdFromSession(sessionId),
      goal,
    } satisfies AgentEvent);
  }

  /** Emit a goal clear and update the local mirror. */
  private emitGoalCleared(
    sessionId: string,
    reason: "cleared" | "rollback" | "completed",
  ): void {
    this.goalsBySession.delete(sessionId);
    this.pendingGoalObjectives.delete(sessionId);
    this.emit("event", {
      type: AgentEventType.GoalCleared,
      threadId: this.threadIdFromSession(sessionId),
      providerId: "codex",
      reason,
    } satisfies AgentEvent);
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
    const settings = await this.codexPorts.settings.get();
    const cliPath = settings.cliPath;

    // `resumeFrom` defined ⇒ resume that Codex thread; undefined ⇒ fresh.
    if (req.resumeFrom !== undefined) {
      this.sdkSessionIds.set(req.sessionId, req.resumeFrom);
    }
    const {
      sessionId, message, cwd, model, permissionMode,
      reasoningLevel, attachments, mentions,
    } = req;
    const codexFastMode = req.providerOptions.fastMode;

    const nativeSkills = this.codexPorts.catalog.currentSkills(cwd);
    const slashInvocation = parseCodexSlashInvocation(message);
    const customPrompts = slashInvocation?.requestedName.startsWith("prompts:")
      ? (await this.codexPorts.catalog.refreshCustomPrompts()).prompts
      : this.codexPorts.catalog.currentPrompts();
    const skillCatalog = [...nativeSkills, ...customPrompts];
    const threadId = sessionId.startsWith("mcode-") ? sessionId.slice(6) : sessionId;
    let input: TurnInputPart[];
    try {
      input = await buildCodexInput(message, attachments, skillCatalog, mentions);
    } catch (err) {
      if (!(err instanceof CodexPromptResolutionError)) throw err;
      logger.debug("Codex prompt expansion failed", {
        promptName: err.promptName,
        cause: err.cause instanceof Error ? err.cause.message : String(err.cause),
      });
      this.emitTurnFailure(threadId, err.message, undefined, true, req.turnExecutionId);
      return;
    }

    const sandbox = permissionMode === "full" ? "danger-full-access" : "workspace-write";
    const browserPermissionCapability = providerBrowserPermissionCapability(
      permissionMode,
      req.interactionMode,
    );

    const useFastTier =
      codexFastMode !== undefined
        ? codexFastMode
        : settings.fastMode;
    // The app-server's model/list advertises the fast tier with id "priority"
    // (display name "Fast"). Sending "fast" is silently ignored upstream, so
    // fast mode had no effect. Only some models (e.g. gpt-5.4 / gpt-5.5)
    // expose the tier; the server falls back to standard for the rest.
    const fastServiceTier = useFastTier ? "priority" : undefined;

    const turnOptions = {
      model: model || undefined,
      effort: toCodexEffort(
        reasoningLevel,
        req.orchestrationMode === "proactive" && supportsCodexUltraOrchestration(model)
          ? "proactive"
          : "standard",
      ),
      ...(fastServiceTier && { serviceTier: fastServiceTier }),
    };

    // Permission-mode change requires a fresh thread, not just a respawn: the
    // resumed thread would inherit the old sandbox. Clearing the stored SDK
    // thread ID and draining the stale session is Codex-specific bookkeeping
    // the runtime cannot do, so handle it here before acquiring.
    let existing = this.runtime.get(sessionId);
    if (
      existing &&
      this.host.browser.isConfigured() &&
      (existing.workspaceId !== req.workspaceId ||
        existing.browserPermissionCapability !== browserPermissionCapability ||
        (existing.browserCredential && existing.browserCredential.expiresAt <= Date.now()))
    ) {
      await this.runtime.stop(sessionId);
      existing = undefined;
    }
    if (existing && existing.server.isAlive && existing.sandboxMode !== sandbox) {
      logger.info("Codex session restarted due to permission mode change", {
        sessionId,
        from: existing.sandboxMode,
        to: sandbox,
      });
      // Drain synchronously here (not only via close()) so approval cards
      // clear deterministically even if the version check below aborts before
      // `acquire` discards the stale session. The app-server's graceful exit
      // suppresses the "fatal" emit, so the fatal-drain listener will not fire.
      this.drainPending((e) => e.sessionId === sessionId);
      // Clear the stored SDK thread id so the respawn starts a fresh thread
      // rather than resuming the old one (which would inherit the old sandbox).
      this.sdkSessionIds.delete(sessionId);
      // Eagerly tear the stale session down so a later abort (e.g. a failed
      // version check below) cannot leave a wrong-sandbox process alive.
      // `acquire` then spawns fresh. Fire-and-forget: permissions are already
      // drained above, so the async close has nothing left to resolve.
      void this.runtime.stop(sessionId).catch((err: unknown) => {
        logger.warn("Codex session kill on permission change failed", { error: String(err) });
      });
    }

    // Version check only when starting a new session (cached in codex-version
    // per CLI path). Reusing a live, mode-matched session skips this. Emit
    // user-facing errors and abort before touching the runtime so a bad CLI
    // never spawns a child.
    const reusable = existing && existing.server.isAlive && existing.sandboxMode === sandbox;
    if (!reusable) {
      const preflight = this.checkCodexCliPreflight(cliPath);
      if (!preflight.ok) {
        const errorMessage = preflight.reason === "unavailable"
          ? preflight.error
          : `Codex CLI version ${preflight.version} is not supported. Minimum required: ${CODEX_MIN_VERSION}. Update with: npm install -g @openai/codex`;
        this.emitTurnFailure(threadId, errorMessage, undefined, true, req.turnExecutionId);
        return;
      }
    }

    // Stage the per-turn payload so `spawn` can run the first turn of a fresh
    // session; reuse reads it directly below. Keyed by sessionId.
    this.pendingSpawnTurns.set(sessionId, { input, turnOptions, turnExecutionId: req.turnExecutionId });
    const browserStage = this.host.browser.isConfigured()
      ? this.host.browser.stage({
      providerId: this.id,
      providerSessionId: req.resumeFrom ?? sessionId,
      mcodeSessionId: sessionId,
      threadId: req.threadId,
      workspaceId: req.workspaceId,
      permissionCapability: browserPermissionCapability,
      })
      : undefined;
    if (browserStage) {
      const previousBrowserAccess = this.pendingBrowserAccess.get(sessionId);
      if (previousBrowserAccess) {
        this.host.browser.release(previousBrowserAccess.stage.leaseId);
      }
      this.pendingBrowserAccess.set(sessionId, {
        stage: browserStage,
        workspaceId: req.workspaceId,
        permissionCapability: browserPermissionCapability,
      });
    }

    let state: CodexSessionState;
    try {
      state = await this.runtime.acquire({
        sessionId,
        threadId,
        cwd,
        permissionMode,
        resumeFrom:
          req.resumeFrom !== undefined ? this.sdkSessionIds.get(sessionId) : undefined,
      });
    } catch (e: unknown) {
      this.pendingSpawnTurns.delete(sessionId);
      const stagedBrowser = this.pendingBrowserAccess.get(sessionId);
      this.pendingBrowserAccess.delete(sessionId);
      if (stagedBrowser) this.host.browser.release(stagedBrowser.stage.leaseId);
      const errorMessage = e instanceof Error ? e.message : String(e);
      logger.error("CodexAppServer start failed", { sessionId, error: errorMessage });
      this.emitTurnFailure(threadId, errorMessage, undefined, true, req.turnExecutionId);
      return;
    }
    this.runtime.recordUsage(sessionId);
    const stagedBrowser = this.pendingBrowserAccess.get(sessionId);
    this.pendingBrowserAccess.delete(sessionId);
    if (state === existing && stagedBrowser) this.host.browser.release(stagedBrowser.stage.leaseId);

    // A stop requested before the session finished spawning: tear it down now.
    if (this.pendingStops.delete(sessionId)) {
      logger.info("Pending stop consumed, tearing down new Codex session", { sessionId });
      this.pendingSpawnTurns.delete(sessionId);
      void this.runtime.stop(sessionId);
      this.emit("event", { type: AgentEventType.Ended, threadId, turnExecutionId: req.turnExecutionId } satisfies AgentEvent);
      return;
    }

    // Reuse path: `spawn` did not run because the session already existed, so
    // the staged turn is still pending. Reset the mapper and run it here.
    if (reusable && this.pendingSpawnTurns.delete(sessionId)) {
      state.lastUsedAt = Date.now();
      void this.runTurnAfterGoal(sessionId, threadId, state.server, input, turnOptions, req.turnExecutionId);
      return;
    }
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
    const settings = await this.codexPorts.settings.get();
    const cliPath = settings.cliPath;
    const { sessionId, threadId, cwd, permissionMode, resumeFrom } = args;
    const stagedExecutionId = this.pendingSpawnTurns.get(sessionId)?.turnExecutionId;

    const sandbox = permissionMode === "full" ? "danger-full-access" : "workspace-write";
    const approvalPolicy = permissionMode === "full" ? "never" : "on-request";

    const attemptResume = !!resumeFrom;

    // Only register the handler in supervised mode. The CodexAppServer
    // ignores approvalHandler when approvalPolicy === "never" (auto-approve
    // still runs locally), so this guard is defensive and keeps the wiring
    // obvious in logs.
    const supervised = approvalPolicy === "on-request";
    const browserAccess = this.pendingBrowserAccess.get(sessionId);
    let internalMcp: { configOverrides: string[]; env: Record<string, string> } | undefined;
    let internalMcpSetupError: string | undefined;
    let internalMcpAuthorityClosed = false;
    const closeInternalMcpAuthority = async (): Promise<void> => {
      if (internalMcpAuthorityClosed) return;
      internalMcpAuthorityClosed = true;
      try {
        await this.host.threadControl.close(sessionId);
      } catch (error) {
        logger.warn("Codex internal MCP authority close failed", {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    try {
      internalMcp = await this.host.threadControl.bootstrap({
        providerId: this.id,
        sessionId,
        threadId,
        turnId: stagedExecutionId ?? threadId,
        protocol: "codex",
      }) as { configOverrides: string[]; env: Record<string, string> } | undefined;
    } catch (error) {
      internalMcpSetupError = error instanceof Error ? error.message : String(error);
      await closeInternalMcpAuthority();
    }
    const browserGrant = browserAccess ? this.host.browser.issue(browserAccess.stage) : null;
    const mcodeInstructions = renderMcodeInstructions(buildMcodeInstructionPlan({
      sourceThreadId: threadId,
      threadControlGranted: Boolean(internalMcp),
      browserAutomationGranted: Boolean(browserGrant),
    }));
    const spawnEnv = { ...args.env };
    const browserTokenEnvName = "MCODE_BROWSER_MCP_TOKEN";
    if (browserGrant) spawnEnv[browserTokenEnvName] = browserGrant.token;

    const server = new CodexAppServer({
      cliPath,
      workingDirectory: cwd,
      // The model passed at thread/start is carried on the turn payload too;
      // settings drive it indirectly via the staged turnOptions.
      model: undefined,
      sandbox,
      approvalPolicy,
      resumeThreadId: attemptResume ? resumeFrom : undefined,
      developerInstructions: mcodeInstructions,
      approvalHandler: supervised
        ? (req) => this.handleApprovalRequest(sessionId, threadId, req)
        : undefined,
      processAttachment: this.host.processes,
      getSpawnEnv: () => ({ ...spawnEnv, ...internalMcp?.env }),
      configOverrides: [
        ...(internalMcp?.configOverrides ?? []),
        ...(browserGrant
          ? [
              `mcp_servers.mcode-browser.url=${JSON.stringify(browserGrant.mcpUrl)}`,
              `mcp_servers.mcode-browser.bearer_token_env_var=${JSON.stringify(browserTokenEnvName)}`,
            ]
          : []),
        ...(browserGrant ? ['plugins."browser@openai-bundled".enabled=false'] : []),
      ],
    });

    const mapper = new CodexEventMapper(threadId, undefined, (event) => {
      this.emit("file_mutation_start", event);
    });
    mapper.setOutputTruncationMode(this.outputTruncationMode);

    server.on("notification", (notification) => {
      const n = notification as { method?: string; params?: Record<string, unknown> };
      if (n.method === "account/rateLimits/updated") {
        this.applyUsageSnapshot(n.params, threadId);
      }
      if (n.method === "account/updated") {
        this.clearUsageCache();
        this.refreshUsageFromServer(server, threadId);
      }
      const entry = this.runtime.get(sessionId);
      const mainNotification = isMainThreadNotification(server, n.params);
      const nativeThreadId = nativeThreadIdFromParams(n.params);
      const nativeTurnId = nativeTurnIdFromParams(n.params);
      let childThreadToReplay: string | undefined;
      if (entry && n.method === "turn/started") {
        const executionId = entry.nextTurnExecutionId ?? entry.currentTurnExecutionId ?? entry.activeParentTurnExecutionId;
        if (mainNotification) {
          if (executionId) entry.activeParentTurnExecutionId = executionId;
          if (nativeTurnId && executionId && entry.currentTurnExecutionId === executionId) {
            if (entry.turnStartResponsePending) {
              entry.pendingTurnStartNotification = { nativeTurnId, executionId };
            } else if (entry.currentNativeTurnId === nativeTurnId) {
              entry.pendingTurnId = nativeTurnId;
              entry.turnBindingPhase = "bound";
            } else if (entry.turnExecutionIdsByNativeTurn.get(nativeTurnId) === executionId) {
              entry.currentNativeTurnId = nativeTurnId;
              entry.pendingTurnId = nativeTurnId;
              entry.turnBindingPhase = "bound";
            } else if (entry.turnExecutionIdsByNativeTurn.has(nativeTurnId)) {
              assignNativeExecution(
                entry.turnExecutionIdsByNativeTurn,
                nativeTurnId,
                executionId,
                entry.nativeExecutionConflictKeys,
              );
            }
          }
          entry.nextTurnExecutionId = undefined;
          entry.childMetadataFetches.clear();
        } else if (entry.activeParentTurnExecutionId) {
          const childExecutionId = nativeThreadId
            ? entry.childExecutionGenerations.get(nativeThreadId)?.executionId
            : undefined;
          if (nativeTurnId && childExecutionId) {
            const assignment = assignNativeExecution(
              entry.turnExecutionIdsByNativeTurn,
              nativeTurnId,
              childExecutionId,
              entry.nativeExecutionConflictKeys,
            );
            if (assignment !== "conflict" && nativeThreadId) {
              childThreadToReplay = nativeThreadId;
            }
          }
          pruneExecutionMap(entry.nativeThreadExecutionIds);
          pruneExecutionMap(entry.turnExecutionIdsByNativeTurn);
        }
      }
      const generatedImageEvents = this.mapGeneratedImageEvents(threadId, notification as CodexNotification);
      const events = mapper.mapNotification(notification as CodexNotification);
      traceCodexIngest(threadId, n.method, n.params, [...generatedImageEvents, ...events]);
      if (
        entry
        && nativeThreadId
        && !mainNotification
        && mapper.hasReceiverThread(nativeThreadId)
        && entry.activeParentTurnExecutionId
      ) {
        entry.nativeThreadExecutionIds.set(nativeThreadId, entry.activeParentTurnExecutionId);
        if (nativeTurnId && n.method === "turn/started") {
          entry.turnExecutionIdsByNativeTurn.set(nativeTurnId, entry.activeParentTurnExecutionId);
        }
      }
      const eventExecutionId = entry
        ? (nativeTurnId && entry.turnExecutionIdsByNativeTurn.get(nativeTurnId))
          ?? (!nativeTurnId && !mainNotification
            ? (nativeThreadId ? entry.nativeThreadExecutionIds.get(nativeThreadId) : undefined)
            : undefined)
          ?? (mainNotification && entry.currentTurnExecutionId && entry.turnBindingPhase !== "idle" && (
            !nativeTurnId
            || entry.turnStartResponsePending
            || nativeTurnId === entry.currentNativeTurnId
          )
            ? entry.currentTurnExecutionId
            : undefined)
        : undefined;
      const startupEventExecutionId = n.method === "mcpServer/startupStatus/updated"
        ? stagedExecutionId
        : undefined;
      const mappedEvents = [...generatedImageEvents, ...events];
      for (const event of mappedEvents) {
        const eventKey = childEventIdentity(event);
        if (eventKey && entry?.deliveredChildEventKeys.has(eventKey)) continue;
        if (eventKey && entry?.pendingChildEvents.some((pendingEvent) => pendingEvent.eventKey === eventKey)) continue;
        const childEventNeedsTurnBinding = Boolean(
          entry
          && !mainNotification
          && nativeThreadId
          && mapper.hasReceiverThread(nativeThreadId)
          && !nativeTurnId
          && "codexChild" in event
          && event.codexChild,
        );
        if (
          !childEventNeedsTurnBinding
          && (!entry || eventExecutionId || !isTurnScopedEvent(event) || mainNotification || !nativeThreadId)
        ) {
          if (eventKey && entry) rememberChildEventKey(entry, eventKey);
          this.recordGoalEvent(sessionId, event);
          const resolvedEventExecutionId = eventExecutionId ?? startupEventExecutionId;
          this.emit("event", { ...event, ...(resolvedEventExecutionId ? { turnExecutionId: resolvedEventExecutionId } : {}) });
        } else {
          if (!entry || !nativeThreadId) continue;
          bufferPendingChildEvent(entry, event, nativeThreadId, nativeTurnId, eventKey);
        }
      }
      if (entry && childThreadToReplay) {
        this.replayPendingChildEvents(entry, sessionId, childThreadToReplay);
      }
      const childThreadId = nativeSubAgentThreadId(n);
      if (childThreadId) {
        const currentExecutionId = entry?.currentTurnExecutionId;
        const knownMainThreadNotification = Boolean(
          entry
          && server.threadId
          && nativeThreadId === server.threadId,
        );
        const currentParentNotification = Boolean(
          entry
          && currentExecutionId
          && eventExecutionId === currentExecutionId
          && (
            knownMainThreadNotification
            || (nativeThreadId && entry.nativeThreadExecutionIds.get(nativeThreadId) === currentExecutionId)
          ),
        );
        if (currentParentNotification && currentExecutionId) {
          entry.nextChildGeneration += 1;
          entry.childExecutionGenerations.set(childThreadId, {
            executionId: currentExecutionId,
            generation: entry.nextChildGeneration,
          });
          pruneChildGenerationMap(entry.childExecutionGenerations);
          entry.nativeThreadExecutionIds.set(childThreadId, currentExecutionId);
          pruneExecutionMap(entry.nativeThreadExecutionIds);
          this.replayPendingChildEvents(entry, sessionId, childThreadId);
        }
        this.fetchChildThreadMetadata(sessionId, threadId, server, mapper, childThreadId, eventExecutionId);
      }
      for (const collabChildThreadId of nativeCollabSpawnThreadIds(n)) {
        this.fetchChildThreadMetadata(sessionId, threadId, server, mapper, collabChildThreadId, eventExecutionId);
      }
    });

    server.on("fatal", (error: string) => {
      logger.error("CodexAppServer fatal", { sessionId, error, breadcrumb: server.lastTransportBreadcrumb });
      const activeExecutionId = this.runtime.get(sessionId)?.activeParentTurnExecutionId ?? stagedExecutionId;
      for (const event of mapper.drainPendingAssistantBoundary(false)) {
        this.emit("event", activeExecutionId ? { ...event, turnExecutionId: activeExecutionId } : event);
      }
      this.emitTurnFailure(threadId, error, undefined, true, activeExecutionId);
      void this.runtime.stop(sessionId);
    });

    this.attachFatalDrain(sessionId, server);
    const internalMcpStartup = internalMcp ? observeCodexInternalMcpStartup(server) : undefined;

    server.on("exit", () => {
      if (!server.isAlive) {
        void this.runtime.stop(sessionId);
      }
    });

    let internalMcpStartupOutcome: CodexInternalMcpStartupOutcome | undefined;

    // Only app-server startup failures reject acquisition. Internal MCP
    // failures resolve as degraded capability so the turn can continue.
    try {
      if (internalMcpStartup) {
        const [, startupOutcome] = await Promise.all([server.start(), internalMcpStartup.promise]);
        internalMcpStartupOutcome = startupOutcome;
      } else {
        await server.start();
      }
    } catch (error) {
      if (browserGrant) this.host.browser.release(browserGrant.leaseId);
      internalMcpStartup?.cancel();
      await closeInternalMcpAuthority();
      if (internalMcpStartup) await server.kill().catch(() => undefined);
      throw error;
    } finally {
      delete spawnEnv[browserTokenEnvName];
      this.pendingBrowserAccess.delete(sessionId);
    }
    if (internalMcpSetupError) {
      this.emitInternalMcpStartupFailure(threadId, server.threadId ?? threadId, internalMcpSetupError, stagedExecutionId);
    } else if (internalMcpStartupOutcome?.status === "timeout") {
      this.emitInternalMcpStartupFailure(
        threadId,
        server.threadId ?? threadId,
        internalMcpStartupOutcome.error,
        stagedExecutionId,
      );
    }
    if (internalMcp) {
      if (internalMcpStartupOutcome?.status === "ready") {
        try {
          const effectiveConfig = await server.readConfig(cwd);
          if (!hasCodexInternalThreadControlMcp(effectiveConfig)) {
            throw new Error("Codex app-server did not register mcode_internal_thread_control in effective configuration");
          }
        } catch (error) {
          internalMcpStartup?.cancel();
          await closeInternalMcpAuthority();
          this.emitInternalMcpStartupFailure(
            threadId,
            server.threadId ?? threadId,
            error instanceof Error ? error.message : String(error),
            stagedExecutionId,
          );
        }
      }
    }
    this.refreshUsageFromServer(server, threadId);

    // Register after a successful handshake so a mid-handshake thread/started
    // notification cannot persist a stale SDK thread id when init later fails.
    server.on("threadIdChanged", (newThreadId: string) => {
      mapper.setMainCodexThreadId(newThreadId);
      this.sdkSessionIds.set(sessionId, newThreadId);
      this.emit("event", {
        type: AgentEventType.System,
        threadId,
        subtype: "sdk_session_id:" + newThreadId,
      } satisfies AgentEvent);
    });

    if (server.resumeFailed) {
      logger.warn("Codex session context lost; resume failed, started fresh thread", { sessionId });
      this.emit("event", {
        type: AgentEventType.System,
        threadId,
        subtype: "context_lost",
      } satisfies AgentEvent);
    }

    if (server.threadId) {
      mapper.setMainCodexThreadId(server.threadId);
      this.sdkSessionIds.set(sessionId, server.threadId);
      this.emit("event", {
        type: AgentEventType.System,
        threadId,
        subtype: "sdk_session_id:" + server.threadId,
      } satisfies AgentEvent);
    }

    const state: CodexSessionState = {
      sessionId,
      threadId,
      cwd,
      server,
      mapper,
      lastUsedAt: Date.now(),
      sandboxMode: sandbox,
      runTurnSeq: 0,
      pendingTurnId: null,
      turnBindingPhase: "idle",
      turnStartResponsePending: false,
      turnExecutionIdsByNativeTurn: new Map(),
      nativeThreadExecutionIds: new Map(),
      nativeExecutionConflictKeys: new Set(),
      childExecutionGenerations: new Map(),
      nextChildGeneration: 0,
      pendingChildEvents: [],
      deliveredChildEventKeys: new Set(),
      workspaceId: browserAccess?.workspaceId ?? "unknown-workspace",
      browserPermissionCapability: browserAccess?.permissionCapability ?? "interact",
      ...(browserGrant && {
        browserCredential: {
          credentialId: browserGrant.credentialId,
          expiresAt: browserGrant.expiresAt,
        },
        browserLeaseId: browserGrant.leaseId,
      }),
      childMetadataFetches: new Set(),
    };
    this.liveSessionIds.add(sessionId);

    // Run the first turn for the staged payload. `sendTurn` consults
    // `pendingStops` after `acquire` returns; only fire the turn if no stop
    // raced in. The runtime stores the state before this resolves, so
    // `runTurn`'s `this.runtime.get(sessionId)` sees it.
    const staged = this.pendingSpawnTurns.get(sessionId);
    if (staged && !this.pendingStops.has(sessionId)) {
      const { input, turnOptions, turnExecutionId } = staged;
      this.pendingSpawnTurns.delete(sessionId);
      // SessionRuntime inserts `state` into the pool only after `spawn` resolves.
      // queueMicrotask runs before that continuation, so a pool identity check drops
      // the first turn on every new session (UI: Thinking forever, turn/start never sent).
      setImmediate(() => {
        if (!this.runtime.get(sessionId)) return;
        void this.runTurnAfterGoal(sessionId, threadId, server, input, turnOptions, turnExecutionId);
      });
    }

    return { state, pids: [] };
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

    const pending = state.pendingChildEvents;
    if (pending.length === 0) return;
    const remaining: PendingChildEvent[] = [];
    for (const item of pending) {
      if (item.nativeThreadId !== childThreadId) {
        remaining.push(item);
        continue;
      }
      if (item.childGeneration !== undefined && item.childGeneration !== childMapping.generation) {
        continue;
      }
      if (item.executionIdAtBuffer && item.childGeneration === undefined && item.executionIdAtBuffer !== executionId) {
        continue;
      }
      if (item.eventKey && state.deliveredChildEventKeys.has(item.eventKey)) continue;
      if (item.eventKey) rememberChildEventKey(state, item.eventKey);
      this.recordGoalEvent(sessionId, item.event);
      this.emit("event", { ...item.event, turnExecutionId: executionId });
    }
    state.pendingChildEvents = remaining;
  }

  /** Fetches one native child thread's authoritative identity and model settings without affecting the parent turn. */
  private fetchChildThreadMetadata(
    sessionId: string,
    threadId: string,
    server: CodexAppServer,
    mapper: CodexEventMapper,
    childThreadId: string,
    turnExecutionId?: string,
  ): void {
    const state = this.runtime.get(sessionId);
    if (!state || state.mapper !== mapper || state.childMetadataFetches.has(childThreadId)) return;
    state.childMetadataFetches.add(childThreadId);
    const runTurnSeq = state.runTurnSeq;

    void (async () => {
      const retryDelaysMs = [0, 100, 300, 1_000] as const;
      let appliedInitialMetadata = false;
      for (const retryDelayMs of retryDelaysMs) {
        if (retryDelayMs > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
        }

        const activeState = this.runtime.get(sessionId);
        if (!activeState || activeState.mapper !== mapper || activeState.runTurnSeq !== runTurnSeq) return;
        let metadata: Awaited<ReturnType<CodexAppServer["getChildThreadMetadata"]>>;
        try {
          metadata = await server.getChildThreadMetadata(childThreadId);
        } catch {
          continue;
        }
        const currentState = this.runtime.get(sessionId);
        if (!currentState || currentState.mapper !== mapper || currentState.runTurnSeq !== runTurnSeq) return;
        if (!metadata) continue;

        const metadataUpdate = appliedInitialMetadata
          ? metadata.identity ? { identity: metadata.identity } : undefined
          : metadata;
        appliedInitialMetadata = true;
        const events = metadataUpdate
          ? mapper.applyChildThreadMetadata(childThreadId, metadataUpdate)
          : [];
        traceCodexIngest(threadId, "child/thread-read", { childThreadId }, events);
        const resolvedExecutionId = turnExecutionId
          ?? currentState.nativeThreadExecutionIds.get(childThreadId);
        for (const event of events) {
          this.recordGoalEvent(sessionId, event);
          this.emit("event", resolvedExecutionId ? { ...event, turnExecutionId: resolvedExecutionId } : event);
        }
        if (metadata.identity) return;
      }
    })()
      .catch((error: unknown) => {
        logger.debug("Codex child metadata lookup failed", {
          sessionId,
          childThreadId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  /** Eviction guard: a turn is in flight while sendTurn is awaiting completion. */
  isBusy(state: CodexSessionState): boolean {
    return state.pendingTurnId != null || state.abortPendingTurnWait !== undefined;
  }

  /** Graceful protocol interrupt of the in-flight turn (does not kill the process). */
  async interrupt(state: CodexSessionState): Promise<void> {
    const turnExecutionId = executionForDrain(state);
    for (const event of state.mapper.drainPendingAssistantBoundary(false)) {
      this.emit("event", turnExecutionId ? { ...event, turnExecutionId } : event);
    }
    state.pendingTurnStartNotification = undefined;
    state.turnStartResponsePending = false;
    state.turnBindingPhase = "idle";
    state.currentNativeTurnId = undefined;
    state.pendingTurnId = null;
    state.childExecutionGenerations.clear();
    state.nativeThreadExecutionIds.clear();
    state.pendingChildEvents = [];
    await state.server.interruptTurn();
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
      this.emit("event", turnExecutionId ? { ...event, turnExecutionId } : event);
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
    let deltaText = "";
    let completedText = "";
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
          const n = notification as CodexNotification;
          if (n.method === "item/agentMessage/delta") {
            deltaText += n.params.delta ?? "";
            return;
          }
          if (n.method === "item/completed") {
            const text = completedAssistantText(n.params.item);
            if (text) completedText = text;
            return;
          }
          if (n.method === "turn/completed") {
            const turn = n.params.turn;
            if (turn?.status === "failed") {
              rejectTransient(turn.error?.message ?? "Codex side-channel query failed");
              return;
            }
            const text = (completedText || deltaText).trim();
            if (!text) {
              rejectTransient("Codex side-channel query returned empty output");
              return;
            }
            finish(text);
          }
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
    const entry = this.runtime.get(sessionId);
    if (!entry) return;
    const emitTurnEvent = (event: AgentEvent): void => { this.emit("event", { ...event, turnExecutionId }); };

    for (const event of entry.mapper.drainPendingAssistantBoundary(false)) {
      emitTurnEvent(event);
    }
    entry.mapper.prepareForTurn();

    // Only pay the turn/interrupt round-trip when a previous turn is actually
    // in flight. Interrupting an idle session added a needless RPC (up to its
    // 5s timeout) of latency to every message.
    const hadInflightTurn =
      entry.pendingTurnId !== null || entry.abortPendingTurnWait !== undefined;
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
    const seq = entry.runTurnSeq;
    entry.pendingTurnId = null;

    if (hadInflightTurn) {
      await server.interruptTurn();
    }

    let serverDied = false;
    let endedEmitted = false;
    let endedOutcome: CodexEndedOutcome | undefined;
    let deferredEnded: AgentEvent | undefined;
    let earlyCompletionTurnId: string | undefined;

    try {
      await new Promise<void>((resolve, reject) => {
        let activityTimer: ReturnType<typeof setTimeout>;
        let settled = false;

        const cleanup = () => {
          if (settled) return;
          settled = true;
          clearTimeout(activityTimer);
          server.removeListener("notification", onNotification);
          server.removeListener("activity", onActivity);
          server.removeListener("fatal", onFatal);
          if (entry.abortPendingTurnWait === abortThis) entry.abortPendingTurnWait = undefined;
        };

        const armTimer = () => {
          clearTimeout(activityTimer);
          activityTimer = setTimeout(() => {
            // Silence while an approval card waits on the user is the user's
            // silence, not the server's: keep the turn alive until they decide.
            if (this.hasPendingApprovalFor(sessionId)) {
              armTimer();
              return;
            }
            // Probe before giving up: a turn is only abandoned when the
            // app-server stops answering RPCs, never just for being slow.
            // A healthy-but-silent turn (long tool, deep reasoning) re-arms
            // and can run indefinitely.
            void server.ping().then((alive) => {
              if (settled) return;
              if (alive) {
                logger.debug("Codex turn silent but server responsive; watchdog re-armed", {
                  sessionId,
                  silenceMs: TURN_TIMEOUT_MS,
                });
                armTimer();
                return;
              }
              cleanup();
              reject(new CodexTurnIdleTimeoutError());
            });
          }, TURN_TIMEOUT_MS);
        };

        // Server-initiated approval requests count as liveness too.
        const onActivity = () => armTimer();

        const abortThis = () => {
          cleanup();
          reject(new CodexTurnSupersededError());
        };
        entry.abortPendingTurnWait = abortThis;

        const onNotification = (notification: unknown) => {
          armTimer();
          const n = notification as { method?: string; params?: Record<string, unknown> };
          if (n.method === "turn/completed") {
            const tid = nativeTurnIdFromParams(n.params);
            const currentNativeTurnId = entry.currentNativeTurnId;
            const pendingNativeTurnId = entry.pendingTurnStartNotification?.nativeTurnId;
            const nativeTurnBelongsToCurrentExecution = Boolean(
              tid
              && (
                tid === currentNativeTurnId
                || tid === pendingNativeTurnId
                || entry.turnExecutionIdsByNativeTurn.get(tid) === turnExecutionId
              ),
            );
            // Sub-agent receiver threads complete their own turns mid-run;
            // only the main thread's completion settles this wait. Native turn
            // identity is authoritative when a child thread/started notification
            // has temporarily changed the app-server's mutable thread id.
            if (!nativeTurnBelongsToCurrentExecution && !isMainThreadNotification(server, n.params)) return;
            const turn = n.params?.turn as { id?: string; status?: string } | undefined;
            endedOutcome =
              turn?.status === "failed"
                ? "errored"
                : turn?.status === "interrupted"
                  ? "cancelled"
                  : "completed";
            const currentExecutionId = entry.currentTurnExecutionId;
            const provenCurrentTurn = Boolean(
              currentExecutionId === turnExecutionId
              && currentNativeTurnId
              && tid
              && tid === currentNativeTurnId,
            );
            const completionBeforeBinding = Boolean(
              entry.turnStartResponsePending
              && currentExecutionId === turnExecutionId
              && tid
              && (!entry.pendingTurnStartNotification
                || entry.pendingTurnStartNotification.nativeTurnId === tid),
            );
            if (completionBeforeBinding) {
              earlyCompletionTurnId = tid;
              return;
            }
            if (!provenCurrentTurn) {
              logger.debug("Codex turn/completed ignored (stale or unmatched)", {
                tid,
                pending: entry.pendingTurnId,
                currentNativeTurnId,
                currentExecutionId,
                seq,
                liveSeq: entry.runTurnSeq,
              });
              return;
            }
            if (seq !== entry.runTurnSeq) return;
            cleanup();
            resolve();
          }
        };

        const onFatal = () => {
          cleanup();
          serverDied = true;
          reject(new Error("Codex app-server died during turn"));
        };

        armTimer();
        server.on("notification", onNotification);
        server.on("activity", onActivity);
        server.once("fatal", onFatal);

        void (async () => {
          try {
            const turnId = await server.sendTurn(input, turnOptions);
            if (seq !== entry.runTurnSeq) return;
            entry.turnStartResponsePending = false;
            entry.pendingTurnStartNotification = undefined;
            if (!turnId) {
              entry.turnBindingPhase = "idle";
              throw new Error("Codex turn/start response missing turn id");
            }
            const assignment = assignNativeExecution(
              entry.turnExecutionIdsByNativeTurn,
              turnId,
              turnExecutionId,
              entry.nativeExecutionConflictKeys,
            );
            if (assignment === "conflict") {
              throw new Error("Codex turn/start response reused native turn id");
            }
            entry.currentNativeTurnId = turnId;
            entry.pendingTurnId = turnId;
            entry.turnBindingPhase = "bound";
            pruneExecutionMap(entry.turnExecutionIdsByNativeTurn);
            if (earlyCompletionTurnId === turnId) {
              cleanup();
              resolve();
            }
          } catch (err) {
            cleanup();
            reject(err);
          }
        })();
      });
    } catch (e: unknown) {
      if (e instanceof CodexTurnSupersededError) return;
      if (e instanceof CodexTurnIdleTimeoutError) {
        endedOutcome = "errored";
        logger.warn("Codex turn idle timeout (suppressed from UI)", {
          sessionId,
          timeoutMs: TURN_TIMEOUT_MS,
        });
        for (const event of entry.mapper.drainPendingAssistantBoundary(false)) {
          emitTurnEvent(event);
        }
        // Interrupt the upstream turn so the app-server state matches the UI
        // ("ended") instead of silently chewing in the background.
        entry.pendingTurnStartNotification = undefined;
        entry.turnStartResponsePending = false;
        entry.turnBindingPhase = "idle";
        entry.currentNativeTurnId = undefined;
        entry.pendingTurnId = null;
        entry.childExecutionGenerations.clear();
        entry.nativeThreadExecutionIds.clear();
        entry.pendingChildEvents = [];
        void server.interruptTurn();
        return;
      }
      if (!serverDied && seq === entry.runTurnSeq) {
        endedOutcome = "errored";
        const errorMessage = e instanceof Error ? e.message : String(e);
        logger.error("Codex turn failed", { sessionId, error: errorMessage });
        for (const event of entry.mapper.drainPendingAssistantBoundary(false)) {
          emitTurnEvent(event);
        }
        deferredEnded = this.emitTurnFailure(threadId, errorMessage, endedOutcome, false, turnExecutionId);
      }
    } finally {
      if (seq === entry.runTurnSeq) {
        // The turn for this seq has settled: clear the in-flight marker so the
        // runtime's busy guard (`isBusy` reads `pendingTurnId`) stops sparing
        // the session from idle eviction. A superseding turn owns its own id.
        entry.pendingTurnId = null;
        entry.turnBindingPhase = "idle";
        entry.turnStartResponsePending = false;
        entry.pendingTurnStartNotification = undefined;
        entry.pendingChildEvents = [];
      }
      if (!serverDied && seq === entry.runTurnSeq && !endedEmitted) {
        endedEmitted = true;
        emitTurnEvent(deferredEnded ?? {
          type: AgentEventType.Ended,
          threadId,
          ...(endedOutcome ? { outcome: endedOutcome } : {}),
        } satisfies AgentEvent);
      }
    }
  }

  /** Persist Codex-generated image output files before the turn finalizes. */
  private mapGeneratedImageEvents(threadId: string, notification: CodexNotification): AgentEvent[] {
    if (notification.method !== "item/completed") return [];
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
    const requestId = randomUUID();
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
    for (const [requestId, entry] of [...this.pendingPermissions]) {
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
