import type { Message, ToolCall, HookExecution, PermissionMode, InteractionMode } from "@/transport";
import type { ToolCallRecord, ThoughtSegmentRecord, HookExecutionRecord } from "@/transport";
import type {
  ContextWindowMode,
  ReasoningLevel,
  PlanQuestion,
  PlanAnswer,
  ProviderUsageInfo,
} from "@mcode/contracts";
import type { PermissionRequest, PermissionDecision } from "@mcode/contracts";
import { PERMISSION_MODES, INTERACTION_MODES } from "@mcode/contracts";
import type { ThoughtSegment } from "@/components/chat/narrative/types";
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

/**
 * Canonical in-memory state for one thread.
 * Collapses the former ~30 parallel `Record<string, X>` maps and active-thread mirror fields.
 */
export interface ThreadRecord {
  messages: Message[];
  loading: boolean;
  oldestLoadedSequence: number;
  hasMoreMessages: boolean;
  isLoadingMore: boolean;
  loadEpoch: number;
  persistedToolCallCounts: Record<string, number>;
  persistedFilesChanged: Record<string, string[]>;
  latestTurnWithChanges: string | null;
  serverMessageIds: Record<string, string>;
  narrativeByMessage: ThreadNarrativeByMessage;
  answeredPlanMessageIds: Set<string>;

  error: string | null;
  streaming: string;
  streamingPreview: string;
  toolCalls: ToolCall[];
  agentStartTime?: number;
  currentTurnMessageId: string;
  thoughtSegments: ThoughtSegment[];
  hooks: HookExecution[];
  isCompacting: boolean;

  settings: ThreadSettings;
  context?: ThreadContextUsage;
  usageByProvider: ThreadUsageByProvider;

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

/** Returns a fresh empty {@link ThreadRecord} for lazy Map insertion. */
export function createEmptyThreadRecord(): ThreadRecord {
  return {
    messages: [],
    loading: false,
    oldestLoadedSequence: 0,
    hasMoreMessages: false,
    isLoadingMore: false,
    loadEpoch: 0,
    persistedToolCallCounts: {},
    persistedFilesChanged: {},
    latestTurnWithChanges: null,
    serverMessageIds: {},
    narrativeByMessage: {},
    answeredPlanMessageIds: new Set(),

    error: null,
    streaming: "",
    streamingPreview: "",
    toolCalls: [],
    currentTurnMessageId: "",
    thoughtSegments: [],
    hooks: [],
    isCompacting: false,

    settings: { ...DEFAULT_THREAD_SETTINGS },
    usageByProvider: {},

    planQuestions: null,
    planAnswers: new Map(),
    activeQuestionIndex: 0,
    planQuestionsStatus: "idle",

    permissions: [],
    forkMode: null,
  };
}

/** Read a thread record, returning a fresh empty record when absent. */
export function getThreadRecord(
  records: Map<string, ThreadRecord>,
  threadId: string,
): ThreadRecord {
  return records.get(threadId) ?? createEmptyThreadRecord();
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
  next.set(threadId, { ...current, ...delta });
  return next;
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
