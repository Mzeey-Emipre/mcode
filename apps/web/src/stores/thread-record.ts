import type { Message, ToolCall, HookExecution, PermissionMode, InteractionMode } from "@/transport";
import type { ToolCallRecord, ThoughtSegmentRecord, HookExecutionRecord } from "@/transport";
import type {
  ContextWindowMode,
  ReasoningLevel,
  OrchestrationMode,
  PlanQuestion,
  PlanAnswer,
  ProviderUsageInfo,
  GoalState,
  TurnFileEffectSummary,
  TurnRuntimePhase,
  TurnSavingStatus,
} from "@mcode/contracts";
import type { PermissionRequest, PermissionDecision } from "@mcode/contracts";
import { PERMISSION_MODES, INTERACTION_MODES } from "@mcode/contracts";
import type { ThoughtSegment } from "@/features/conversation/narrative/types";
import {
  createCanonicalAgentReplica,
  type CanonicalAgentReplica,
} from "./canonical-agent-replica";
/**
 * Ephemeral metadata for a handoff artifact received via the `thread.handoff` push channel.
 * Mirrors the server-side `HandoffMeta` fields that the UI needs, plus the pipeline status.
 */
export interface HandoffMeta {
  status: "generating" | "ready" | "fallback" | "error";
  ladderStep?: "B" | "D";
  providerErrorOnGenerate?: "quota" | "auth" | "context-overflow" | "transient" | "fatal" | null;
}

/** Per-thread configuration for permission scope, interaction mode, and optional reasoning level. */
export interface ThreadSettings {
  permissionMode: PermissionMode;
  interactionMode: InteractionMode;
  reasoningLevel?: ReasoningLevel;
  orchestrationMode?: OrchestrationMode;
  copilotAgent?: string | null;
  contextWindow?: ContextWindowMode | null;
  thinking?: boolean | null;
  codexFastMode?: boolean | null;
  /** Thread-scoped default open-in app id (ADR-0005 tier 1). Null clears the override. */
  defaultOpenInApp?: string | null;
}

/** A permission request with its current resolution state. */
export interface StoredPermission extends PermissionRequest {
  settled: boolean;
  decision?: PermissionDecision;
}

/** Per-thread token/usage snapshot for one provider (keys are providerId). */
export type ThreadUsageByProvider = Record<string, ProviderUsageInfo>;

/** Narrative cache for loaded messages on this thread. Keys are messageId. */
export type ThreadNarrativeByMessage = Record<
  string,
  {
    tools: ToolCallRecord[];
    thoughts: ThoughtSegmentRecord[];
    hooks: HookExecutionRecord[];
  } | undefined
>;

/** Context window usage snapshot for one thread. */
export interface ThreadContextUsage {
  lastTokensIn: number;
  contextWindow?: number;
  totalProcessedTokens?: number;
  tokensOut?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costMultiplier?: number;
}

/** Fork-mode state preserved across thread navigation. */
export interface ThreadForkMode {
  messageId: string;
  content: string | null;
  role: "user" | "assistant";
}

/** A provider notice collection is scoped to an id or an explicit unscoped boundary. */
export type ProviderNoticeSessionId = string | null;

/** Returns the session identity represented by a provider notice collection. */
export function providerNoticeSessionId(
  notices: readonly Message[],
): ProviderNoticeSessionId | undefined {
  const metadata = notices.at(-1)?.systemNotice;
  return metadata ? metadata.sessionId ?? null : undefined;
}

/**
 * Canonical in-memory state for one thread.
 * Collapses the former ~30 parallel `Record<string, X>` maps and active-thread mirror fields.
 */
export interface ThreadRecord {
  /** Canonical durable state installed through the reconnect revision protocol. */
  canonicalAgent: CanonicalAgentReplica;
  /** Mcode-owned identity for the current logical turn. */
  turnExecutionId: string | null;
  /** Authoritative lifecycle phase restored from server runtime snapshots. */
  runtimePhase: TurnRuntimePhase;
  /** Active assistant-text durability status. This is transient and server-authoritative. */
  savingStatus: TurnSavingStatus | null;
  messages: Message[];
  sessionNotices: Message[];
  /** Provider notice collection owner. Null means an explicit unscoped provider session. */
  noticeSessionId?: ProviderNoticeSessionId;
  loading: boolean;
  oldestLoadedSequence: number;
  newestLoadedSequence: number;
  hasMoreMessages: boolean;
  hasNewerMessages: boolean;
  isLoadingMore: boolean;
  isLoadingNewer: boolean;
  loadEpoch: number;
  /** Monotonic identity for renderer-owned conversation content. */
  conversationRevision: number;
  persistedToolCallCounts: Record<string, number>;
  persistedFilesChanged: Record<string, string[]>;
  latestTurnWithChanges: string | null;
  /** Live or just-finalized agent-attributed file-effect aggregate for the current turn. */
  fileEffectSummary: TurnFileEffectSummary;
  /** Server tracker generation that owns the live file-effect aggregate. */
  fileEffectTurnId: string;
  serverMessageIds: Record<string, string>;
  narrativeByMessage: ThreadNarrativeByMessage;
  answeredPlanMessageIds: Set<string>;
  /** Highest positive server-assigned agent-event sequence observed for this thread. */
  lastAgentEventSequence?: number;
  /** Server-process epoch paired with {@link lastAgentEventSequence}. */
  lastAgentEventEpoch?: string;

  error: string | null;
  streaming: string;
  streamingPreview: string;
  toolCalls: ToolCall[];
  agentStartTime?: number;
  currentTurnMessageId: string;
  /** Ordered local response rows awaiting their `turn.persisted` signals. */
  pendingTurnPersistMessageIds: string[];
  currentTurnResponseKey: string;
  assistantResponseKeys: Record<string, string>;
  thoughtSegments: ThoughtSegment[];
  hooks: HookExecution[];
  isCompacting: boolean;

  settings: ThreadSettings;
  context?: ThreadContextUsage;
  usageByProvider: ThreadUsageByProvider;
  goal?: GoalState | null;

  lastFallback?: { requestedModel: string; actualModel: string };
  rateLimit?: { retryAfterMs?: number; limitType?: string; utilization?: number };
  apiRetry?: { reason: string; attempt?: number; maxRetries?: number; delayMs?: number };
  awaitingUserStopPersist?: true;
  interruptStopFileNotice?: { paths: string[] };
  composerRecallFromStop?: { text: string };
  lastHydratedAt?: number;

  planQuestions: PlanQuestion[] | null;
  planAnswers: Map<string, PlanAnswer>;
  activeQuestionIndex: number;
  planQuestionsStatus: "idle" | "pending" | "answered";

  permissions: StoredPermission[];
  handoffMeta?: HandoffMeta;
  forkMode: ThreadForkMode | null;
}

const DEFAULT_THREAD_SETTINGS: ThreadSettings = {
  permissionMode: PERMISSION_MODES.FULL,
  interactionMode: INTERACTION_MODES.BUILD,
};
const EMPTY_PENDING_TURN_PERSIST_MESSAGE_IDS: string[] = [];
const EMPTY_NARRATIVE_BY_MESSAGE: ThreadNarrativeByMessage = {};
/** Fields whose mutation advances the renderer-owned conversation revision. */
export const CONVERSATION_REVISION_FIELD_KEYS = [
  "messages",
  "persistedToolCallCounts",
  "persistedFilesChanged",
  "latestTurnWithChanges",
  "serverMessageIds",
  "narrativeByMessage",
  "answeredPlanMessageIds",
  "streaming",
  "streamingPreview",
  "toolCalls",
  "thoughtSegments",
  "hooks",
  "currentTurnMessageId",
  "pendingTurnPersistMessageIds",
  "currentTurnResponseKey",
  "assistantResponseKeys",
] as const satisfies readonly (keyof ThreadRecord)[];

const CONVERSATION_REVISION_FIELDS = new Set<keyof ThreadRecord>(
  CONVERSATION_REVISION_FIELD_KEYS,
);

/** Returns a fresh empty {@link ThreadRecord} for lazy Map insertion. */
export function createEmptyThreadRecord(): ThreadRecord {
  return {
    canonicalAgent: createCanonicalAgentReplica(),
    turnExecutionId: null,
    runtimePhase: "idle",
    savingStatus: null,
    messages: [],
    sessionNotices: [],
    loading: false,
    oldestLoadedSequence: 0,
    newestLoadedSequence: 0,
    hasMoreMessages: false,
    hasNewerMessages: false,
    isLoadingMore: false,
    isLoadingNewer: false,
    loadEpoch: 0,
    conversationRevision: 0,
    persistedToolCallCounts: {},
    persistedFilesChanged: {},
    latestTurnWithChanges: null,
    fileEffectSummary: { revision: 0, fileCount: 0, additions: 0, deletions: 0, effects: [] },
    fileEffectTurnId: "",
    serverMessageIds: {},
    narrativeByMessage: {},
    answeredPlanMessageIds: new Set(),

    error: null,
    streaming: "",
    streamingPreview: "",
    toolCalls: [],
    currentTurnMessageId: "",
    pendingTurnPersistMessageIds: [],
    currentTurnResponseKey: "",
    assistantResponseKeys: {},
    thoughtSegments: [],
    hooks: [],
    isCompacting: false,

    settings: { ...DEFAULT_THREAD_SETTINGS },
    usageByProvider: {},
    goal: null,

    planQuestions: null,
    planAnswers: new Map(),
    activeQuestionIndex: 0,
    planQuestionsStatus: "idle",

    permissions: [],
    forkMode: null,
  };
}

/** Read a thread record, normalizing missing nullable persistence fields. */
export function getThreadRecord(
  records: Map<string, ThreadRecord>,
  threadId: string,
): ThreadRecord {
  const record = records.get(threadId);
  if (!record) return createEmptyThreadRecord();
  if (
    record.pendingTurnPersistMessageIds != null
    && record.narrativeByMessage != null
    && record.conversationRevision != null
    && record.canonicalAgent != null
  ) {
    return record;
  }
  return {
    ...record,
    pendingTurnPersistMessageIds:
      record.pendingTurnPersistMessageIds ?? EMPTY_PENDING_TURN_PERSIST_MESSAGE_IDS,
    narrativeByMessage: record.narrativeByMessage ?? EMPTY_NARRATIVE_BY_MESSAGE,
    conversationRevision: record.conversationRevision ?? 0,
    canonicalAgent: record.canonicalAgent ?? createCanonicalAgentReplica(),
  };
}

/** Immutable Map update with a partial or functional patch for one thread. */
export function patchThreadRecord(
  records: Map<string, ThreadRecord>,
  threadId: string,
  patch:
    | Partial<ThreadRecord>
    | ((current: ThreadRecord) => Partial<ThreadRecord>),
): Map<string, ThreadRecord> {
  const next = new Map(records);
  const current = getThreadRecord(records, threadId);
  const delta = typeof patch === "function" ? patch(current) : patch;
  const updated = updatedThreadRecord(current, delta);
  if (!requiresMessageMetadataPruning(delta)) {
    next.set(threadId, updated);
    return next;
  }
  next.set(threadId, withPrunedMessageMetadata(updated));
  return next;
}

function updatedThreadRecord(current: ThreadRecord, delta: Partial<ThreadRecord>): ThreadRecord {
  const messages = delta.messages;
  const advancesConversation = Object.keys(delta).some((key) => CONVERSATION_REVISION_FIELDS.has(key as keyof ThreadRecord));
  return {
    ...current,
    ...delta,
    ...(messages ? {
      oldestLoadedSequence: delta.oldestLoadedSequence ?? messages[0]?.sequence ?? 0,
      newestLoadedSequence: delta.newestLoadedSequence ?? messages.at(-1)?.sequence ?? 0,
    } : {}),
    conversationRevision: advancesConversation ? current.conversationRevision + 1 : current.conversationRevision,
  };
}

function requiresMessageMetadataPruning(delta: Partial<ThreadRecord>): boolean {
  return ["messages", "serverMessageIds", "pendingTurnPersistMessageIds"].some((key) => key in delta);
}

function withPrunedMessageMetadata(updated: ThreadRecord): ThreadRecord {
  const retainedMessageIds = new Set(updated.messages.map((message) => message.id));
  return {
    ...updated,
    serverMessageIds: Object.fromEntries(
      Object.entries(updated.serverMessageIds).filter(([messageId]) => retainedMessageIds.has(messageId)),
    ),
    pendingTurnPersistMessageIds: prunePendingTurnPersistMessageIds(
      updated.pendingTurnPersistMessageIds,
      updated.messages,
    ),
  };
}

/** Retain pending persistence attribution only while its transcript row is resident. */
export function prunePendingTurnPersistMessageIds(
  pendingMessageIds: readonly string[],
  messages: readonly Message[],
): string[] {
  const retainedMessageIds = new Set(messages.map((message) => message.id));
  return pendingMessageIds.filter((messageId) => retainedMessageIds.has(messageId));
}

/** Remove one thread from the records Map. */
export function deleteThreadRecord(
  records: Map<string, ThreadRecord>,
  threadId: string,
): Map<string, ThreadRecord> {
  if (!records.has(threadId)) return records;
  const next = new Map(records);
  next.delete(threadId);
  return next;
}

/** Derive handoff status from record metadata. */
export function getHandoffStatus(
  record: ThreadRecord,
): "generating" | "ready" | "fallback" | "error" | undefined {
  return record.handoffMeta?.status;
}
