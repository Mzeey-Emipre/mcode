import { create } from "zustand";
import type { Message, ToolCall, HookExecution, PermissionMode, InteractionMode, AttachmentMeta, StoredAttachment, ToolCallRecord, ThoughtSegmentRecord } from "@/transport";
import type { AgentEvent, CanonicalAgentEventEnvelope, CanonicalAgentReconnectRecovery, ContextWindowMode, MessageMention, ReasoningLevel, OrchestrationMode, PlanQuestion, PlanAnswer, QuotaCategory, ProviderBillingMode, ProviderUsageInfo, GoalLookupResult, GoalState, PreviewAnnotationBundle, TurnFileEffectSummary, TurnRuntimeSnapshot, TurnOutcome } from "@mcode/contracts";
import type { PermissionRequest, PermissionDecision } from "@mcode/contracts";
import type { ThoughtSegment } from "@/features/conversation/narrative/types";
import {
  PlanQuestionSchema,
  PERMISSION_MODES,
  INTERACTION_MODES,
  ProviderIdSchema,
  isGoalOpen,
  previewAnnotationSnapshotStoredAttachments,
  CONVERSATION_HISTORY_PAGE_MAX_BYTES,
  createSubagentPresentation,
  mergeSubagentPresentation,
} from "@mcode/contracts";
import { getTransport } from "@/transport";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useQueueStore } from "./queueStore";
import { LruCache } from "@/lib/lru-cache";
import { useTaskStore, coerceTaskStatus } from "./taskStore";
import { usePlanStore } from "./planStore";
import type { TaskItem } from "./taskStore";
import { useToastStore } from "./toastStore";
import { findModelById } from "@/lib/model-registry";
import { resolveContextWindow } from "@/lib/resolve-context-window";
import { useSettingsStore } from "./settingsStore";
import { createConversationResidency, registerConversationResidency } from "@/features/conversation/residency/conversation-residency";
import { recordBackgroundEventDropped } from "@/lib/thread-switch-telemetry";
import {
  clearPendingTurnPersistMessage,
  projectTurnResponse,
  queuePendingTurnPersistMessage,
  resolveTurnPersistLocalMessageId,
  transferTurnResponseMetadata,
} from "./turn-response-projection";
import { shallowEqualBy } from "@/lib/shallowEqualBy";
import {
  forgetScrollTop,
  recallScrollPosition,
} from "@/components/chat/scrollPositionMemory";
import {
  ACTIVE_CONVERSATION_MESSAGE_BYTES,
  CONVERSATION_NARRATIVE_BYTES,
  selectConversationNarrative,
  selectConversationWindow,
} from "@/features/conversation/hydration/conversation-memory-policy";
import {
  setActiveConversation,
  setConversationTransientTextBytes,
} from "@/features/conversation/hydration/record-cache";
import { releaseBrowserCaptureSpills } from "@/features/preview/capture/browser-capture-spill";
import { isGoalControlCommand } from "@/lib/goal-command";
import { resolveGoalLookupGoal } from "@/lib/goal-lookup";
import { isGoalStatusNotice } from "@/lib/goal-message";
import {
  createThreadHydrator,
  registerThreadHydrator,
  MESSAGE_FETCH_SIZE as HYDRATOR_MESSAGE_FETCH_SIZE,
  type ThreadHydratorWriteState,
} from "@/features/conversation/hydration";
import {
  type ThreadRecord,
  type HandoffMeta,
  type ThreadSettings,
  type StoredPermission,
  getThreadRecord,
  patchThreadRecord,
  deleteThreadRecord,
} from "./thread-record";
import {
  applyCanonicalPushEvents,
  applyCanonicalReconnectRecovery,
} from "./canonical-agent-replica";

function deriveRunningThreadIds(records: Map<string, ThreadRecord>): Set<string> {
  return new Set(
    [...records]
      .filter(([, record]) => record.runtimePhase === "running" || record.runtimePhase === "finalizing")
      .map(([id]) => id),
  );
}

function preserveRunningThreadIds(previous: Set<string>, next: Set<string>): Set<string> {
  return previous.size === next.size && [...next].every((id) => previous.has(id)) ? previous : next;
}

interface RuntimeHydrationObservation {
  turnExecutionId: string | null;
  runtimePhase: ThreadRecord["runtimePhase"];
}

function mergeRuntimeList<T>(
  persisted: T[],
  placeholder: T[],
): T[] {
  return persisted.length > 0 ? persisted : placeholder;
}

function transferThreadRuntime(
  records: Map<string, ThreadRecord>,
  placeholderId: string,
  persistedId: string,
  placeholderRunning: boolean,
): Map<string, ThreadRecord> {
  const placeholder = records.get(placeholderId);
  if (!placeholder || placeholderId === persistedId) return records;
  const persisted = getThreadRecord(records, persistedId);
  const persistedExists = records.has(persistedId);
  const persistedSequence = persisted.lastAgentEventSequence;
  const usePersisted = <T>(value: T, fallback: T, empty: (candidate: T) => boolean): T =>
    empty(value) ? fallback : value;
  const placeholderPhase = placeholder.runtimePhase === "idle" && placeholderRunning
    ? "running"
    : placeholder.runtimePhase;
  const runtimePhase = persisted.runtimePhase === "idle"
    ? placeholderPhase
    : persisted.runtimePhase;
  const turnExecutionId = persisted.turnExecutionId ?? placeholder.turnExecutionId;
  const currentTurnResponseKey = usePersisted(
    persisted.currentTurnResponseKey,
    placeholder.currentTurnResponseKey,
    (value) => value.length === 0,
  ) || `turn-response:${persistedId}:${crypto.randomUUID()}`;
  // Agent-event sequences are scoped to the persisted thread ID. A cursor
  // observed on the client-only placeholder must not suppress its first
  // persisted-ID event after the handoff.
  const nextPersistedSequence = persistedExists ? (persistedSequence ?? 0) : 0;
  const nextRecords = deleteThreadRecord(records, placeholderId);
  return patchThreadRecord(nextRecords, persistedId, {
    runtimePhase,
    turnExecutionId,
    agentStartTime: persisted.agentStartTime ?? placeholder.agentStartTime,
    streaming: usePersisted(persisted.streaming, placeholder.streaming, (value) => value.length === 0),
    streamingPreview: usePersisted(
      persisted.streamingPreview,
      placeholder.streamingPreview,
      (value) => value.length === 0,
    ),
    toolCalls: mergeRuntimeList(persisted.toolCalls, placeholder.toolCalls),
    thoughtSegments: mergeRuntimeList(persisted.thoughtSegments, placeholder.thoughtSegments),
    hooks: mergeRuntimeList(persisted.hooks, placeholder.hooks),
    currentTurnMessageId: usePersisted(
      persisted.currentTurnMessageId,
      placeholder.currentTurnMessageId,
      (value) => value.length === 0,
    ),
    pendingTurnPersistMessageIds: [
      ...new Set([
        ...placeholder.pendingTurnPersistMessageIds,
        ...persisted.pendingTurnPersistMessageIds,
      ]),
    ],
    currentTurnResponseKey,
    assistantResponseKeys: {
      ...placeholder.assistantResponseKeys,
      ...persisted.assistantResponseKeys,
    },
    isCompacting: persisted.isCompacting || placeholder.isCompacting,
    permissions: persisted.permissions.length > 0 ? persisted.permissions : placeholder.permissions,
    narrativeByMessage: {
      ...placeholder.narrativeByMessage,
      ...persisted.narrativeByMessage,
    },
    ...(nextPersistedSequence > 0
      ? {
        lastAgentEventSequence: nextPersistedSequence,
        lastAgentEventEpoch: persisted.lastAgentEventEpoch,
      }
      : {}),
    fileEffectSummary: persisted.fileEffectSummary.effects.length > 0
      ? persisted.fileEffectSummary
      : placeholder.fileEffectSummary,
    fileEffectTurnId: usePersisted(
      persisted.fileEffectTurnId,
      placeholder.fileEffectTurnId,
      (value) => value.length === 0,
    ),
    awaitingUserStopPersist: persisted.awaitingUserStopPersist ?? placeholder.awaitingUserStopPersist,
    rateLimit: persisted.rateLimit ?? placeholder.rateLimit,
    apiRetry: persisted.apiRetry ?? placeholder.apiRetry,
    ...(persistedExists && persisted.error !== null
      ? {}
      : { error: placeholder.error }),
  });
}

export type { HandoffMeta, ThreadSettings, StoredPermission } from "./thread-record";
export { getHandoffStatus } from "./thread-record";

/** In-memory Recap cache entry for one thread, reset when the app restarts. */
export interface ThreadRecapCacheEntry {
  text: string;
  signature: string;
  coveredMessageId: string;
  generatedAt: string;
  lastAutoGeneratedAt?: string;
}

interface ThreadState {
  records: Map<string, ThreadRecord>;
  currentThreadId: string | null;
  runningThreadIds: Set<string>;
  /** In-memory Recap cache keyed by thread id. */
  recapByThread: Record<string, ThreadRecapCacheEntry>;
  /** Cache for tool call records to avoid re-fetching from server. */
  toolCallRecordCache: LruCache<string, ToolCallRecord[]>;
  /**
   * Transient set of assistant-message IDs whose plan-questions block was
   * JUST marked answered via the `plan.answered` push channel. Used by
   * the AnsweredSummary marker to play a one-shot echo animation. Entries
   * are removed automatically ~800ms after they are added so the pulse
   * does NOT replay when a thread reloads later.
   */
  recentlyAnsweredPlanMessageIds: Set<string>;

  /** Store tool call records in the cache. */
  cacheToolCallRecords: (key: string, records: ToolCallRecord[]) => void;
  /** Retrieve cached tool call records, or null if not cached. */
  getCachedToolCallRecords: (key: string) => ToolCallRecord[] | null;
  /** Evict the entire tool call record cache. Records are re-fetched on next expand. */
  clearToolCallRecordCache: () => void;
  /** Apply automatic pressure to conversation caches. */
  applyConversationMemoryPressure: (level: "warning" | "critical") => void;

  // Message actions
  loadOlderMessages: (threadId: string) => Promise<void>;
  loadNewerMessages: (threadId: string) => Promise<void>;
  sendMessage: (threadId: string, content: string, model?: string, permissionMode?: PermissionMode, attachments?: AttachmentMeta[], displayContent?: string, reasoningLevel?: ReasoningLevel, provider?: string, copilotAgent?: string, contextWindow?: ContextWindowMode, thinking?: boolean, codexFastMode?: boolean, replyToMessageId?: string, quotedText?: string, planAction?: import("@mcode/contracts").PlanAction, mentions?: MessageMention[], previewAnnotations?: PreviewAnnotationBundle, goalObjective?: string, orchestrationMode?: OrchestrationMode) => Promise<void>;
  /** Remove one durably cancelled message from the resident thread transcript. */
  removePersistedMessage: (threadId: string, messageId: string) => void;
  stopAgent: (threadId: string) => Promise<void>;
  /** Apply one authoritative runtime snapshot without replacing other running threads. */
  applyThreadRuntimeSnapshot: (snapshot: TurnRuntimeSnapshot) => void;
  /** Atomically move optimistic first-turn runtime state to the persisted thread identity. */
  transferThreadRuntime: (placeholderId: string, persistedId: string) => void;
  /** Reconcile server runtime snapshots while preserving locally advanced state. */
  hydrateRunningThreads: (ids: string[], observed?: ReadonlyMap<string, RuntimeHydrationObservation>) => void;
  /** Restore authoritative per-thread execution snapshots during reconnect. */
  hydrateThreadRuntimes: (
    snapshots: import("@mcode/contracts").TurnRuntimeSnapshot[],
    observed?: ReadonlyMap<string, RuntimeHydrationObservation>,
  ) => void;
  addMessage: (message: Message) => void;
  clearMessages: () => void;
  /** Deactivate the selected conversation and invalidate any active hydration commit. */
  deactivateConversation: () => void;
  /** Returns true if an agent is actively executing on the given thread. */
  isThreadRunning: (threadId: string) => boolean;
  /** Set questions received from the model and show the wizard. */
  setPlanQuestions: (threadId: string, questions: PlanQuestion[]) => void;
  /** Record the user's answer for one question. */
  setPlanAnswer: (threadId: string, questionId: string, answer: PlanAnswer) => void;
  /** Navigate to a specific question index. */
  setActiveQuestionIndex: (threadId: string, index: number) => void;
  /** Submit all answers to the server and dismiss the wizard. */
  submitPlanAnswers: (threadId: string) => Promise<void>;
  /** Send a plan-tab revise or implement action without plan-questions wrapping. */
  sendPlanAction: (threadId: string, content: string, action: import("@mcode/contracts").PlanAction) => Promise<void>;
  /** Reset plan question state for a thread (called on clear/reload). */
  clearPlanQuestions: (threadId: string) => void;
  /**
   * Record that the plan-questions block on `assistantMessageId` has been
   * answered server-side, and dismiss the wizard for that thread. Wired to
   * the `plan.answered` push channel from `ws-events.ts`.
   */
  markPlanAnswered: (threadId: string, assistantMessageId: string) => void;
  /**
   * Same settle semantics as `markPlanAnswered` (adds to the answered set,
   * dismisses the wizard) but intentionally skips the
   * recentlyAnsweredPlanMessageIds add — dismiss is not submission, so the
   * AnsweredSummary echo animation must not play. Wired to the
   * `plan.dismissed` push channel.
   */
  markPlanDismissed: (threadId: string, assistantMessageId: string) => void;
  /** Add a new pending permission request for a thread. */
  addPermissionRequest: (request: PermissionRequest) => void;
  /** Mark a permission request as settled with its decision. */
  resolvePermissionRequest: (requestId: string, decision: PermissionDecision) => void;
  handleAgentEvent: (event: AgentEvent) => void;
  /** Install ordered canonical reconnect results before later push revisions. */
  applyCanonicalReconnectRecoveries: (
    recoveries: readonly CanonicalAgentReconnectRecovery[],
  ) => void;
  /** Apply one committed canonical push batch to its thread replica. */
  handleCanonicalAgentEvents: (
    threadId: string,
    events: readonly CanonicalAgentEventEnvelope[],
  ) => void;
  /** Refresh the provider-neutral goal lookup for a thread and update cached thread state. */
  refreshThreadGoal: (threadId: string) => Promise<GoalLookupResult>;
  /** Clear the active goal through the app RPC and update cached thread state. */
  clearThreadGoal: (threadId: string) => Promise<GoalLookupResult>;

  /**
   * Fetch the persisted narrative (tools, thoughts, hooks) for an assistant
   * message and cache it under `narrativeByMessage[messageId]`. Returns the
   * existing in-flight promise on concurrent calls to avoid duplicate RPCs.
   * Idempotent after a dedicated list response has supplied every persisted
   * tool row expected by the message; partial responses remain refreshable.
   */
  loadNarrativeForMessage: (messageId: string, threadId?: string) => Promise<void>;
  /** Return whether a complete narrative payload has been loaded for a message. */
  isNarrativeLoaded: (threadId: string, messageId: string) => boolean;
  /** Drop the cached narrative for a message - call from edit/delete paths. */
  evictNarrativeForMessage: (messageId: string) => void;

  /** Handle server-side tool call persistence confirmation. */
  handleTurnPersisted: (payload: {
    threadId: string;
    messageId: string;
    turnId?: string | null;
    executionId?: string | null;
    outcome?: TurnOutcome | null;
    toolCallCount: number;
    filesChanged: string[];
    fileEffects?: TurnFileEffectSummary;
  }) => void;
  /** Apply a monotonic live file-effect update for one thread. */
  handleFileEffectsUpdated: (
    threadId: string,
    turnId: string,
    summary: TurnFileEffectSummary,
  ) => void;
  /** Clear the interrupt file-notice banner for one thread (user dismissed). */
  clearInterruptStopFileNotice: (threadId: string) => void;
  /** Clears composer recall state for one thread after the Composer applies it. */
  clearComposerRecallFromStop: (threadId: string) => void;

  /** Update handoff metadata for a child thread. */
  setHandoffMeta: (threadId: string, meta: HandoffMeta) => void;
  /** @deprecated Use setHandoffMeta. Still functional for legacy callers. */
  setHandoffStatus: (threadId: string, status: "generating" | "ready" | "fallback" | "error") => void;

  /** Set or clear fork mode for a thread. */
  setForkMode: (threadId: string, state: { messageId: string; content: string | null; role: "user" | "assistant" } | null) => void;

  // Per-thread settings
  /** Return current settings for a thread, preferring in-memory overrides over DB-persisted values. */
  getThreadSettings: (threadId: string) => ThreadSettings;
  /** Merge partial settings and persist to server. Resolves to false if RPC fails or patch is empty. */
  setThreadSettings: (threadId: string, settings: Partial<ThreadSettings>) => Promise<boolean>;

  /** Fetch and refresh provider usage info from the server for the given thread and provider. */
  fetchProviderUsage: (threadId: string, providerId: string) => Promise<void>;
  /** Cache a successful thread Recap generation result for the current app session. */
  recordThreadRecapGeneration: (input: {
    threadId: string;
    text: string;
    signature: string;
    coveredMessageId: string;
    generatedAt: string;
    source: "manual" | "automatic";
  }) => void;
  /** Remove all per-thread state for a deleted thread. Clears visible-thread globals when the deleted thread is the current one. */
  clearThreadState: (threadId: string) => void;
  /** Batch variant of clearThreadState. Prunes all IDs in a single Zustand set() call to avoid N sequential re-renders. Used by deleteWorkspace. */
  clearThreadStateMany: (threadIds: string[]) => void;
}

/** Pending dequeue timers per thread, so duplicate turnComplete events don't double-dequeue. */
const dequeueTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Module-level dedup map for in-flight `narrative.list` RPCs. Held outside the
 * store so concurrent `loadNarrativeForMessage` calls share a single promise
 * without triggering re-renders for the inflight bookkeeping.
 */
const narrativeInflight = new Map<string, Promise<void>>();
/** Message narratives returned by a complete conversation-page read. */
const narrativeLoaded = new Set<string>();

function narrativeKey(threadId: string, messageId: string): string {
  return `${threadId}\u0000${messageId}`;
}

function clearNarrativeLoadState(threadId: string): void {
  const prefix = `${threadId}\u0000`;
  for (const key of narrativeLoaded) {
    if (key.startsWith(prefix)) narrativeLoaded.delete(key);
  }
}
const USAGE_STALE_TTL_MS = 24 * 60 * 60 * 1000;
const providerUsageSnapshots = new Map<string, ProviderUsageInfo>();

function hasProviderUsageData(usage: ProviderUsageInfo | undefined): boolean {
  return (
    (usage?.quotaCategories.length ?? 0) > 0 ||
    usage?.sessionCostUsd !== undefined ||
    usage?.serviceTier !== undefined ||
    usage?.numTurns !== undefined ||
    usage?.durationMs !== undefined
  );
}

function isFreshUsageSnapshot(usage: ProviderUsageInfo | undefined, now = Date.now()): boolean {
  if (!usage?.fetchedAt) return hasProviderUsageData(usage);
  const fetchedAt = Date.parse(usage.fetchedAt);
  return Number.isFinite(fetchedAt) && now - fetchedAt <= USAGE_STALE_TTL_MS;
}

function providerQuotaSnapshot(usage: ProviderUsageInfo): ProviderUsageInfo {
  return {
    providerId: usage.providerId,
    quotaCategories: usage.quotaCategories,
    billingMode: usage.billingMode,
    usageStatus: usage.usageStatus,
    fetchedAt: usage.fetchedAt,
    failedAt: usage.failedAt,
    diagnostic: usage.diagnostic,
  };
}

function mergeThreadUsageSnapshot(
  existing: ProviderUsageInfo | undefined,
  providerSnapshot: ProviderUsageInfo | undefined,
  incoming: ProviderUsageInfo,
  now = Date.now(),
): ProviderUsageInfo {
  const existingThreadMetrics = existing
    ? {
        sessionCostUsd: existing.sessionCostUsd,
        serviceTier: existing.serviceTier,
        numTurns: existing.numTurns,
        durationMs: existing.durationMs,
      }
    : {};
  const baseProviderSnapshot = providerSnapshot && hasProviderUsageData(providerSnapshot)
    ? providerSnapshot
    : existing;
  return {
    ...mergeProviderUsageSnapshot(baseProviderSnapshot, providerQuotaSnapshot(incoming), now),
    ...existingThreadMetrics,
    sessionCostUsd: incoming.sessionCostUsd ?? existing?.sessionCostUsd,
    serviceTier: incoming.serviceTier ?? existing?.serviceTier,
    numTurns: incoming.numTurns ?? existing?.numTurns,
    durationMs: incoming.durationMs ?? existing?.durationMs,
  };
}

/**
 * Merges incoming provider quota data with a prior last-known-good snapshot.
 */
export function mergeProviderUsageSnapshot(
  existing: ProviderUsageInfo | undefined,
  incoming: ProviderUsageInfo,
  now = Date.now(),
): ProviderUsageInfo {
  const status = incoming.usageStatus
    ?? (incoming.quotaCategories.length === 0 ? "unavailable" : "ready");
  if (status === "unavailable" || status === "unsupported") {
    if (existing && hasProviderUsageData(existing) && isFreshUsageSnapshot(existing, now)) {
      return {
        ...existing,
        providerId: existing.providerId,
        quotaCategories: existing.quotaCategories,
        usageStatus: "stale",
        failedAt: incoming.failedAt ?? new Date(now).toISOString(),
        diagnostic: incoming.diagnostic,
      };
    }
    return { ...incoming, usageStatus: status };
  }

  if (status === "ready-empty") {
    return {
      providerId: incoming.providerId,
      quotaCategories: [],
      billingMode: incoming.billingMode,
      sessionCostUsd: incoming.sessionCostUsd,
      serviceTier: incoming.serviceTier,
      numTurns: incoming.numTurns,
      durationMs: incoming.durationMs,
      usageStatus: "ready-empty",
      fetchedAt: incoming.fetchedAt ?? new Date(now).toISOString(),
    };
  }

  return {
    ...existing,
    ...incoming,
    quotaCategories: incoming.quotaCategories.length > 0
      ? incoming.quotaCategories
      : (existing?.quotaCategories ?? []),
    usageStatus: incoming.quotaCategories.length > 0 ? "ready" : (incoming.usageStatus ?? "ready-empty"),
    fetchedAt: incoming.fetchedAt ?? new Date(now).toISOString(),
    failedAt: undefined,
    diagnostic: undefined,
  };
}

function clearDequeueTimer(threadId: string) {
  const timer = dequeueTimers.get(threadId);
  if (timer) {
    clearTimeout(timer);
    dequeueTimers.delete(threadId);
  }
}

function hasPendingPlanQuestions(threadId: string): boolean {
  return getThreadRecord(useThreadStore.getState().records, threadId).planQuestionsStatus === "pending";
}

/**
 * Resume auto-drain for a thread that was paused while the user edited a
 * queued message. Schedules the same 400ms-delayed check used by the
 * turnComplete handler. No-op when the thread is busy or the queue is empty.
 */
export function scheduleDrainAfterEdit(threadId: string): void {
  if (hasPendingPlanQuestions(threadId)) return;
  clearDequeueTimer(threadId);
  const timer = setTimeout(() => {
    dequeueTimers.delete(threadId);
    const threadExists = useWorkspaceStore.getState().threads.some(
      (t) => t.id === threadId && t.deleted_at == null,
    );
    if (!threadExists) return;
    if (useThreadStore.getState().runningThreadIds.has(threadId)) return;
    if (useQueueStore.getState().editingThreadId === threadId) return;
    if (hasPendingPlanQuestions(threadId)) return;

    const next = useQueueStore.getState().dequeueNext(threadId);
    if (next) {
      void (async (): Promise<void> => {
        try {
          await useThreadStore.getState().sendMessage(
            threadId,
            next.content,
            next.model,
            next.permissionMode,
            next.attachments.length > 0 ? next.attachments : undefined,
            next.displayContent,
            next.reasoningLevel,
            next.provider,
            next.copilotAgent,
            next.contextWindow,
            next.thinking,
            next.codexFastMode,
            next.replyToMessageId,
            next.quotedText,
            undefined,
            next.mentions,
            next.previewAnnotations,
            next.goalObjective,
            next.orchestrationMode,
          );
        } catch {
          void releaseBrowserCaptureSpills(next.browserCaptureSpillPaths ?? []);
        }
      })();
    }
  }, 400);
  dequeueTimers.set(threadId, timer);
}

/**
 * Shallow-clone a thread record's ephemeral streaming fields for a new turn.
 */
function resetTurnEphemeral(_rec: ThreadRecord): Partial<ThreadRecord> {
  return {
    streaming: "",
    streamingPreview: "",
    toolCalls: [],
    thoughtSegments: [],
    hooks: [],
    currentTurnMessageId: "",
    currentTurnResponseKey: "",
    fileEffectTurnId: "",
  };
}

/**
 * Resolve the client-side message id that should receive a `turn.persisted`
 * payload. Never uses {@link ThreadRecord.currentTurnMessageId} alone because
 * auto-dequeue can advance it before the prior turn's async snapshot finishes.
 */
/**
 * Ensure the transcript contains an assistant row for persisted turn metadata.
 * Tools-only turns may materialize on the server without a client `session.message`.
 */
function ensureAssistantMessageForTurnPersist(
  rec: ThreadRecord,
  threadId: string,
  localMessageId: string,
): Message[] | undefined {
  if (rec.messages.some((m) => m.id === localMessageId)) {
    return undefined;
  }
  const placeholder: Message = {
    id: localMessageId,
    thread_id: threadId,
    role: "assistant",
    content: "",
    tool_calls: null,
    files_changed: null,
    cost_usd: null,
    tokens_used: null,
    timestamp: new Date().toISOString(),
    sequence: rec.messages.length + 1,
    attachments: null,
    model: null,
  };
  const { messages } = capMessages([...rec.messages, placeholder]);
  return messages;
}

/** Returns a React key shared by the live and just-persisted final response. */
function createTurnResponseKey(threadId: string): string {
  return `turn-response:${threadId}:${crypto.randomUUID()}`;
}

/**
 * Resolve the response key for a newly persisted assistant message and the
 * live key for any follow-up streaming in the same turn.
 *
 * A turn can persist multiple assistant messages (e.g. Codex narration
 * between tool batches plus the final response). The live key may only be
 * claimed once — handing it to a second message would give two React siblings
 * the same key — so the live key rotates after each claim, and a key already
 * claimed by another message is never reused.
 */
function claimTurnResponseKey(
  rec: ThreadRecord,
  threadId: string,
  messageId: string,
): { responseKey: string; nextLiveKey: string } {
  const existing = rec.assistantResponseKeys[messageId];
  if (existing) {
    // Redelivered message: keep its key and leave the live key untouched.
    return {
      responseKey: existing,
      nextLiveKey: rec.currentTurnResponseKey || createTurnResponseKey(threadId),
    };
  }
  const liveKey = rec.currentTurnResponseKey;
  const liveKeyClaimed =
    liveKey !== "" && Object.values(rec.assistantResponseKeys).includes(liveKey);
  const responseKey =
    liveKey && !liveKeyClaimed ? liveKey : createTurnResponseKey(threadId);
  return { responseKey, nextLiveKey: createTurnResponseKey(threadId) };
}

function parseStoredAttachments(value: unknown): StoredAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is StoredAttachment => {
    if (!item || typeof item !== "object") return false;
    const record = item as Record<string, unknown>;
    return (
      typeof record.id === "string" &&
      typeof record.name === "string" &&
      typeof record.mimeType === "string" &&
      typeof record.sizeBytes === "number"
    );
  });
}

/** Maps a persisted thought row into the live narrative segment shape. */
function persistedThoughtToSegment(record: ThoughtSegmentRecord): ThoughtSegment {
  const startedAt = Date.parse(record.started_at);
  const endedAt = record.ended_at ? Date.parse(record.ended_at) : NaN;
  return {
    text: record.text,
    startedAt: Number.isFinite(startedAt) ? startedAt : Date.now(),
    endedAt: Number.isFinite(endedAt) ? endedAt : undefined,
  };
}

/** Returns persisted thought rows that should remain visible above the final reply. */
function visiblePersistedThoughtSegments(
  thoughts: readonly ThoughtSegmentRecord[],
): ThoughtSegment[] {
  return thoughts
    .filter((thought) => !thought.is_final_response)
    .map(persistedThoughtToSegment);
}

/**
 * Walk up the parentToolCallId chain to find the nearest Agent tool call
 * and return its description as a group label for TodoWrite tasks.
 */
function resolveAgentGroupLabel(
  toolCalls: readonly ToolCall[],
  parentToolCallId: string,
): string {
  let current: string | undefined = parentToolCallId;
  while (current) {
    const tc = toolCalls.find((c) => c.id === current);
    if (!tc) break;
    if (tc.toolName === "Agent") {
      const desc = tc.toolInput?.description ?? tc.toolInput?.prompt;
      if (typeof desc === "string" && desc.length > 0) {
        return desc.length > 80 ? desc.slice(0, 77) + "..." : desc;
      }
      return "Sub-agent";
    }
    current = tc.parentToolCallId;
  }
  return "Sub-agent";
}

function taskTextFromToolInput(toolInput: Record<string, unknown>): string | null {
  const subject =
    typeof toolInput.subject === "string" && toolInput.subject.trim().length > 0
      ? toolInput.subject.trim()
      : typeof toolInput.title === "string" && toolInput.title.trim().length > 0
        ? toolInput.title.trim()
        : typeof toolInput.content === "string" && toolInput.content.trim().length > 0
          ? toolInput.content.trim()
          : "";
  const description =
    typeof toolInput.description === "string" && toolInput.description.trim().length > 0
      ? toolInput.description.trim()
      : "";

  if (!subject && !description) return null;
  if (!subject) return description;
  if (!description) return subject;
  return `${subject} - ${description}`;
}

/**
 * Extract the harness-assigned task id from a `TaskCreate` result line such as
 * "Task #1 created successfully: ...". Returns null when no id is present.
 */
function parseHarnessTaskId(output: string): string | null {
  const match = /#(\d+)/.exec(output);
  return match ? match[1] : null;
}

function updatePlanTasksFromToolInput(toolInput: Record<string, unknown>): TaskItem[] {
  const entries =
    Array.isArray(toolInput.plan)
      ? toolInput.plan
      : Array.isArray(toolInput.tasks)
        ? toolInput.tasks
        : Array.isArray(toolInput.todos)
          ? toolInput.todos
          : [];

  return entries.flatMap((entry, i): TaskItem[] => {
    const item: Record<string, unknown> = typeof entry === "object" && entry !== null
      ? entry as Record<string, unknown>
      : { step: entry };
    const content =
      typeof item.step === "string" && item.step.trim().length > 0
        ? item.step.trim()
        : typeof item.content === "string" && item.content.trim().length > 0
          ? item.content.trim()
          : typeof item.title === "string" && item.title.trim().length > 0
            ? item.title.trim()
            : typeof item.description === "string" && item.description.trim().length > 0
              ? item.description.trim()
              : "";
    if (!content) return [];
    return [{
      id: item.id != null ? String(item.id) : String(i),
      content,
      status: coerceTaskStatus(item.status),
      group: "Tasks",
    }];
  });
}

/**
 * Returns how many Agent (subagent) tool calls are still in flight for status UI.
 */
export function countActiveSubagentCalls(calls: ToolCall[] | undefined): number {
  if (!calls?.length) return 0;
  let n = 0;
  for (const tc of calls) {
    if (tc.toolName === "Agent" && !tc.isComplete) n++;
  }
  return n;
}

/** Number of messages to fetch per directional pagination request. */
export const HISTORY_PAGE_SIZE = 50;

/** Maximum messages kept in the in-memory sliding window. */
export const MESSAGE_WINDOW_SIZE = 200;

/** Initial message fetch size per thread. */
export const MESSAGE_FETCH_SIZE = HYDRATOR_MESSAGE_FETCH_SIZE;

const DEFAULT_THREAD_SETTINGS: ThreadSettings = {
  permissionMode: PERMISSION_MODES.FULL,
  interactionMode: INTERACTION_MODES.BUILD,
};

/** Resolve thread settings from the workspace DB row (no in-memory record required). */
export function resolveWorkspaceThreadSettings(threadId: string): ThreadSettings {
  const thread = useWorkspaceStore.getState().threads.find((t) => t.id === threadId);
  if (thread) {
    return {
      permissionMode: (thread.permission_mode as PermissionMode) ?? DEFAULT_THREAD_SETTINGS.permissionMode,
      interactionMode: (thread.interaction_mode as InteractionMode) ?? DEFAULT_THREAD_SETTINGS.interactionMode,
      orchestrationMode: (thread.orchestration_mode as OrchestrationMode | null) ?? undefined,
      reasoningLevel: thread.reasoning_level !== null
        ? (thread.reasoning_level as ReasoningLevel)
        : undefined,
      copilotAgent: thread.copilot_agent,
      contextWindow: (thread.context_window_mode as ContextWindowMode | null) ?? null,
      thinking: thread.thinking ?? null,
      codexFastMode: thread.codex_fast_mode ?? null,
      defaultOpenInApp: thread.default_open_in_app ?? null,
    };
  }
  return DEFAULT_THREAD_SETTINGS;
}

/** Maximum entries in the tool call record LRU cache. */
export const TOOL_CALL_CACHE_SIZE = 200;

/**
 * Enforce the sliding window cap on a messages array.
 * Returns the trimmed array and whether messages were evicted.
 */
function capMessages(messages: Message[]): { messages: Message[]; evicted: boolean } {
  const selected = selectConversationWindow(messages, {
    maxBytes: ACTIVE_CONVERSATION_MESSAGE_BYTES,
    maxMessages: MESSAGE_WINDOW_SIZE,
    preference: "newer",
  });
  return {
    messages: selected.messages,
    evicted: selected.evictedOlder || selected.evictedNewer,
  };
}

type ConversationPageDirection = "older" | "newer";

interface MergedConversationWindow {
  messages: Message[];
  evictedOlder: boolean;
  evictedNewer: boolean;
}

/** Merge one directional page while resident identities and sequences keep precedence. */
function mergeConversationWindow(
  threadId: string,
  residentMessages: readonly Message[],
  pageMessages: readonly Message[],
  direction: ConversationPageDirection,
): MergedConversationWindow {
  const residentIds = new Set(residentMessages.map((message) => message.id));
  const byId = new Map([...pageMessages, ...residentMessages].map((message) => [message.id, message]));
  const bySequence = new Map<number, Message>();
  for (const message of byId.values()) {
    const existing = bySequence.get(message.sequence);
    if (!existing || (residentIds.has(message.id) && !residentIds.has(existing.id))) {
      bySequence.set(message.sequence, message);
    }
  }
  const merged = [...bySequence.values()].sort((left, right) =>
    left.sequence - right.sequence || left.id.localeCompare(right.id),
  );
  return selectConversationWindow(merged, {
    anchorMessageId: recallScrollPosition(threadId)?.anchorMessageId,
    maxBytes: ACTIVE_CONVERSATION_MESSAGE_BYTES,
    maxMessages: MESSAGE_WINDOW_SIZE,
    preference: direction,
  });
}

function filterPaginationMetadata<T>(
  metadata: Record<string, T>,
  retainedMessageIds: ReadonlySet<string>,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(metadata).filter(([messageId]) => retainedMessageIds.has(messageId)),
  );
}

/** Keeps turn response keys only for assistant messages still loaded in memory. */
function pruneAssistantResponseKeys(
  responseKeys: Record<string, string>,
  messages: readonly Message[],
): Record<string, string> {
  const assistantIds = new Set(
    messages.filter((message) => message.role === "assistant").map((message) => message.id),
  );
  return Object.fromEntries(
    Object.entries(responseKeys).filter(([messageId]) => assistantIds.has(messageId)),
  );
}

/**
 * Scan a message list for an unanswered plan-questions block.
 * Finds the last assistant message containing a ```plan-questions``` fenced block,
 * confirms no user message follows it (meaning questions haven't been answered yet),
 * then parses and validates the JSON array inside the block.
 * Returns the parsed questions or null if none found.
 */
/**
 * Walk messages newest-first to find the latest assistant `plan-questions`
 * fence and decide whether the wizard should pop.
 *
 * Decision order:
 *   1. The fence assistant message id is in `answeredIds` -> null (answered).
 *   2. A user message follows the fence in the array -> null (legacy fallback
 *      for threads that answered plan-questions before the marker landed).
 *   3. Otherwise -> parsed questions.
 *
 * Trailing assistant messages without a fence (e.g. a partially-streamed
 * follow-up) are skipped so the wizard still surfaces while the model is
 * mid-turn.
 */
export function extractPendingPlanQuestions(
  messages: Message[],
  answeredIds: ReadonlySet<string>,
): PlanQuestion[] | null {
  const PLAN_QUESTIONS_RE = /```plan-questions\n([\s\S]*?)```/;

  // First pass: locate the fence message index, walking newest-first.
  let fenceIndex = -1;
  let fenceContent: string | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const match = msg.content.match(PLAN_QUESTIONS_RE);
    if (match) {
      fenceIndex = i;
      fenceContent = match[1];
      break;
    }
  }
  if (fenceIndex === -1 || fenceContent == null) return null;

  // Authoritative marker: the server says this round was answered.
  if (answeredIds.has(messages[fenceIndex].id)) return null;

  // Legacy fallback: any user message after the fence implies the user
  // already answered (covers threads from before the marker existed).
  for (let i = fenceIndex + 1; i < messages.length; i++) {
    if (messages[i].role === "user") return null;
  }

  try {
    const raw = JSON.parse(fenceContent);
    if (!Array.isArray(raw)) return null;
    const results = raw.map((item) => PlanQuestionSchema().safeParse(item));
    // Reject the whole batch if any question fails — partial batches break
    // index continuity between the wizard UI and the answer map keys.
    if (results.some((r) => !r.success)) return null;
    const validated = results.map(
      (r) => (r as { success: true; data: PlanQuestion }).data,
    );
    return validated.length > 0 ? validated : null;
  } catch {
    return null;
  }
}

/** One coalesced `session.textDelta` span for rAF flushing; preserves missing `isFinalResponse` for legacy fallback behavior. */
type PendingTextChunk = {
  delta: string;
  isFinalResponse?: boolean;
  /** Background deltas retain the streaming buffer but defer narrative projection until activation. */
  deferNarrative?: boolean;
};

const MAX_DEFERRED_NARRATIVE_EVENTS = 2048;

function appendThoughtSegment(
  segments: ThoughtSegment[],
  acc: string,
  isExplicitNonFinal: boolean,
): ThoughtSegment[] {
  if (!acc) return segments;
  const looksLikeContinuation = (prevText: string, nextText: string): boolean => {
    const trimmedPrev = prevText.trimEnd();
    const lastChar = trimmedPrev.slice(-1);
    const prevEndsSentence = /[.!?]/.test(lastChar);
    const firstChar = nextText.replace(/^\s+/, "").slice(0, 1);
    const nextStartsLowerOrPunct =
      firstChar === "" || /[a-z,;:)\]}-]/.test(firstChar);
    return !prevEndsSentence || nextStartsLowerOrPunct;
  };
  const TINY_SEGMENT_THRESHOLD = 40;
  const last = segments[segments.length - 1];
  const shouldReopen =
    last &&
    last.endedAt !== undefined &&
    (last.text.length < TINY_SEGMENT_THRESHOLD || looksLikeContinuation(last.text, acc));
  if (!last || (last.endedAt !== undefined && !shouldReopen)) {
    return [
      ...segments,
      {
        text: acc,
        startedAt: Date.now(),
        ...(isExplicitNonFinal ? { isExplicitNonFinal: true } : {}),
      },
    ];
  }
  if (last.endedAt !== undefined && shouldReopen) {
    const reopened: ThoughtSegment = {
      ...last,
      text: last.text + acc,
      ...(isExplicitNonFinal ? { isExplicitNonFinal: true } : {}),
    };
    delete (reopened as { endedAt?: number }).endedAt;
    return [...segments.slice(0, -1), reopened];
  }
  return [
    ...segments.slice(0, -1),
    {
      ...last,
      text: last.text + acc,
      ...(isExplicitNonFinal ? { isExplicitNonFinal: true } : {}),
    },
  ];
}

function projectAssistantMessageBoundary(
  segments: ThoughtSegment[],
  isFinalResponse: boolean,
): ThoughtSegment[] | undefined {
  const last = segments[segments.length - 1];
  if (!last || last.endedAt !== undefined) return undefined;
  return isFinalResponse
    ? segments.slice(0, -1)
    : [...segments.slice(0, -1), { ...last, endedAt: Date.now() }];
}

function projectToolProgress(
  toolCalls: ToolCall[],
  toolCallId: string,
  elapsedSeconds: number,
  lastActivityAt: number,
): ToolCall[] | undefined {
  let changed = false;
  const updated = toolCalls.map((toolCall) => {
    if (toolCall.id === toolCallId && !toolCall.isComplete) {
      changed = true;
      return { ...toolCall, elapsedSeconds, lastActivityAt };
    }
    return toolCall;
  });
  return changed ? updated : undefined;
}

/** Zustand store for thread-scoped messages, streaming session state, and agent event handling. */
export const useThreadStore = create<ThreadState>((zustandSet, get) => {
  const set = ((updater: Parameters<typeof zustandSet>[0]) => zustandSet((state) => {
    const next = typeof updater === "function" ? updater(state) : updater;
    if (!next || Object.keys(next).length === 0) return next;
    const records = "records" in next && next.records ? next.records : state.records;
    const runningThreadIds = "runningThreadIds" in next
      ? next.runningThreadIds
      : records.size === 0
        ? state.runningThreadIds
        : deriveRunningThreadIds(records);
    return { ...next, runningThreadIds: preserveRunningThreadIds(state.runningThreadIds, runningThreadIds) };
  })) as typeof zustandSet;
  let textDeltaFlushRaf: number | null = null;
  const pendingTextDeltaByThread = new Map<string, PendingTextChunk[]>();
  const streamingTextByteSizes = new Map<string, number>();
  const textEncoder = new TextEncoder();
  const clearStreamingTextUsage = (threadId: string): void => {
    streamingTextByteSizes.delete(threadId);
    setConversationTransientTextBytes(threadId, 0);
  };
  const deferredNarrativeEventsByThread = new Map<
    string,
    { generation: number; events: AgentEvent[]; bytes: number }
  >();
  const deferredNarrativeGenerations = new Map<string, number>();
  const MAX_DEFERRED_NARRATIVE_BYTES = 256 * 1024;

  const getRec = (threadId: string) => getThreadRecord(get().records, threadId);

  const patchRec = (
    threadId: string,
    patch: Partial<ThreadRecord> | ((current: ThreadRecord) => Partial<ThreadRecord>),
  ) => {
    set((s) => ({ records: patchThreadRecord(s.records, threadId, patch) }));
  };

  const applyGoalLookup = (threadId: string, lookup: GoalLookupResult): void => {
    const current = getRec(threadId);
    const goal = resolveGoalLookupGoal(lookup, current.goal);
    patchRec(threadId, { goal });
  };

  /**
   * Applies coalesced `session.textDelta` chunks batched on `requestAnimationFrame`.
   * `isFinalResponse` spans update streaming buffers only so they stay out of thought segments.
   */
  const flushPendingTextDeltas = () => {
    if (textDeltaFlushRaf != null) {
      cancelAnimationFrame(textDeltaFlushRaf);
      textDeltaFlushRaf = null;
    }
    if (pendingTextDeltaByThread.size === 0) {
      const activeThreadId = get().currentThreadId;
      if (activeThreadId) promoteDeferredNarrativeEvents(activeThreadId);
      return;
    }
    const batch = new Map<string, PendingTextChunk[]>();
    for (const [tid, chunks] of pendingTextDeltaByThread) {
      batch.set(tid, chunks.map((c) => ({
        delta: c.delta,
        isFinalResponse: c.isFinalResponse,
        deferNarrative: c.deferNarrative,
      })));
    }
    pendingTextDeltaByThread.clear();
    const flushedTextByteSizes = new Map<string, number>();
    set((state) => {
      let records = state.records;
      for (const [tid, chunks] of batch) {
        const rec = getThreadRecord(records, tid);
        let streaming = rec.streaming;
        let streamingPreview = rec.streamingPreview;
        let segments = rec.thoughtSegments;
        let segmentsChanged = false;
        let streamingTextBytes = streamingTextByteSizes.get(tid)
          ?? textEncoder.encode(streaming).byteLength;
        for (const chunk of chunks) {
          const acc = chunk.delta;
          if (!acc) continue;
          const combined = streaming + acc;
          streaming = combined;
          streamingTextBytes += textEncoder.encode(acc).byteLength;
          streamingPreview = combined.length > 200 ? combined.slice(-200) : combined;

          if (chunk.deferNarrative || chunk.isFinalResponse) {
            continue;
          }

          const isExplicitNonFinal = chunk.isFinalResponse === false;
          segments = appendThoughtSegment(segments, acc, isExplicitNonFinal);
          segmentsChanged = true;
        }
        const patch: Partial<ThreadRecord> = {
          streaming,
          streamingPreview,
        };
        if (segmentsChanged) {
          patch.thoughtSegments = segments;
        }
        records = patchThreadRecord(records, tid, patch);
        streamingTextByteSizes.set(tid, streamingTextBytes);
        flushedTextByteSizes.set(tid, streamingTextBytes);
      }
      return { records };
    });
    for (const [threadId, bytes] of flushedTextByteSizes) {
      setConversationTransientTextBytes(threadId, bytes);
    }

    const activeThreadId = get().currentThreadId;
    if (activeThreadId) promoteDeferredNarrativeEvents(activeThreadId);
  };

  const applyDeferredNarrativeEvent = (threadId: string, event: AgentEvent): void => {
    if (event.type === "textDelta") {
      const delta = typeof event.delta === "string" ? event.delta : "";
      if (!delta || event.isFinalResponse === true) return;
      set((state) => {
        const record = getThreadRecord(state.records, threadId);
        return {
          records: patchThreadRecord(state.records, threadId, {
            thoughtSegments: appendThoughtSegment(
              record.thoughtSegments,
              delta,
              event.isFinalResponse === false,
            ),
          }),
        };
      });
    } else if (event.type === "assistantMessageBoundary") {
      const isFinalResponse = event.isFinalResponse === true;
      set((state) => {
        const record = getThreadRecord(state.records, threadId);
        const thoughtSegments = projectAssistantMessageBoundary(record.thoughtSegments, isFinalResponse);
        return thoughtSegments
          ? { records: patchThreadRecord(state.records, threadId, { thoughtSegments }) }
          : state;
      });
    } else if (event.type === "toolProgress") {
      const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
      if (!toolCallId) return;
      const elapsedSeconds = typeof event.elapsedSeconds === "number" ? event.elapsedSeconds : 0;
      const lastActivityAt = Date.now();
      set((state) => {
        const current = getThreadRecord(state.records, threadId).toolCalls;
        const toolCalls = projectToolProgress(current, toolCallId, elapsedSeconds, lastActivityAt);
        return toolCalls
          ? { records: patchThreadRecord(state.records, threadId, { toolCalls }) }
          : state;
      });
    }
  };

  const promoteDeferredNarrativeEvents = (threadId: string): void => {
    const queued = deferredNarrativeEventsByThread.get(threadId);
    if (!queued || queued.events.length === 0) return;
    deferredNarrativeEventsByThread.delete(threadId);
    if (queued.generation !== (deferredNarrativeGenerations.get(threadId) ?? 0)) {
      if (!pendingTextDeltaByThread.has(threadId) && !get().runningThreadIds.has(threadId)) {
        deferredNarrativeGenerations.delete(threadId);
      }
      return;
    }
    for (const event of queued.events) {
      applyDeferredNarrativeEvent(threadId, event);
    }
    if (!pendingTextDeltaByThread.has(threadId) && !get().runningThreadIds.has(threadId)) {
      deferredNarrativeGenerations.delete(threadId);
    }
  };

  const deferredNarrativeEventBytes = (event: AgentEvent): number => {
    if (event.type === "textDelta") {
      return (typeof event.delta === "string" ? event.delta.length : 0) * 2 + 32;
    }
    if (event.type === "toolProgress") {
      const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
      const toolName = typeof event.toolName === "string" ? event.toolName : "";
      return 64 + toolCallId.length * 2 + toolName.length * 2;
    }
    if (event.type === "assistantMessageBoundary") return 48;
    return 64;
  };

  const splitDeferredNarrativeEvent = (event: AgentEvent): AgentEvent[] => {
    if (event.type !== "textDelta") return [event];
    const delta = typeof event.delta === "string" ? event.delta : "";
    const maxDeltaLength = Math.floor((MAX_DEFERRED_NARRATIVE_BYTES - 32) / 2);
    if (delta.length <= maxDeltaLength) return [event];

    const chunks: AgentEvent[] = [];
    for (let offset = 0; offset < delta.length;) {
      let end = Math.min(delta.length, offset + maxDeltaLength);
      if (end < delta.length && end > offset && /[\uD800-\uDBFF]/.test(delta[end - 1] ?? "")) {
        end -= 1;
      }
      chunks.push({ ...event, delta: delta.slice(offset, end) });
      offset = end;
    }
    return chunks;
  };

  const dropPendingTextDeltas = (threadIds: Iterable<string>) => {
    let dropped = false;
    for (const threadId of threadIds) {
      dropped = pendingTextDeltaByThread.delete(threadId) || dropped;
      dropped = deferredNarrativeEventsByThread.delete(threadId) || dropped;
      if (!pendingTextDeltaByThread.has(threadId) && !deferredNarrativeEventsByThread.has(threadId)
        && !get().runningThreadIds.has(threadId)) {
        deferredNarrativeGenerations.delete(threadId);
      }
    }
    if (dropped && pendingTextDeltaByThread.size === 0 && textDeltaFlushRaf != null) {
      cancelAnimationFrame(textDeltaFlushRaf);
      textDeltaFlushRaf = null;
    }
  };

  const invalidateDeferredNarrativeEvents = (threadId: string): void => {
    deferredNarrativeGenerations.set(
      threadId,
      (deferredNarrativeGenerations.get(threadId) ?? 0) + 1,
    );
    dropPendingTextDeltas([threadId]);
    flushPendingTextDeltas();
  };

  const queueDeferredNarrativeEvent = (threadId: string, event: AgentEvent): void => {
    for (const chunk of splitDeferredNarrativeEvent(event)) {
      const generation = deferredNarrativeGenerations.get(threadId) ?? 0;
      const queued = deferredNarrativeEventsByThread.get(threadId);
      const events = queued?.generation === generation ? queued.events : [];
      const bytes = queued?.generation === generation ? queued.bytes : 0;
      const eventBytes = deferredNarrativeEventBytes(chunk);
      if (events.length >= MAX_DEFERRED_NARRATIVE_EVENTS || bytes + eventBytes > MAX_DEFERRED_NARRATIVE_BYTES) {
        promoteDeferredNarrativeEvents(threadId);
      }

      const latest = deferredNarrativeEventsByThread.get(threadId);
      const nextEvents = latest?.generation === generation ? latest.events : [];
      const nextBytes = latest?.generation === generation ? latest.bytes : 0;
      if (eventBytes > MAX_DEFERRED_NARRATIVE_BYTES) {
        applyDeferredNarrativeEvent(threadId, chunk);
        continue;
      }
      deferredNarrativeEventsByThread.set(threadId, {
        generation,
        events: [...nextEvents, chunk],
        bytes: nextBytes + eventBytes,
      });
    }
  };

  const messageSequenceFor = (threadId: string) =>
    getRec(threadId).messages.reduce(
      (latestSequence, message) => Math.max(latestSequence, message.sequence),
      0,
    ) + 1;

  const scheduleTextDeltaFlush = () => {
    if (textDeltaFlushRaf != null) return;
    textDeltaFlushRaf = requestAnimationFrame(() => {
      textDeltaFlushRaf = null;
      flushPendingTextDeltas();
    });
  };

  // The hydrator and residency authorities close over each other for lease guards.
  // eslint-disable-next-line prefer-const
  let conversationResidency: ReturnType<typeof createConversationResidency>;
  const isVisibleConversation = (threadId: string): boolean =>
    conversationResidency?.isConversationVisible(threadId) ?? false;

  const threadHydrator = createThreadHydrator({
    getTransport: () => getTransport(),
    getState: () => get(),
    setState: (partial) => {
      if (typeof partial === "function") {
        set((state) => partial(state as ThreadHydratorWriteState) as Partial<ThreadState>);
      } else {
        set(partial as Partial<ThreadState>);
      }
    },
    getWorkspaceThread: (threadId) =>
      useWorkspaceStore.getState().threads.find((t) => t.id === threadId),
    flushPendingTextDeltas,
    loadNarrativeForMessage: (messageId) => get().loadNarrativeForMessage(messageId),
    setPlanQuestions: (threadId, questions) => get().setPlanQuestions(threadId, questions),
    extractPendingPlanQuestions,
    getTasksForThread: (threadId) => useTaskStore.getState().tasksByThread[threadId] ?? [],
    setTasksForThread: (threadId, tasks) => useTaskStore.getState().setTasks(threadId, tasks),
    addPlanForThread: (threadId, plan) => usePlanStore.getState().addPlan(threadId, plan),
    shallowEqualBy,
    coerceTaskStatus,
    getWorkspaceThreadSettings: resolveWorkspaceThreadSettings,
    isDisplayConversationVisible: isVisibleConversation,
  });
  registerThreadHydrator(threadHydrator);
  conversationResidency = createConversationResidency({
    restoreConversation: (threadId) => {
      setActiveConversation(threadId);
      return threadHydrator.hydrate(threadId, "active");
    },
    refreshConversation: (threadId) => threadHydrator.hydrate(threadId, "active", { force: true }),
    hydrateDisplayConversation: (threadId, generation) => threadHydrator.hydrateResident(threadId, {
      generation,
      isCurrent: () => conversationResidency.isDisplayLeaseCurrent(threadId, generation),
    }),
    onDisplayConversationMounted: (threadId) => promoteDeferredNarrativeEvents(threadId),
    refreshDisplayConversation: (threadId, generation) => threadHydrator.hydrateResident(threadId, {
      generation,
      force: true,
      isCurrent: () => conversationResidency.isDisplayLeaseCurrent(threadId, generation),
    }),
    releaseDisplayConversation: (threadId, generation) => threadHydrator.releaseResident(
      threadId,
      generation,
      () => conversationResidency.isDisplayLeaseCurrent(threadId, generation),
    ),
    getSelectedConversationId: () => get().currentThreadId,
    deactivateConversation: () => {
      setActiveConversation(null);
      const current = get().currentThreadId;
      if (current) invalidateDeferredNarrativeEvents(current);
      threadHydrator.deactivate();
    },
    retainInactiveConversation: (threadId) => threadHydrator.retainInactiveConversation(threadId),
    invalidateConversation: (threadId) => threadHydrator.invalidateConversation(threadId),
    synchronizeConversation: (threadId) => threadHydrator.synchronizeConversation(threadId),
    mergeCachedFileChanges: (threadId, filesChanged) =>
      threadHydrator.mergeCachedFileChanges(threadId, filesChanged),
    takePrefetchedHistoryPage: (identity) =>
      threadHydrator.takePrefetchedHistoryPage(identity),
    prefetchConversation: (threadId) => threadHydrator.hydrate(threadId, "background"),
  });
  registerConversationResidency(conversationResidency);

  const hydratePaginationFileChanges = (
    threadId: string,
    pageMessageIds: ReadonlySet<string>,
    identity: {
      direction: "older" | "newer";
      boundarySequence: number;
      generation: number;
      conversationRevision: number;
    },
  ): void => {
    getTransport()
      .listSnapshots(threadId)
      .then((snapshots) => {
        const relevant = snapshots.filter(
          (snapshot) => snapshot.files_changed.length > 0
            && pageMessageIds.has(snapshot.message_id),
        );
        if (relevant.length === 0) return;

        set((state) => {
          const record = state.records.get(threadId);
          if (
            !conversationResidency.isConversationVisible(threadId)
            || !record
            || (identity.direction === "older" ? record.isLoadingMore : record.isLoadingNewer)
            || (identity.direction === "older"
              ? record.oldestLoadedSequence
              : record.newestLoadedSequence) !== identity.boundarySequence
            || record.loadEpoch !== identity.generation
            || record.conversationRevision !== identity.conversationRevision
          ) return {};

          const retainedMessageIds = new Set(record.messages.map((message) => message.id));
          const retained = relevant.filter((snapshot) =>
            retainedMessageIds.has(snapshot.message_id));
          if (retained.length === 0) return {};

          const nextFilesChanged = { ...record.persistedFilesChanged };
          for (const snapshot of retained) {
            nextFilesChanged[snapshot.message_id] = snapshot.files_changed;
          }
          return {
            records: patchThreadRecord(state.records, threadId, {
              persistedFilesChanged: nextFilesChanged,
            }),
          };
        });

        const current = get().records.get(threadId);
        if (
          !conversationResidency.isConversationVisible(threadId)
          || !current
          || (identity.direction === "older" ? current.isLoadingMore : current.isLoadingNewer)
          || (identity.direction === "older"
            ? current.oldestLoadedSequence
            : current.newestLoadedSequence) !== identity.boundarySequence
          || current.loadEpoch !== identity.generation
          || current.conversationRevision !== identity.conversationRevision + 1
        ) return;

        const retainedMessageIds = new Set(current.messages.map((message) => message.id));
        const retained = relevant.filter((snapshot) =>
          retainedMessageIds.has(snapshot.message_id));
        conversationResidency.mergePaginationFileChanges(
          threadId,
          Object.fromEntries(retained.map((snapshot) => [
            snapshot.message_id,
            snapshot.files_changed,
          ])),
        );
      })
      .catch((error: unknown) => {
        console.warn(`[threadStore] Failed to hydrate pagination snapshots for ${threadId}:`, error);
      });
  };

  return {
    records: new Map<string, ThreadRecord>(),
    currentThreadId: null,
    runningThreadIds: new Set<string>(),
    recapByThread: {},
    toolCallRecordCache: new LruCache<string, ToolCallRecord[]>(TOOL_CALL_CACHE_SIZE),
    recentlyAnsweredPlanMessageIds: new Set<string>(),

  applyCanonicalReconnectRecoveries: (recoveries) => {
    set((state) => {
      let records = state.records;
      let changed = false;
      for (const recovery of recoveries) {
        const current = getThreadRecord(records, recovery.threadId);
        const update = applyCanonicalReconnectRecovery(current.canonicalAgent, recovery);
        if (update.replica === current.canonicalAgent) continue;
        records = patchThreadRecord(records, recovery.threadId, { canonicalAgent: update.replica });
        changed = true;
      }
      return changed ? { records } : {};
    });
  },

  handleCanonicalAgentEvents: (threadId, events) => {
    const stateBeforePush = get();
    if (
      !stateBeforePush.records.has(threadId)
      && stateBeforePush.currentThreadId !== threadId
      && !conversationResidency.isDisplayConversationLeased(threadId)
    ) return;
    let accepted = false;
    set((state) => {
      const current = getThreadRecord(state.records, threadId);
      const update = applyCanonicalPushEvents(current.canonicalAgent, threadId, events);
      if (update.replica === current.canonicalAgent) return {};
      accepted = true;
      return {
        records: patchThreadRecord(state.records, threadId, { canonicalAgent: update.replica }),
      };
    });
    if (
      accepted
      && threadId !== get().currentThreadId
      && conversationResidency.isDisplayConversationLeased(threadId)
    ) {
      void conversationResidency.refreshVisibleConversation(threadId);
    }
  },

  cacheToolCallRecords: (key, records) => {
    get().toolCallRecordCache.set(key, records);
  },

  getCachedToolCallRecords: (key) => {
    return get().toolCallRecordCache.get(key) ?? null;
  },

  /** Evict the entire tool call record cache. Records are re-fetched on next expand. */
  clearToolCallRecordCache: () => {
    get().toolCallRecordCache.clear();
  },

  applyConversationMemoryPressure: (level) => {
    threadHydrator.applyMemoryPressure(level);
  },

  /**
   * Fetch the next batch of older messages for scroll-up pagination.
   * Uses sequence cursor to load messages older than what is currently in memory.
   * Guards against duplicate in-flight requests and stale thread responses.
   */
  loadOlderMessages: async (threadId) => {
    const rec = getRec(threadId);
    if (!rec.hasMoreMessages) return;
    if (rec.isLoadingMore) return;

    const requestRecord = getRec(threadId);
    const cursor = requestRecord.oldestLoadedSequence;
    const epoch = requestRecord.loadEpoch;
    const request = {
      threadId,
      cursor: { version: 1 as const, beforeSequence: cursor },
      direction: "older" as const,
      generation: epoch,
      conversationRevision: requestRecord.conversationRevision,
      limit: HISTORY_PAGE_SIZE,
      maxBytes: CONVERSATION_HISTORY_PAGE_MAX_BYTES,
    };
    const requestHandle = conversationResidency.beginHistoryPageRequest(request);
    if (!requestHandle) return;
    patchRec(threadId, { isLoadingMore: true });

    try {
      const prefetchedPage = conversationResidency.takePrefetchedHistoryPage(request);
      const {
        identity: responseIdentity,
        messages: olderMessages,
        hasMore,
        answeredPlanMessageIds,
        narrativeByMessage,
      } = prefetchedPage
        ?? await getTransport().loadOlderConversationPage(request);

      const currentRecord = getRec(threadId);
      const currentIdentity = {
        threadId,
        cursor: { version: 1 as const, beforeSequence: currentRecord.oldestLoadedSequence },
        direction: "older" as const,
        generation: currentRecord.loadEpoch,
        conversationRevision: currentRecord.conversationRevision,
      };
      const ownsCurrentRequest = conversationResidency.canCommitHistoryPageRequest(
        requestHandle,
        currentIdentity,
        responseIdentity,
      );
      if (!conversationResidency.isConversationVisible(threadId)) {
        if (ownsCurrentRequest) patchRec(threadId, { isLoadingMore: false });
        return;
      }
      if (!ownsCurrentRequest) return;

      const newCounts: Record<string, number> = {};
      for (const msg of olderMessages) {
        if (msg.tool_call_count && msg.tool_call_count > 0) {
          newCounts[msg.id] = msg.tool_call_count;
        }
      }

      patchRec(threadId, (r) => ({
        ...(() => {
          const merged = mergeConversationWindow(threadId, r.messages, olderMessages, "older");
          const retainedMessageIds = new Set(merged.messages.map((message) => message.id));
          return {
            messages: merged.messages,
            persistedToolCallCounts: filterPaginationMetadata(
              { ...newCounts, ...r.persistedToolCallCounts },
              retainedMessageIds,
            ),
            persistedFilesChanged: filterPaginationMetadata(
              r.persistedFilesChanged,
              retainedMessageIds,
            ),
            serverMessageIds: filterPaginationMetadata(r.serverMessageIds, retainedMessageIds),
            narrativeByMessage: selectConversationNarrative(
              filterPaginationMetadata(
                { ...narrativeByMessage, ...r.narrativeByMessage },
                retainedMessageIds,
              ),
              merged.messages,
              {
                anchorMessageId: recallScrollPosition(threadId)?.anchorMessageId,
                maxBytes: CONVERSATION_NARRATIVE_BYTES,
              },
            ),
            answeredPlanMessageIds: new Set([
              ...r.answeredPlanMessageIds,
              ...(answeredPlanMessageIds ?? []),
            ].filter((messageId) => retainedMessageIds.has(messageId))),
            assistantResponseKeys: pruneAssistantResponseKeys(
              r.assistantResponseKeys,
              merged.messages,
            ),
            latestTurnWithChanges: r.latestTurnWithChanges
              && retainedMessageIds.has(r.latestTurnWithChanges)
              ? r.latestTurnWithChanges
              : null,
            oldestLoadedSequence: merged.messages[0]?.sequence ?? cursor,
            newestLoadedSequence: merged.messages.at(-1)?.sequence ?? r.newestLoadedSequence,
            hasMoreMessages: hasMore,
            hasNewerMessages: r.hasNewerMessages || merged.evictedNewer,
            isLoadingMore: false,
          };
        })(),
      }));

      conversationResidency.synchronizeConversation(threadId);
      const committedRecord = getRec(threadId);
      hydratePaginationFileChanges(
        threadId,
        new Set(olderMessages.map((message) => message.id)),
        {
          direction: "older",
          boundarySequence: committedRecord.oldestLoadedSequence,
          generation: committedRecord.loadEpoch,
          conversationRevision: committedRecord.conversationRevision,
        },
      );
    } catch {
      const currentRecord = getRec(threadId);
      if (conversationResidency.canCommitHistoryPageRequest(requestHandle, {
        threadId,
        cursor: { version: 1, beforeSequence: currentRecord.oldestLoadedSequence },
        direction: "older",
        generation: currentRecord.loadEpoch,
        conversationRevision: currentRecord.conversationRevision,
      })) {
        patchRec(threadId, { isLoadingMore: false });
      }
    } finally {
      conversationResidency.finishHistoryPageRequest(requestHandle);
    }
  },

  /** Fetch the next batch below the resident window after newer rows were evicted. */
  loadNewerMessages: async (threadId) => {
    const rec = getRec(threadId);
    if (!rec.hasNewerMessages || rec.isLoadingNewer) return;

    const requestRecord = getRec(threadId);
    const cursor = requestRecord.newestLoadedSequence;
    const epoch = requestRecord.loadEpoch;
    const request = {
      threadId,
      cursor: { version: 1 as const, afterSequence: cursor },
      direction: "newer" as const,
      generation: epoch,
      conversationRevision: requestRecord.conversationRevision,
      limit: HISTORY_PAGE_SIZE,
      maxBytes: CONVERSATION_HISTORY_PAGE_MAX_BYTES,
    };
    const requestHandle = conversationResidency.beginHistoryPageRequest(request);
    if (!requestHandle) return;
    patchRec(threadId, { isLoadingNewer: true });

    try {
      const {
        identity: responseIdentity,
        messages: newerMessages,
        hasMore,
        answeredPlanMessageIds,
        narrativeByMessage,
      } = await getTransport().loadNewerConversationPage(request);

      const currentRecord = getRec(threadId);
      const currentIdentity = {
        threadId,
        cursor: { version: 1 as const, afterSequence: currentRecord.newestLoadedSequence },
        direction: "newer" as const,
        generation: currentRecord.loadEpoch,
        conversationRevision: currentRecord.conversationRevision,
      };
      const ownsCurrentRequest = conversationResidency.canCommitHistoryPageRequest(
        requestHandle,
        currentIdentity,
        responseIdentity,
      );
      if (!conversationResidency.isConversationVisible(threadId)) {
        if (ownsCurrentRequest) patchRec(threadId, { isLoadingNewer: false });
        return;
      }
      if (!ownsCurrentRequest) return;

      const newCounts: Record<string, number> = {};
      for (const message of newerMessages) {
        if (message.tool_call_count && message.tool_call_count > 0) {
          newCounts[message.id] = message.tool_call_count;
        }
      }

      patchRec(threadId, (r) => ({
        ...(() => {
          const merged = mergeConversationWindow(threadId, r.messages, newerMessages, "newer");
          const retainedMessageIds = new Set(merged.messages.map((message) => message.id));
          return {
            messages: merged.messages,
            persistedToolCallCounts: filterPaginationMetadata(
              { ...newCounts, ...r.persistedToolCallCounts },
              retainedMessageIds,
            ),
            persistedFilesChanged: filterPaginationMetadata(
              r.persistedFilesChanged,
              retainedMessageIds,
            ),
            serverMessageIds: filterPaginationMetadata(r.serverMessageIds, retainedMessageIds),
            narrativeByMessage: selectConversationNarrative(
              filterPaginationMetadata(
                { ...narrativeByMessage, ...r.narrativeByMessage },
                retainedMessageIds,
              ),
              merged.messages,
              {
                anchorMessageId: recallScrollPosition(threadId)?.anchorMessageId,
                maxBytes: CONVERSATION_NARRATIVE_BYTES,
              },
            ),
            answeredPlanMessageIds: new Set([
              ...r.answeredPlanMessageIds,
              ...(answeredPlanMessageIds ?? []),
            ].filter((messageId) => retainedMessageIds.has(messageId))),
            assistantResponseKeys: pruneAssistantResponseKeys(
              r.assistantResponseKeys,
              merged.messages,
            ),
            latestTurnWithChanges: r.latestTurnWithChanges
              && retainedMessageIds.has(r.latestTurnWithChanges)
              ? r.latestTurnWithChanges
              : null,
            oldestLoadedSequence: merged.messages[0]?.sequence ?? r.oldestLoadedSequence,
            newestLoadedSequence: merged.messages.at(-1)?.sequence ?? cursor,
            hasMoreMessages: r.hasMoreMessages || merged.evictedOlder,
            hasNewerMessages: hasMore,
            isLoadingNewer: false,
          };
        })(),
      }));

      conversationResidency.synchronizeConversation(threadId);
      const committedRecord = getRec(threadId);
      hydratePaginationFileChanges(
        threadId,
        new Set(newerMessages.map((message) => message.id)),
        {
          direction: "newer",
          boundarySequence: committedRecord.newestLoadedSequence,
          generation: committedRecord.loadEpoch,
          conversationRevision: committedRecord.conversationRevision,
        },
      );
    } catch {
      const currentRecord = getRec(threadId);
      if (conversationResidency.canCommitHistoryPageRequest(requestHandle, {
        threadId,
        cursor: { version: 1, afterSequence: currentRecord.newestLoadedSequence },
        direction: "newer",
        generation: currentRecord.loadEpoch,
        conversationRevision: currentRecord.conversationRevision,
      })) {
        patchRec(threadId, { isLoadingNewer: false });
      }
    } finally {
      conversationResidency.finishHistoryPageRequest(requestHandle);
    }
  },

  /**
   * Send a user message and start the agent. Optimistically appends the
   * message to local state, marks the thread as running, then dispatches
   * to the transport layer. On failure, rolls back the running state.
   */
  sendMessage: async (threadId, content, model, permissionMode, attachments, displayContent, reasoningLevel, provider, copilotAgent, contextWindow, thinking, codexFastMode, replyToMessageId, quotedText, planAction, mentions, previewAnnotations, goalObjective, orchestrationMode) => {
    conversationResidency.invalidateConversation(threadId);

    // A `/goal` control form (show/clear/reset/bare) never starts a provider
    // turn - the server services it synchronously and returns. It must not
    // touch turn running-state: marking an idle thread running would strand it
    // (no Ended clears it, by design - see goal-command.ts), and on send
    // failure the rollback below must not clear the running-state of a real
    // turn the control command was issued against mid-flight (#583).
    const isControlCommand = isGoalControlCommand(content);
    const runningBeforeControl = isControlCommand
      ? new Set(get().runningThreadIds)
      : undefined;
    if (!isControlCommand && get().runningThreadIds.has(threadId)) {
      throw new Error(`Thread ${threadId} already has an active agent session`);
    }
    if (!isControlCommand) {
      invalidateDeferredNarrativeEvents(threadId);
      useTaskStore.getState().prepareTaskBubbleForNewTurn(threadId);
    }

    const storedComposerAttachments =
      attachments?.map((a) => ({
        id: a.id,
        name: a.name,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
      })) ?? [];
    const storedPreviewAnnotationAttachments =
      previewAnnotationSnapshotStoredAttachments(previewAnnotations);
    const visibleAttachments = [
      ...storedComposerAttachments,
      ...storedPreviewAnnotationAttachments,
    ];
    const optimisticTurnResponseKey = createTurnResponseKey(threadId);
    const optimisticTurnExecutionId = isControlCommand ? getRec(threadId).turnExecutionId : null;

    // Add user message to local state immediately (optimistic)
    // Use displayContent for the UI (without injected file blocks) if provided
    const userMessage: Message = {
      id: crypto.randomUUID(),
      thread_id: threadId,
      role: "user",
      content: displayContent ?? content,
      tool_calls: null,
      files_changed: null,
      cost_usd: null,
      tokens_used: null,
      timestamp: new Date().toISOString(),
      sequence: messageSequenceFor(threadId),
      attachments: visibleAttachments.length > 0 ? visibleAttachments : null,
      previewAnnotations: previewAnnotations ?? null,
      mentions: mentions && mentions.length > 0 ? mentions : null,
      reply_to_message_id: replyToMessageId ?? null,
      quoted_text: quotedText ?? null,
    };

    set((state) => {
      const settingsPatch =
        reasoningLevel !== undefined ||
        orchestrationMode !== undefined ||
        contextWindow !== undefined ||
        thinking !== undefined ||
        codexFastMode !== undefined
          ? {
              settings: {
                ...state.getThreadSettings(threadId),
                ...(reasoningLevel !== undefined && { reasoningLevel }),
                ...(orchestrationMode !== undefined && { orchestrationMode }),
                ...(contextWindow !== undefined && { contextWindow }),
                ...(thinking !== undefined && { thinking }),
                ...(codexFastMode !== undefined && { codexFastMode }),
              },
            }
          : {};

      const messagePatch =
        state.currentThreadId === threadId
          ? (() => {
              const rec = getThreadRecord(state.records, threadId);
              const { messages: capped, evicted } = capMessages([...rec.messages, userMessage]);
              return {
                messages: capped,
                ...(evicted ? { hasMoreMessages: true } : {}),
              };
            })()
          : {};

      const rec = getThreadRecord(state.records, threadId);
      return {
        records: patchThreadRecord(state.records, threadId, {
          ...resetTurnEphemeral(rec),
          ...settingsPatch,
          ...messagePatch,
          agentStartTime: Date.now(),
          fileEffectSummary: { revision: 0, fileCount: 0, additions: 0, deletions: 0, effects: [] },
          currentTurnResponseKey: optimisticTurnResponseKey,
          ...(isControlCommand ? {} : { turnExecutionId: null }),
          lastFallback: undefined,
          rateLimit: undefined,
          apiRetry: undefined,
          error: null,
          runtimePhase: isControlCommand ? rec.runtimePhase : "running",
        }),
      };
    });

    try {
      const { interactionMode } = get().getThreadSettings(threadId);
      await getTransport().sendMessage({
        threadId,
        content,
        messageId: userMessage.id,
        model,
        permissionMode,
        attachments,
        displayContent,
        reasoningLevel,
        provider: provider === undefined ? undefined : ProviderIdSchema.parse(provider),
        interactionMode,
        copilotAgent,
        contextWindow,
        thinking,
        codexFastMode,
        replyToMessageId,
        quotedText,
        planAction,
        mentions,
        previewAnnotations,
        goalObjective,
        orchestrationMode,
      });
    } catch (e) {
      if (planAction === "revise") {
        usePlanStore.getState().setGenerating(threadId, false);
      }
      const error = String(e);
      const activeSessionConflict =
        !isControlCommand && error.includes("already has an active agent session");
      set((state) => {
        const currentRecord = getThreadRecord(state.records, threadId);
        const ownsOnlyOptimisticRuntime = !isControlCommand
          && !activeSessionConflict
          && currentRecord.currentTurnResponseKey === optimisticTurnResponseKey
          && currentRecord.turnExecutionId === optimisticTurnExecutionId
          && currentRecord.runtimePhase === "running";
        // Control commands never added the thread to running-state, so leave it
        // untouched on rollback - a real turn in flight may own it (#583).
        return {
          records: patchThreadRecord(state.records, threadId, (rec) => ({
            error,
            ...(activeSessionConflict && state.currentThreadId === threadId
              ? { messages: rec.messages.filter((m) => m.id !== userMessage.id) }
              : {}),
            ...(ownsOnlyOptimisticRuntime ? { agentStartTime: undefined } : {}),
            ...(ownsOnlyOptimisticRuntime ? { runtimePhase: "errored" as const } : {}),
          })),
        };
      });
      if (isControlCommand && runningBeforeControl?.has(threadId) && !get().runningThreadIds.has(threadId)) {
        set((state) => ({ runningThreadIds: new Set([...state.runningThreadIds, threadId]) }));
      }
      if (!activeSessionConflict && !isControlCommand) {
        invalidateDeferredNarrativeEvents(threadId);
      }
    }
  },

  /** Request exact active turn stop and apply authoritative runtime result. */
  stopAgent: async (threadId) => {
    const wasRunning = get().runningThreadIds.has(threadId);
    patchRec(threadId, { awaitingUserStopPersist: true, composerRecallFromStop: undefined });
    try {
      const result = await getTransport().stopAgent(threadId);
      get().applyThreadRuntimeSnapshot(result.snapshot);

      let lastUserText: string | null = null;
      if (result.status === "cancelled"
        && result.dispatchState === "not-dispatched"
        && result.snapshot.phase === "cancelled"
        && get().currentThreadId === threadId) {
        const messages = getRec(threadId).messages;
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === "user") {
            lastUserText = messages[i].content;
            break;
          }
        }
      }
      if (lastUserText !== null) {
        patchRec(threadId, { composerRecallFromStop: { text: lastUserText } });
      }
    } catch (e) {
      patchRec(threadId, () => ({
        error: String(e),
        awaitingUserStopPersist: undefined,
        ...(wasRunning ? { runtimePhase: "running" as const } : {}),
      }));
      if (wasRunning && !get().runningThreadIds.has(threadId)) {
        set((state) => ({ runningThreadIds: new Set([...state.runningThreadIds, threadId]) }));
      }
    }
    invalidateDeferredNarrativeEvents(threadId);
    threadHydrator.invalidatePermissionSnapshots(threadId);
  },

  applyThreadRuntimeSnapshot: (snapshot) => {
    const running = snapshot.phase === "running" || snapshot.phase === "finalizing";
    set((state) => {
      const nextRunning = new Set(state.runningThreadIds);
      if (running) nextRunning.add(snapshot.threadId);
      else nextRunning.delete(snapshot.threadId);
      return {
        runningThreadIds: nextRunning,
        records: patchThreadRecord(state.records, snapshot.threadId, (rec) => ({
          ...(running ? {} : resetTurnEphemeral(rec)),
          turnExecutionId: snapshot.turnExecutionId,
          runtimePhase: snapshot.phase,
          awaitingUserStopPersist: undefined,
          rateLimit: undefined,
          apiRetry: undefined,
        })),
      };
    });
  },

  transferThreadRuntime: (placeholderId, persistedId) => {
    set((state) => {
      const records = transferThreadRuntime(
        state.records,
        placeholderId,
        persistedId,
        state.runningThreadIds.has(placeholderId),
      );
      if (records === state.records) return {};
      const nextRunning = new Set(state.runningThreadIds);
      nextRunning.delete(placeholderId);
      const persistedRecord = getThreadRecord(records, persistedId);
      if (persistedRecord.runtimePhase === "running" || persistedRecord.runtimePhase === "finalizing") {
        nextRunning.add(persistedId);
      } else {
        nextRunning.delete(persistedId);
      }
      return { records, runningThreadIds: nextRunning };
    });
  },

  hydrateRunningThreads: (ids, observed) => {
    const resetPendingIds = new Set<string>();
    set((state) => {
      const current = state.runningThreadIds;
      if (current.size === ids.length && ids.every((id) => current.has(id))) {
        return {};
      }
      const now = Date.now();
      const nextIds = new Set(ids);
      let records = state.records;
      for (const id of current) {
        if (!nextIds.has(id)) {
          const observation = observed?.get(id);
          const currentRecord = getThreadRecord(records, id);
          if (observed && (!observation
            || currentRecord.turnExecutionId !== observation.turnExecutionId
            || currentRecord.runtimePhase !== observation.runtimePhase)) {
            nextIds.add(id);
            continue;
          }
          resetPendingIds.add(id);
          records = patchThreadRecord(records, id, {
            ...resetTurnEphemeral(currentRecord),
            runtimePhase: "idle",
          });
        }
      }
      for (const id of ids) {
        const rec = getThreadRecord(records, id);
        const isNewlyRunning = !current.has(id);
        if (isNewlyRunning) {
          resetPendingIds.add(id);
          records = patchThreadRecord(records, id, {
            ...resetTurnEphemeral(rec),
            turnExecutionId: rec.turnExecutionId,
            runtimePhase: "running",
            currentTurnResponseKey: createTurnResponseKey(id),
            agentStartTime: rec.agentStartTime ?? now,
          });
        } else if (rec.agentStartTime === undefined || rec.runtimePhase !== "running") {
          records = patchThreadRecord(records, id, {
            ...(rec.agentStartTime === undefined ? { agentStartTime: now } : {}),
            turnExecutionId: rec.turnExecutionId,
            runtimePhase: "running",
          });
        }
      }
      return { records, runningThreadIds: nextIds };
    });
    for (const threadId of resetPendingIds) {
      clearStreamingTextUsage(threadId);
      invalidateDeferredNarrativeEvents(threadId);
      threadHydrator.invalidatePermissionSnapshots(threadId);
    }
  },

  hydrateThreadRuntimes: (snapshots, observed) => {
    const currentRecords = get().records;
    const acceptedSnapshots = observed
      ? snapshots.filter((snapshot) => {
        const observation = observed.get(snapshot.threadId);
        if (!observation) return true;
        const currentRecord = getThreadRecord(currentRecords, snapshot.threadId);
        const advanced = currentRecord.turnExecutionId !== observation.turnExecutionId
          || currentRecord.runtimePhase !== observation.runtimePhase;
        return !advanced
          || (currentRecord.turnExecutionId === snapshot.turnExecutionId
            && currentRecord.runtimePhase === snapshot.phase);
      })
      : snapshots;
    const runningThreadIds = acceptedSnapshots
      .filter((snapshot) => snapshot.phase === "running" || snapshot.phase === "finalizing")
      .map((snapshot) => snapshot.threadId);
    get().hydrateRunningThreads(runningThreadIds, observed);
    set((state) => {
      let records = state.records;
      for (const snapshot of acceptedSnapshots) {
        records = patchThreadRecord(records, snapshot.threadId, {
          turnExecutionId: snapshot.turnExecutionId,
          runtimePhase: snapshot.phase,
          ...((snapshot.phase === "running" || snapshot.phase === "finalizing") && {
            agentStartTime: getThreadRecord(records, snapshot.threadId).agentStartTime ?? Date.now(),
          }),
        });
      }
      return { records };
    });
  },

  /** Append a single message to the current thread's message list. */
  addMessage: (message) => {
    const current = get().currentThreadId;
    if (!current) return;
    patchRec(current, (rec) => {
      const { messages: capped, evicted } = capMessages([...rec.messages, message]);
      return {
        messages: capped,
        ...(evicted ? { hasMoreMessages: true } : {}),
      };
    });
  },

  removePersistedMessage: (threadId, messageId) => {
    conversationResidency.invalidateConversation(threadId);
    set((state) => {
      const record = state.records.get(threadId);
      if (!record || !record.messages.some((message) => message.id === messageId)) return state;
      return {
        records: patchThreadRecord(state.records, threadId, {
          messages: record.messages.filter((message) => message.id !== messageId),
        }),
      };
    });
  },

  /**
   * Reset the active thread's message list and ephemeral streaming state.
   * Does NOT reset runningThreadIds since agents may still be executing.
   */
  clearMessages: () => {
    const current = get().currentThreadId;
    if (current) {
      invalidateDeferredNarrativeEvents(current);
      conversationResidency.invalidateConversation(current);
    }
    flushPendingTextDeltas();
    if (current) clearStreamingTextUsage(current);

    get().toolCallRecordCache.clear();
    if (current) {
      set((state) => ({
        records: patchThreadRecord(state.records, current, {
          messages: [],
          error: null,
          streaming: "",
          streamingPreview: "",
          toolCalls: [],
          currentTurnMessageId: "",
          pendingTurnPersistMessageIds: [],
          currentTurnResponseKey: "",
          assistantResponseKeys: {},
          oldestLoadedSequence: 0,
          newestLoadedSequence: 0,
          hasMoreMessages: false,
          hasNewerMessages: false,
          isLoadingMore: false,
          isLoadingNewer: false,
          loadEpoch: getThreadRecord(state.records, current).loadEpoch,
          persistedToolCallCounts: {},
          persistedFilesChanged: {},
          latestTurnWithChanges: null,
          serverMessageIds: {},
          narrativeByMessage: {},
          lastAgentEventEpoch: undefined,
          lastAgentEventSequence: undefined,
        }),
      }));
    }
  },

  deactivateConversation: () => {
    const current = get().currentThreadId;
    if (current) invalidateDeferredNarrativeEvents(current);
    threadHydrator.deactivate();
  },

  /** Check whether an agent is currently executing on the given thread. */
  isThreadRunning: (threadId) => {
    return get().runningThreadIds.has(threadId);
  },

  /** Return per-thread settings, preferring in-memory overrides then DB-persisted values then defaults. */
  getThreadSettings: (threadId) => {
    const stored = get().records.get(threadId);
    if (stored) return stored.settings;

    // Hydrate from the thread's DB-persisted fields
    return resolveWorkspaceThreadSettings(threadId);
  },

  /**
   * Merge partial settings into the per-thread settings record and persist to the server.
   * Returns a Promise that resolves to true on success or false if the RPC fails.
   * undefined values in `settings` mean "don't change", not "clear".
   */
  setThreadSettings: (threadId, settings) => {
    // Build a clean patch with only explicitly-provided fields.
    // undefined means "don't change", not "clear". If we naively spread
    // settings, undefined values would overwrite the existing in-memory
    // state without being sent to the DB, causing divergence on reload.
    const patch: Partial<ThreadSettings> = {};
    if (settings.permissionMode !== undefined) patch.permissionMode = settings.permissionMode;
    if (settings.interactionMode !== undefined) patch.interactionMode = settings.interactionMode;
    if (settings.orchestrationMode !== undefined) patch.orchestrationMode = settings.orchestrationMode;
    if (settings.reasoningLevel !== undefined) patch.reasoningLevel = settings.reasoningLevel;
    // Use `in` check so explicit null clears the agent (null !== undefined).
    if ("copilotAgent" in settings) patch.copilotAgent = settings.copilotAgent;
    // null clears the override so the thread inherits from the global default.
    if ("contextWindow" in settings) patch.contextWindow = settings.contextWindow;
    if ("thinking" in settings) patch.thinking = settings.thinking;
    if ("codexFastMode" in settings) patch.codexFastMode = settings.codexFastMode;
    // null clears the override so the thread inherits the global default.
    if ("defaultOpenInApp" in settings) patch.defaultOpenInApp = settings.defaultOpenInApp;

    if (Object.keys(patch).length === 0) return Promise.resolve(false);

    set((state) => ({
      records: patchThreadRecord(state.records, threadId, {
        settings: { ...state.getThreadSettings(threadId), ...patch },
      }),
    }));

    // Also mirror the patch into workspaceStore.threads so the cached
    // thread object stays in sync. Composer's no-draft hydration path
    // reads from that cache directly (permission_mode, interaction_mode,
    // reasoning_level, copilot_agent), so failing to sync here causes
    // the UI to revert to stale DB values on thread re-entry.
    useWorkspaceStore.setState((state) => ({
      threads: state.threads.map((t) =>
        t.id === threadId
          ? {
              ...t,
              ...(patch.permissionMode !== undefined && { permission_mode: patch.permissionMode }),
              ...(patch.interactionMode !== undefined && { interaction_mode: patch.interactionMode }),
              ...(patch.orchestrationMode !== undefined && { orchestration_mode: patch.orchestrationMode }),
              ...(patch.reasoningLevel !== undefined && { reasoning_level: patch.reasoningLevel }),
              ...("copilotAgent" in patch && { copilot_agent: patch.copilotAgent ?? null }),
              ...("contextWindow" in patch && { context_window_mode: patch.contextWindow ?? null }),
              ...("thinking" in patch && { thinking: patch.thinking ?? null }),
              ...("codexFastMode" in patch && { codex_fast_mode: patch.codexFastMode ?? null }),
              ...("defaultOpenInApp" in patch && { default_open_in_app: patch.defaultOpenInApp ?? null }),
            }
          : t,
      ),
    }));

    // copilotAgent / contextWindow / thinking: null clears the persisted value; undefined means don't change.
    const transportPatch: {
      reasoningLevel?: ThreadSettings["reasoningLevel"];
      interactionMode?: ThreadSettings["interactionMode"];
      orchestrationMode?: ThreadSettings["orchestrationMode"];
      permissionMode?: ThreadSettings["permissionMode"];
      copilotAgent?: string | null;
      contextWindow?: ContextWindowMode | null;
      thinking?: boolean | null;
      codexFastMode?: boolean | null;
      defaultOpenInApp?: string | null;
    } = {
      ...(patch.permissionMode !== undefined ? { permissionMode: patch.permissionMode } : {}),
      ...(patch.interactionMode !== undefined ? { interactionMode: patch.interactionMode } : {}),
      ...(patch.orchestrationMode !== undefined ? { orchestrationMode: patch.orchestrationMode } : {}),
      ...(patch.reasoningLevel !== undefined ? { reasoningLevel: patch.reasoningLevel } : {}),
      ...("copilotAgent" in patch ? { copilotAgent: patch.copilotAgent } : {}),
      ...("contextWindow" in patch ? { contextWindow: patch.contextWindow } : {}),
      ...("thinking" in patch ? { thinking: patch.thinking } : {}),
      ...("codexFastMode" in patch ? { codexFastMode: patch.codexFastMode } : {}),
      ...("defaultOpenInApp" in patch ? { defaultOpenInApp: patch.defaultOpenInApp } : {}),
    };
    return getTransport().updateThreadSettings(threadId, transportPatch).catch(() => false);
  },

  clearThreadState: (threadId) => {
    conversationResidency.invalidateConversation(threadId);
    clearNarrativeLoadState(threadId);
    clearDequeueTimer(threadId);
    invalidateDeferredNarrativeEvents(threadId);
    threadHydrator.forgetThread(threadId);
    forgetScrollTop(threadId);

    const isCurrentThread = get().currentThreadId === threadId;

    set((state) => {
      const recapByThread = { ...state.recapByThread };
      delete recapByThread[threadId];

      return {
        records: deleteThreadRecord(state.records, threadId),
        recapByThread,
        ...(isCurrentThread ? { currentThreadId: null } : {}),
      };
    });
    deferredNarrativeGenerations.delete(threadId);

    if (isCurrentThread) {
      get().toolCallRecordCache.clear();
    }
  },

  clearThreadStateMany: (threadIds) => {
    if (threadIds.length === 0) return;

    for (const threadId of threadIds) {
      conversationResidency.invalidateConversation(threadId);
      clearNarrativeLoadState(threadId);
      clearDequeueTimer(threadId);
      invalidateDeferredNarrativeEvents(threadId);
      threadHydrator.forgetThread(threadId);
      forgetScrollTop(threadId);
    }

    const currentThreadId = get().currentThreadId;
    const deletingCurrentThread = currentThreadId !== null && threadIds.includes(currentThreadId);

    set((state) => {

      const idsToDelete = new Set(threadIds);
      let records = state.records;
      for (const threadId of threadIds) {
        records = deleteThreadRecord(records, threadId);
      }
      const recapByThread: Record<string, ThreadRecapCacheEntry> = {};
      for (const [threadId, entry] of Object.entries(state.recapByThread)) {
        if (!idsToDelete.has(threadId)) {
          recapByThread[threadId] = entry;
        }
      }

      return {
        records,
        recapByThread,
        ...(deletingCurrentThread ? { currentThreadId: null } : {}),
      };
    });
    for (const threadId of threadIds) deferredNarrativeGenerations.delete(threadId);

    if (deletingCurrentThread) {
      get().toolCallRecordCache.clear();
    }
  },

  setHandoffMeta: (threadId, meta) => {
    patchRec(threadId, { handoffMeta: meta });
  },

  setHandoffStatus: (threadId, status) => {
    patchRec(threadId, (rec) => ({
      handoffMeta: { ...rec.handoffMeta, status },
    }));
  },

  setForkMode: (threadId, forkState) => {
    patchRec(threadId, { forkMode: forkState });
  },

  setPlanQuestions: (threadId, questions) => {
    patchRec(threadId, {
      planQuestions: questions,
      planAnswers: new Map(),
      activeQuestionIndex: 0,
      planQuestionsStatus: "pending",
    });
  },

  setPlanAnswer: (threadId, questionId, answer) => {
    patchRec(threadId, (rec) => {
      const updated = new Map(rec.planAnswers);
      updated.set(questionId, answer);
      return { planAnswers: updated };
    });
  },

  setActiveQuestionIndex: (threadId, index) => {
    patchRec(threadId, { activeQuestionIndex: index });
  },

  submitPlanAnswers: async (threadId) => {
    const rec = getRec(threadId);
    const answersMap = rec.planAnswers;
    const questions = rec.planQuestions ?? [];
    const { permissionMode, reasoningLevel, contextWindow, thinking } = get().getThreadSettings(threadId);

    const answers: PlanAnswer[] = questions.map((q) => {
      const a = answersMap.get(q.id);
      return a ?? { questionId: q.id, selectedOptionId: null, freeText: null };
    });

    set((s) => ({
      records: patchThreadRecord(s.records, threadId, {
        planQuestionsStatus: "answered",
        agentStartTime: Date.now(),
      }),
    }));
    usePlanStore.getState().setGenerating(threadId, true);

    try {
      await getTransport().answerPlanQuestions(
        threadId,
        answers,
        permissionMode,
        reasoningLevel,
        contextWindow ?? undefined,
        thinking ?? undefined,
      );
    } catch (e) {
      usePlanStore.getState().setGenerating(threadId, false);
      set((s) => ({
        records: patchThreadRecord(s.records, threadId, {
          planQuestionsStatus: "pending",
          error: String(e),
        }),
      }));
    }
  },

  sendPlanAction: async (threadId, content, action) => {
    const { permissionMode, reasoningLevel, contextWindow, thinking } =
      get().getThreadSettings(threadId);
    const thread = useWorkspaceStore.getState().threads.find((t) => t.id === threadId);
    const model = thread?.model ?? undefined;
    const provider = thread?.provider ?? undefined;

    if (action === "revise") {
      usePlanStore.getState().setGenerating(threadId, true);
    } else if (action === "implement") {
      // Implementation runs in build mode; leave plan mode so the composer
      // label and future sends match the execution phase. Await the
      // persistence RPC and abort the implement turn on failure so the
      // local UI cannot diverge from the stored thread row (a stale row
      // would flip the thread back to Plan on reload).
      const persisted = await get().setThreadSettings(threadId, {
        interactionMode: INTERACTION_MODES.BUILD,
      });
      if (!persisted) return;
    }

    await get().sendMessage(
      threadId,
      content,
      model,
      permissionMode,
      undefined,
      undefined,
      reasoningLevel,
      provider,
      undefined,
      contextWindow ?? undefined,
      thinking ?? undefined,
      undefined,
      undefined,
      undefined,
      action,
    );
  },

  clearPlanQuestions: (threadId) => {
    patchRec(threadId, {
      planQuestions: null,
      planAnswers: new Map(),
      activeQuestionIndex: 0,
      planQuestionsStatus: "idle",
    });
    void getTransport()
      .dismissPlanQuestions(threadId)
      .catch((err: unknown) => {
        console.warn("[plan] dismissPlanQuestions failed", err);
      });
  },

  markPlanAnswered: (threadId, assistantMessageId) => {
    set((state) => {
      const rec = getThreadRecord(state.records, threadId);
      const nextSet = new Set(rec.answeredPlanMessageIds);
      nextSet.add(assistantMessageId);
      const nextRecent = new Set(state.recentlyAnsweredPlanMessageIds);
      nextRecent.add(assistantMessageId);
      return {
        records: patchThreadRecord(state.records, threadId, {
          answeredPlanMessageIds: nextSet,
          planQuestions: null,
          planAnswers: new Map(),
          activeQuestionIndex: 0,
          planQuestionsStatus: "idle",
        }),
        recentlyAnsweredPlanMessageIds: nextRecent,
      };
    });
    window.setTimeout(() => {
      set((s) => {
        if (!s.recentlyAnsweredPlanMessageIds.has(assistantMessageId)) return {};
        const next = new Set(s.recentlyAnsweredPlanMessageIds);
        next.delete(assistantMessageId);
        return { recentlyAnsweredPlanMessageIds: next };
      });
    }, 800);
  },

  markPlanDismissed: (threadId, assistantMessageId) => {
    set((state) => {
      const rec = getThreadRecord(state.records, threadId);
      const nextSet = new Set(rec.answeredPlanMessageIds);
      nextSet.add(assistantMessageId);
      return {
        records: patchThreadRecord(state.records, threadId, {
          answeredPlanMessageIds: nextSet,
          planQuestions: null,
          planAnswers: new Map(),
          activeQuestionIndex: 0,
          planQuestionsStatus: "idle",
        }),
      };
    });
  },

  addPermissionRequest: (request) => {
    threadHydrator.invalidatePermissionSnapshots(request.threadId);
    set((s) => {
      const existing = getThreadRecord(s.records, request.threadId).permissions;
      if (existing.some((p) => p.requestId === request.requestId)) return s;
      return {
        records: patchThreadRecord(s.records, request.threadId, {
          permissions: [...existing, { ...request, settled: false }],
        }),
      };
    });
  },

  resolvePermissionRequest: (requestId, decision) => {
    for (const [threadId, rec] of get().records) {
      if (rec.permissions.some((permission) => permission.requestId === requestId)) {
        threadHydrator.invalidatePermissionSnapshots(threadId);
        break;
      }
    }
    set((s) => {
      let records = s.records;
      for (const [threadId, rec] of s.records) {
        const idx = rec.permissions.findIndex((p) => p.requestId === requestId);
        if (idx >= 0) {
          records = patchThreadRecord(records, threadId, {
            permissions: rec.permissions.map((p, i) =>
              i === idx ? { ...p, settled: true, decision } : p,
            ),
          });
          break;
        }
      }
      return { records };
    });
  },

  refreshThreadGoal: async (threadId) => {
    const lookup = await getTransport().getThreadGoal(threadId);
    applyGoalLookup(threadId, lookup);
    return lookup;
  },

  clearThreadGoal: async (threadId) => {
    const lookup = await getTransport().clearThreadGoal(threadId);
    applyGoalLookup(threadId, lookup);
    return lookup;
  },

  loadNarrativeForMessage: async (messageId, explicitThreadId) => {
    const currentId = explicitThreadId ?? get().currentThreadId;
    if (!currentId) return;
    const cacheKey = narrativeKey(currentId, messageId);
    if (narrativeLoaded.has(cacheKey)) return;
    const existing = narrativeInflight.get(messageId);
    if (existing) return existing;
    const p = getTransport()
      .listNarrative(messageId)
      .then((res) => {
        // The request is started by a rendered message. Keep its result when
        // navigation briefly drops the visibility lease during hydration or
        // an Electron restart; otherwise the one-shot request is lost and the
        // persisted timeline never gets another chance to render. The message
        // membership check still prevents a deleted or retired placeholder
        // from being recreated by a late response.
        const current = get().records.get(currentId);
        if (!current || !current.messages.some((message) => message.id === messageId)) return;
        const expectedToolCount = current.persistedToolCallCounts[messageId] ?? 0;
        if (res.tools.length >= expectedToolCount) {
          narrativeLoaded.add(cacheKey);
        }
        patchRec(currentId, (r) => ({
          narrativeByMessage: selectConversationNarrative(
            { ...r.narrativeByMessage, [messageId]: res },
            r.messages,
            {
              anchorMessageId: messageId,
              maxBytes: CONVERSATION_NARRATIVE_BYTES,
            },
          ),
        }));
      })
      .catch((err) => {
        console.warn("[narrative] listNarrative failed", { messageId, err });
      })
      .finally(() => {
        narrativeInflight.delete(messageId);
      });
    narrativeInflight.set(messageId, p);
    return p;
  },

  isNarrativeLoaded: (threadId, messageId) => narrativeLoaded.has(narrativeKey(threadId, messageId)),

  evictNarrativeForMessage: (messageId) => {
    const currentId = get().currentThreadId;
    if (!currentId) return;
    narrativeLoaded.delete(narrativeKey(currentId, messageId));
    patchRec(currentId, (rec) => {
      if (!(messageId in rec.narrativeByMessage)) return {};
      const next = { ...rec.narrativeByMessage };
      delete next[messageId];
      return { narrativeByMessage: next };
    });
  },

  /**
   * Process a real-time agent event (sidecar or legacy CLI format).
   * Updates per-thread streaming text, tool calls, and running state.
   * On turn completion, commits any buffered streaming content as a
   * message and schedules tool call fade-out animations.
   */
  handleAgentEvent: (event) => {
    const { threadId } = event;
    const runtimeRecord = getRec(threadId);
    const runtimeActive = runtimeRecord.runtimePhase === "running"
      || get().runningThreadIds.has(threadId)
      || runtimeRecord.streaming.length > 0;
    const incomingExecutionId = typeof event.turnExecutionId === "string"
      ? event.turnExecutionId
      : undefined;
    if (event.type === "turnStarted") {
      if (runtimeRecord.runtimePhase === "running"
        && runtimeRecord.turnExecutionId
        && incomingExecutionId
        && runtimeRecord.turnExecutionId !== incomingExecutionId) return;
    } else if (incomingExecutionId
      && runtimeRecord.turnExecutionId
      && incomingExecutionId !== runtimeRecord.turnExecutionId) return;
    const eventEpoch = typeof event.epoch === "string" ? event.epoch : undefined;
    const eventSequence = typeof event.sequence === "number" && event.sequence > 0
      ? event.sequence
      : undefined;
    if (eventSequence !== undefined) {
      const record = getRec(threadId);
      const lastSequence = record.lastAgentEventSequence;
      const epochChanged = eventEpoch !== undefined
        && eventEpoch !== record.lastAgentEventEpoch;
      if (!epochChanged && lastSequence !== undefined && eventSequence <= lastSequence) {
        if (get().currentThreadId !== threadId) recordBackgroundEventDropped(threadId);
        return;
      }
      patchRec(threadId, {
        lastAgentEventSequence: eventSequence,
        ...(eventEpoch !== undefined ? { lastAgentEventEpoch: eventEpoch } : {}),
      });
    }
    const currentThreadId = get().currentThreadId;
    // Before conversation hydration, no running IDs means events belong to the
    // only known conversation. Once running sessions are known, null selection
    // must keep background narrative deferred.
    const isActiveThread = currentThreadId === threadId
      || conversationResidency?.isDisplayConversationLeased(threadId) === true
      || (currentThreadId === null && get().runningThreadIds.size === 0);
    const isLifecycleExit = event.type === "turnComplete" || event.type === "ended" || event.type === "error";
    const startsNewInstance = event.type === "turnStarted";

    if (isLifecycleExit || startsNewInstance) {
      // Lifecycle events can arrive in same frame as final text delta.
      // Flush first so invalidation cannot discard text needed for persistence.
      flushPendingTextDeltas();
      if (startsNewInstance) invalidateDeferredNarrativeEvents(threadId);
      if (isLifecycleExit && !isActiveThread) promoteDeferredNarrativeEvents(threadId);
      if (isLifecycleExit) {
        queueMicrotask(() => {
          if (!get().runningThreadIds.has(threadId)
            && !pendingTextDeltaByThread.has(threadId)
            && !deferredNarrativeEventsByThread.has(threadId)) {
            deferredNarrativeGenerations.delete(threadId);
          }
        });
      }
    }
    if (startsNewInstance) {
      threadHydrator.invalidatePermissionSnapshots(threadId);
    }
    if (isActiveThread && !startsNewInstance && !isLifecycleExit) {
      promoteDeferredNarrativeEvents(threadId);
    }

    if (event.type !== "textDelta") {
      flushPendingTextDeltas();
    }

    // Only evict the message cache on structural changes that add or modify
    // persisted messages. Streaming deltas (textDelta, toolProgress) are
    // ephemeral and don't change what loadMessages would return from the DB.
    const isStructuralEvent =
      event.type === "turnComplete" ||
      event.type === "ended" ||
      event.type === "error";
    if (isStructuralEvent) {
      conversationResidency.invalidateConversation(threadId);
    }

    // Helper: mark all prior incomplete tool calls as complete.
    // The Claude Agent SDK handles tool execution internally and does not
    // emit standalone "session.toolResult" events. So when a new event
    // arrives that implies previous tools finished (new toolUse, message,
    // delta, or turnComplete), we mark prior calls as done.
    const markPriorToolCallsComplete = () => {
      const calls = getRec(threadId).toolCalls;
      if (!calls || !calls.some((tc) => !tc.isComplete)) return;
      set((state) => {
        const current = getThreadRecord(state.records, threadId).toolCalls;
        const children = (agentId: string) =>
          current.filter((c) => c.parentToolCallId === agentId);
        const isAgentDone = (agentId: string) => {
          const kids = children(agentId);
          return kids.length > 0 && !kids.some((c) => !c.isComplete);
        };

        const updated = current.map((tc) => {
          if (tc.isComplete) return tc;
          if (tc.toolName === "Agent") {
            const done = isAgentDone(tc.id);
            return done ? { ...tc, isComplete: true } : tc;
          }
          return { ...tc, isComplete: true };
        });
        return { records: patchThreadRecord(state.records, threadId, { toolCalls: updated }) };
      });
    };

    if (event.type !== "apiRetry" && getRec(threadId).apiRetry) {
      patchRec(threadId, { apiRetry: undefined });
    }

    if (event.type === "goalUpdated") {
      const goal = event.goal as GoalState | undefined;
      if (goal) {
        const openGoal = isGoalOpen(goal) ? goal : null;
        patchRec(threadId, { goal: openGoal });
      }
      return;
    }

    if (event.type === "goalCleared") {
      patchRec(threadId, { goal: null });
      return;
    }

    if (event.type === "system") {
      const subtype = event.subtype as string;
      // Both subtypes render as the quiet system-message hairline chapter-break.
      // `session_restarted`: the SDK silently restarted (lost in-memory context).
      // `sdk_session_invalidated`: a poison-pill provider state forced a reset;
      // the persisted sdk_session_id is cleared server-side so the next send
      // starts fresh. Terse, technical copy; no apology, no vendor-blame.
      const systemNotice =
        subtype === "session_restarted"
          ? "Session restarted. The agent no longer has context from earlier messages."
          : subtype === "sdk_session_invalidated"
            ? "Session reset. Earlier context cleared. Send again to continue."
            : null;
      if (systemNotice) {
        const message: Message = {
          id: crypto.randomUUID(),
          thread_id: threadId,
          role: "system",
          content: systemNotice,
          tool_calls: null,
          files_changed: null,
          cost_usd: null,
          tokens_used: null,
          timestamp: new Date().toISOString(),
          sequence: messageSequenceFor(threadId),
          attachments: null,
        };
        set((state) => {
          const rec = getThreadRecord(state.records, threadId);
          const { messages: capped, evicted } = capMessages([...rec.messages, message]);
          return {
            records: patchThreadRecord(state.records, threadId, {
              messages: capped,
              ...(evicted ? { hasMoreMessages: true } : {}),
            }),
          };
        });
      }
      return;
    }

    if (event.type === "turnStarted") {
      const fileEffectTurnId = typeof event.fileEffectTurnId === "string"
        ? event.fileEffectTurnId
        : "";
      const currentState = get();
      const currentRecord = getThreadRecord(currentState.records, threadId);
      if (currentState.runningThreadIds.has(threadId)
        && currentRecord.fileEffectTurnId === fileEffectTurnId) {
        return;
      }
      clearStreamingTextUsage(threadId);
      useTaskStore.getState().prepareTaskBubbleForNewTurn(threadId);
      set((state) => {
        const rec = getThreadRecord(state.records, threadId);
        return {
          records: patchThreadRecord(state.records, threadId, {
            agentStartTime: Date.now(),
            turnExecutionId: incomingExecutionId ?? rec.turnExecutionId,
            runtimePhase: "running",
            fileEffectSummary: { revision: 0, fileCount: 0, additions: 0, deletions: 0, effects: [] },
            ...resetTurnEphemeral(rec),
            fileEffectTurnId,
            currentTurnResponseKey: createTurnResponseKey(threadId),
          }),
        };
      });
      // Clear interrupted status so the resume banner no longer lists this
      // thread while the agent processes the continuation message.
      useWorkspaceStore.setState((ws) => {
        const idx = ws.threads.findIndex(
          (t) => t.id === threadId && t.status === "interrupted",
        );
        if (idx < 0) return ws;
        const threads = [...ws.threads];
        threads[idx] = { ...threads[idx], status: "active" as const };
        return { threads };
      });
      return;
    }

    if (event.type === "message") {
      clearStreamingTextUsage(threadId);
      markPriorToolCallsComplete();
      const content = (event.content as string) || "";
      const isGoalNotice = isGoalStatusNotice(content);
      const attachments = parseStoredAttachments(event.attachments);
      if (content || attachments.length > 0 || event.messageId) {
        const message: Message = {
          id: (event.messageId as string) || crypto.randomUUID(),
          thread_id: threadId,
          role: "assistant",
          content,
          tool_calls: null,
          files_changed: null,
          cost_usd: null,
          tokens_used: (event.tokens as number) ?? null,
          timestamp: new Date().toISOString(),
          sequence: messageSequenceFor(threadId),
          attachments: attachments.length > 0 ? attachments : null,
          // Server injects the model after persisting; defaults to null when
          // unknown (legacy clients, non-Claude providers without model info).
          model: (event.model as string | null | undefined) ?? null,
        };
        set((state) => {
          const rec = getThreadRecord(state.records, threadId);
          const segments = rec.thoughtSegments;
          const lastSeg = segments[segments.length - 1];
          const closedSegments =
            lastSeg && lastSeg.endedAt === undefined
              ? [...segments.slice(0, -1), { ...lastSeg, endedAt: Date.now() }]
              : segments;
          const responseProjection = isGoalNotice
            ? { messages: [...rec.messages, message] }
            : projectTurnResponse(rec, message, event.messageId);
          const transferredMetadata = transferTurnResponseMetadata(
            rec,
            responseProjection.replacedMessageId,
            message.id,
          );

          const responseIdentityPatch: Partial<
            Pick<
              ThreadRecord,
              "assistantResponseKeys" | "currentTurnMessageId" | "currentTurnResponseKey"
            >
          > = isGoalNotice
            ? {}
            : (() => {
                const existingResponseKey = transferredMetadata.assistantResponseKeys[message.id];
                const { responseKey, nextLiveKey } = existingResponseKey
                  ? {
                      responseKey: existingResponseKey,
                      nextLiveKey: rec.currentTurnResponseKey || createTurnResponseKey(threadId),
                    }
                  : claimTurnResponseKey(rec, threadId, message.id);
                return {
                  currentTurnMessageId: message.id,
                  currentTurnResponseKey: nextLiveKey,
                  assistantResponseKeys: {
                    ...transferredMetadata.assistantResponseKeys,
                    [message.id]: responseKey,
                  },
                };
              })();

          const turnPatch = {
            ...responseIdentityPatch,
            streaming: "",
            streamingPreview: "",
            thoughtSegments: closedSegments,
          };
          const { messages: capped, evicted } = capMessages(responseProjection.messages);
          const prunedAssistantResponseKeys = pruneAssistantResponseKeys(
            responseIdentityPatch.assistantResponseKeys ?? transferredMetadata.assistantResponseKeys,
            capped,
          );
          return {
            records: patchThreadRecord(state.records, threadId, {
              ...turnPatch,
              messages: capped,
              persistedToolCallCounts: transferredMetadata.persistedToolCallCounts,
              persistedFilesChanged: transferredMetadata.persistedFilesChanged,
              serverMessageIds: event.messageId
                ? { ...transferredMetadata.serverMessageIds, [message.id]: event.messageId }
                : transferredMetadata.serverMessageIds,
              narrativeByMessage: transferredMetadata.narrativeByMessage,
              latestTurnWithChanges: transferredMetadata.latestTurnWithChanges,
              pendingTurnPersistMessageIds: transferredMetadata.pendingTurnPersistMessageIds,
              assistantResponseKeys: prunedAssistantResponseKeys,
              ...(evicted ? { hasMoreMessages: true } : {}),
            }),
          };
        });
        conversationResidency.synchronizeConversation(threadId);
      }
      return;
    }

    if (event.type === "toolUse") {
      // Background text stays deferred until its tool boundary arrives. Project
      // that queued narrative first so toolUse closes the correct thought.
      if (!isActiveThread) {
        promoteDeferredNarrativeEvents(threadId);
      }
      const toolCallId = (event.toolCallId as string) || "";
      const existingCalls = getRec(threadId).toolCalls;
      const toolName = (event.toolName as string) || "unknown";
      const incomingInput = (event.toolInput as Record<string, unknown>) || {};
      const parentToolCallId = event.parentToolCallId as string | undefined;
      const applyTodoWriteTasks = (
        toolInput: Record<string, unknown>,
        resolvedParentToolCallId: string | undefined,
      ) => {
        if (toolName !== "TodoWrite") return;
        const todos = toolInput.todos as Array<Record<string, unknown>> | undefined;
        if (!todos || !Array.isArray(todos)) return;

        const group = resolvedParentToolCallId
          ? resolveAgentGroupLabel(existingCalls, resolvedParentToolCallId)
          : "Tasks";

        const taskItems: TaskItem[] = todos.map((t, i) => ({
          id: t.id != null ? String(t.id) : String(i),
          content: String(t.content ?? ""),
          status: coerceTaskStatus(t.status),
          group,
        }));

        useTaskStore.getState().setTaskGroup(threadId, group, taskItems);
      };
      const applyTaskCreate = (
        toolInput: Record<string, unknown>,
        resolvedParentToolCallId: string | undefined,
      ) => {
        if (toolName !== "TaskCreate") return;
        const content = taskTextFromToolInput(toolInput);
        if (!content) return;

        const group = resolvedParentToolCallId
          ? resolveAgentGroupLabel(existingCalls, resolvedParentToolCallId)
          : "Tasks";
        const activeForm =
          typeof toolInput.activeForm === "string" && toolInput.activeForm.trim().length > 0
            ? toolInput.activeForm.trim()
            : undefined;
        const taskItem: TaskItem = {
          id: toolCallId || String(toolInput.id ?? content),
          content,
          status: coerceTaskStatus(toolInput.status ?? "pending"),
          group,
          ...(activeForm !== undefined ? { activeForm } : {}),
        };
        const existingTasks = useTaskStore.getState().tasksByThread[threadId] ?? [];
        const groupTasks = existingTasks.filter((task) => task.group === group);
        useTaskStore.getState().setTaskGroup(
          threadId,
          group,
          [...groupTasks.filter((task) => task.id !== taskItem.id), taskItem],
        );
      };
      const applyTaskUpdate = (
        toolInput: Record<string, unknown>,
        resolvedParentToolCallId: string | undefined,
      ) => {
        if (toolName !== "TaskUpdate") return;
        const harnessTaskId = toolInput.taskId != null ? String(toolInput.taskId) : "";
        if (!harnessTaskId) return;

        const group = resolvedParentToolCallId
          ? resolveAgentGroupLabel(existingCalls, resolvedParentToolCallId)
          : "Tasks";
        const allTasks = useTaskStore.getState().tasksByThread[threadId] ?? [];
        // Prefer a task scoped to this group. Fall back to a global harnessTaskId
        // match only when exactly one task carries the id, so an update still
        // lands when the group cannot be resolved (e.g. the create's parent Agent
        // call has been evicted from the buffer) without updating the wrong task
        // on an ambiguous sub-agent collision.
        const scoped = allTasks.find(
          (t) => t.group === group && t.harnessTaskId === harnessTaskId,
        );
        const globalMatches = allTasks.filter((t) => t.harnessTaskId === harnessTaskId);
        const target = scoped ?? (globalMatches.length === 1 ? globalMatches[0] : undefined);
        if (!target) return;

        const groupTasks = allTasks.filter((t) => t.group === target.group);
        if (toolInput.status === "deleted") {
          useTaskStore.getState().setTaskGroup(
            threadId,
            target.group,
            groupTasks.filter((t) => t !== target),
          );
          return;
        }

        // Only `subject` maps to the displayed content. A description-only edit
        // does not rewrite content, matching the server's persisted behavior.
        const nextSubject =
          typeof toolInput.subject === "string" && toolInput.subject.trim().length > 0
            ? toolInput.subject.trim()
            : undefined;
        const nextActiveForm =
          typeof toolInput.activeForm === "string" && toolInput.activeForm.trim().length > 0
            ? toolInput.activeForm.trim()
            : undefined;
        const patched: TaskItem = {
          ...target,
          ...(toolInput.status !== undefined ? { status: coerceTaskStatus(toolInput.status) } : {}),
          ...(nextSubject ? { content: nextSubject } : {}),
          ...(nextActiveForm !== undefined ? { activeForm: nextActiveForm } : {}),
        };
        useTaskStore.getState().setTaskGroup(
          threadId,
          target.group,
          groupTasks.map((t) => (t === target ? patched : t)),
        );
      };
      const applyUpdatePlanTasks = (
        toolInput: Record<string, unknown>,
        resolvedParentToolCallId: string | undefined,
      ) => {
        if (toolName !== "update_plan") return;
        const group = resolvedParentToolCallId
          ? resolveAgentGroupLabel(existingCalls, resolvedParentToolCallId)
          : "Tasks";
        const taskItems = updatePlanTasksFromToolInput(toolInput).map((task) => ({ ...task, group }));
        if (taskItems.length === 0) return;

        useTaskStore.getState().setTaskGroup(threadId, group, taskItems);
      };
      if (toolCallId) {
        const existing = existingCalls.find((tc) => tc.id === toolCallId);
        if (existing) {
          // Providers may emit a sparse running ToolUse first, then a richer
          // ToolUse with the same id when the completion payload arrives.
          const isAgentEnrichment = existing.toolName === "Agent" && toolName === "Agent";
          const shouldMergeDuplicate = isAgentEnrichment || (
            !existing.isComplete && (
              Object.keys(existing.toolInput ?? {}).length === 0
              || existing.toolName !== toolName
            ));
          if (shouldMergeDuplicate) {
            const mergedInput = { ...existing.toolInput, ...incomingInput };
            const incomingPresentation = event.subagentPresentation
              ?? (toolName === "Agent" ? createSubagentPresentation(incomingInput, toolCallId) : undefined);
            const subagentPresentation = incomingPresentation
              ? mergeSubagentPresentation(existing.subagentPresentation, incomingPresentation, toolCallId)
              : existing.subagentPresentation;
            const resolvedParentToolCallId = existing.parentToolCallId ?? parentToolCallId;
            set((state) => {
              const calls = getThreadRecord(state.records, threadId).toolCalls;
              const updated = calls.map((tc) =>
                tc.id === toolCallId
                  ? {
                      ...tc,
                      toolName,
                      toolInput: mergedInput,
                      subagentPresentation,
                      parentToolCallId: tc.parentToolCallId ?? resolvedParentToolCallId,
                    }
                  : tc,
              );
              return { records: patchThreadRecord(state.records, threadId, { toolCalls: updated }) };
            });
            applyTodoWriteTasks(mergedInput, resolvedParentToolCallId);
            applyTaskCreate(mergedInput, resolvedParentToolCallId);
            applyTaskUpdate(mergedInput, resolvedParentToolCallId);
            applyUpdatePlanTasks(mergedInput, resolvedParentToolCallId);
          }
          return;
        }
      }

      // Only mark prior tool calls complete if this isn't a subagent's tool call
      // (subagent calls should not mark the parent Agent call as complete)
      if (!parentToolCallId) {
        markPriorToolCallsComplete();
      }
      // Intercept task tool calls to populate the task panel.
      // Sub-agent calls are grouped by their parent Agent's description so
      // multiple sub-agents each get their own collapsible section.
      applyTodoWriteTasks(incomingInput, parentToolCallId);
      applyTaskCreate(incomingInput, parentToolCallId);
      applyTaskUpdate(incomingInput, parentToolCallId);
      applyUpdatePlanTasks(incomingInput, parentToolCallId);

      const resolvedToolCallId = toolCallId || crypto.randomUUID();
      const toolCall: ToolCall = {
        id: resolvedToolCallId,
        toolName,
        toolInput: incomingInput,
        ...(toolName === "Agent"
          ? {
              subagentPresentation: event.subagentPresentation
                ?? createSubagentPresentation(incomingInput, resolvedToolCallId),
            }
          : {}),
        output: null,
        isError: false,
        isComplete: false,
        parentToolCallId: parentToolCallId || undefined,
        startedAt: Date.now(),
        lastActivityAt: Date.now(),
      };
      set((state) => {
        const rec = getThreadRecord(state.records, threadId);
        const segments = rec.thoughtSegments;
        const last = segments[segments.length - 1];
        const froze = last && last.endedAt === undefined;
        const nextSegments = froze
          ? [...segments.slice(0, -1), { ...last, endedAt: Date.now() }]
          : segments;
        return {
          records: patchThreadRecord(state.records, threadId, {
            toolCalls: [...rec.toolCalls, toolCall],
            thoughtSegments: nextSegments,
          }),
        };
      });
      return;
    }

    if (event.type === "toolResult") {
      const toolCallId = (event.toolCallId as string) || "";
      const output = (event.output as string) || "";
      const isError = (event.isError as boolean) || false;
      const exitCode =
        typeof event.exitCode === "number" && Number.isInteger(event.exitCode)
          ? event.exitCode
          : undefined;
      const outputTruncated = event.outputTruncated === true;
      const outputTotalBytes =
        typeof event.outputTotalBytes === "number" && Number.isFinite(event.outputTotalBytes)
          ? event.outputTotalBytes
          : undefined;
      const outputArtifactPath =
        typeof event.outputArtifactPath === "string" && event.outputArtifactPath.length > 0
          ? event.outputArtifactPath
          : undefined;
      const rawToolInput = event.toolInput;
      const incomingInput =
        rawToolInput && typeof rawToolInput === "object" && !Array.isArray(rawToolInput)
          ? rawToolInput as Record<string, unknown>
          : {};
      // The harness only reveals its task id in the TaskCreate result, so capture
      // it here onto the task the create produced. Later TaskUpdate calls correlate
      // by this id; without it status transitions and deletions never land.
      const resultCall = toolCallId
        ? getRec(threadId).toolCalls.find((tc) => tc.id === toolCallId)
        : undefined;
      if (resultCall?.toolName === "TaskCreate" && !isError) {
        const harnessTaskId = parseHarnessTaskId(output);
        if (harnessTaskId) {
          const allTasks = useTaskStore.getState().tasksByThread[threadId] ?? [];
          const target = allTasks.find((t) => t.id === toolCallId);
          if (target && target.harnessTaskId !== harnessTaskId) {
            useTaskStore.getState().setTaskGroup(
              threadId,
              target.group,
              allTasks
                .filter((t) => t.group === target.group)
                .map((t) => (t.id === toolCallId ? { ...t, harnessTaskId } : t)),
            );
          }
        }
      }
      set((state) => {
        const calls = getThreadRecord(state.records, threadId).toolCalls;
        // Try matching by ID first; fall back to the first incomplete tool call
        // when the SDK sends a null or non-matching toolCallId.
        const hasIdMatch = toolCallId && calls.some((tc) => tc.id === toolCallId);

        // Fallback: pick the first incomplete call, but never pick an Agent call
        // that has active children — completing it prematurely would hide nested work.
        const hasActiveChildren = (id: string) =>
          calls.some((c) => c.parentToolCallId === id && !c.isComplete);
        let matched = false;
        const completeCall = (tc: ToolCall): ToolCall => {
          const mergedInput = { ...tc.toolInput, ...incomingInput };
          const subagentPresentation = event.subagentPresentation
            ? mergeSubagentPresentation(tc.subagentPresentation, event.subagentPresentation, tc.id)
            : tc.subagentPresentation;
          const fromInput = mergedInput.durationMs;
          const durationMs =
            typeof fromInput === "number" && Number.isFinite(fromInput)
              ? fromInput
              : tc.startedAt != null
                ? Math.max(0, Date.now() - tc.startedAt)
                : undefined;
          return {
            ...tc,
            toolInput: mergedInput,
            subagentPresentation,
            output,
            isError,
            isComplete: true,
            lastActivityAt: Date.now(),
            ...(outputTruncated ? { outputTruncated: true } : {}),
            ...(outputTotalBytes != null ? { outputTotalBytes } : {}),
            ...(outputArtifactPath ? { outputArtifactPath } : {}),
            ...(durationMs != null ? { durationMs } : {}),
            ...(exitCode !== undefined ? { exitCode } : {}),
          };
        };
        const updated = hasIdMatch
          ? calls.map((tc) => (tc.id === toolCallId ? completeCall(tc) : tc))
          : calls.map((tc) => {
              if (!matched && !tc.isComplete && !(tc.toolName === "Agent" && hasActiveChildren(tc.id))) {
                matched = true;
                return completeCall(tc);
              }
              return tc;
            });

        return { records: patchThreadRecord(state.records, threadId, { toolCalls: updated }) };
      });
      return;
    }

    // session.textDelta: accumulate streaming text for live preview and finalization.
    if (event.type === "textDelta") {
      const delta = (event.delta as string) || "";
      if (!delta) return;
      const rawIsFinalResponse = event.isFinalResponse;
      const isFinalResponse =
        typeof rawIsFinalResponse === "boolean" ? rawIsFinalResponse : undefined;
      const deferNarrative = !isActiveThread;
      const hadPending = pendingTextDeltaByThread.has(threadId);
      const existing = pendingTextDeltaByThread.get(threadId) ?? [];
      const next = [...existing];
      const tail = next[next.length - 1];
      if (
        tail
        && tail.isFinalResponse === isFinalResponse
        && tail.deferNarrative === deferNarrative
      ) {
        next[next.length - 1] = {
          delta: tail.delta + delta,
          isFinalResponse,
          deferNarrative,
        };
      } else {
        next.push({ delta, isFinalResponse, deferNarrative });
      }
      pendingTextDeltaByThread.set(threadId, next);
      if (!isActiveThread) {
        queueDeferredNarrativeEvent(threadId, event);
      }
      if (!deferNarrative && (!hadPending || existing.some((chunk) => chunk.deferNarrative))) {
        markPriorToolCallsComplete();
      }
      scheduleTextDeltaFlush();
      return;
    }

    if (event.type === "assistantMessageBoundary") {
      // Authoritative classification of the text deltas just streamed for this
      // assistant message, derived from the Anthropic `stop_reason`.
      //
      // - isFinalResponse=true (end_turn, stop_sequence, max_tokens, refusal):
      //   the streamed text was the assistant's final response, not a thought.
      //   Drop the open thought segment so it does not render alongside the
      //   forthcoming MessageBubble. The streaming buffer already holds the
      //   text and will be cleared by `session.message`.
      // - isFinalResponse=false (tool_use, pause_turn, anything else):
      //   the streamed text was preamble. Close the open thought so the next
      //   delta starts a fresh segment.
      const isFinalResponse = event.isFinalResponse === true;
      // Flush any pending text delta chunks first so the open thought we
      // operate on reflects every delta that arrived for this message.
      flushPendingTextDeltas();
      if (!isActiveThread) {
        queueDeferredNarrativeEvent(threadId, event);
        return;
      }
      set((state) => {
        const rec = getThreadRecord(state.records, threadId);
        const nextSegments = projectAssistantMessageBoundary(rec.thoughtSegments, isFinalResponse);
        if (!nextSegments) return state;
        return {
          records: patchThreadRecord(state.records, threadId, {
            thoughtSegments: nextSegments,
          }),
        };
      });
      return;
    }

    if (event.type === "toolProgress") {
      if (!isActiveThread) {
        queueDeferredNarrativeEvent(threadId, event);
        return;
      }
      const toolCallId = (event.toolCallId as string) || "";
      const elapsedSeconds = (event.elapsedSeconds as number) ?? 0;
      if (!toolCallId) return;
      const lastActivityAt = Date.now();
      set((state) => {
        const current = getThreadRecord(state.records, threadId).toolCalls;
        const updated = projectToolProgress(current, toolCallId, elapsedSeconds, lastActivityAt);
        // Return same state reference when nothing changed — Zustand skips notification.
        if (!updated) return state;
        return { records: patchThreadRecord(state.records, threadId, { toolCalls: updated }) };
      });
      return;
    }

    if (event.type === "hookStarted") {
      const hookName = (event.hookName as string) || "unknown";
      const hookType = (event.hookType as "permission" | "stop") || "stop";
      const toolName = event.toolName as string | undefined;
      const hook: HookExecution = {
        hookName,
        hookType,
        toolName,
        status: "running",
        outputLines: [],
        fullOutput: [],
        startedAt: Date.now(),
      };
      set((state) => ({
        records: patchThreadRecord(state.records, threadId, {
          hooks: [...getThreadRecord(state.records, threadId).hooks, hook],
        }),
      }));
      return;
    }

    if (event.type === "hookProgress") {
      const hookName = (event.hookName as string) || "";
      const output = (event.output as string) || "";
      if (!hookName || !output) return;
      set((state) => {
        const hooks = getThreadRecord(state.records, threadId).hooks;
        // Target the last running hook with this name (not all same-name runs)
        let idx = -1;
        for (let i = hooks.length - 1; i >= 0; i--) {
          if (hooks[i]!.hookName === hookName && hooks[i]!.status === "running") {
            idx = i;
            break;
          }
        }
        if (idx < 0) return state;
        // Split chunk into actual lines so the 20-line cap is line-based
        const addedLines = output
          .split(/\r?\n/)
          .filter((line, i, arr) => !(i === arr.length - 1 && line === ""));
        if (addedLines.length === 0) return state;
        const next = [...hooks];
        const target = next[idx]!;
        // Cap retained output to prevent unbounded memory growth from verbose hooks
        const raw = [...target.fullOutput, ...addedLines];
        const fullOutput = raw.length > 500 ? raw.slice(-500) : raw;
        next[idx] = { ...target, fullOutput, outputLines: fullOutput.slice(-20) };
        return { records: patchThreadRecord(state.records, threadId, { hooks: next }) };
      });
      return;
    }

    if (event.type === "hookCompleted") {
      const hookName = (event.hookName as string) || "";
      const exitCode = (event.exitCode as number) ?? 1;
      const durationMs = (event.durationMs as number) ?? 0;
      const didBlock = (event.didBlock as boolean) ?? false;
      const persistedMessageId = event.persistedMessageId as string | undefined;
      const persistedHookId = event.persistedHookId as string | undefined;
      if (!hookName) return;

      // Late hooks (Stop/SessionEnd/PreCompact) arrive with persistedMessageId
      // set by the server after `persistTurn` already ran. Route them into the
      // persisted narrative cache so they render below the assistant bubble
      // rather than appending to the volatile hooksByThread list (which is
      // cleared on turn end and would not be visible).
      if (persistedMessageId) {
        set((state) => {
          const rec = getThreadRecord(state.records, threadId);
          const existing = rec.narrativeByMessage[persistedMessageId];
          if (!existing) return state;
          if (persistedHookId && existing.hooks.some((h) => h.id === persistedHookId)) {
            return state;
          }
          const record = {
            id: persistedHookId ?? crypto.randomUUID(),
            message_id: persistedMessageId,
            hook_name: hookName,
            tool_name: null,
            phase: "stop" as const,
            payload: JSON.stringify({ hookType: "stop", toolName: null }),
            duration_ms: durationMs,
            did_block: didBlock,
            started_at: new Date().toISOString(),
            ended_at: new Date().toISOString(),
            sort_order: (existing.hooks.length > 0
              ? Math.max(...existing.hooks.map((h) => h.sort_order)) + 1
              : 1000),
          };
          return {
            records: patchThreadRecord(state.records, threadId, {
              narrativeByMessage: {
                ...rec.narrativeByMessage,
                [persistedMessageId]: {
                  ...existing,
                  hooks: [...existing.hooks, record],
                },
              },
            }),
          };
        });
        return;
      }

      set((state) => {
        const hooks = getThreadRecord(state.records, threadId).hooks;
        // Target the last running hook with this name
        let idx = -1;
        for (let i = hooks.length - 1; i >= 0; i--) {
          if (hooks[i]!.hookName === hookName && hooks[i]!.status === "running") {
            idx = i;
            break;
          }
        }
        if (idx < 0) return state;
        const next = [...hooks];
        next[idx] = { ...next[idx]!, status: "completed" as const, exitCode, durationMs, didBlock };
        return { records: patchThreadRecord(state.records, threadId, { hooks: next }) };
      });
      return;
    }

    if (event.type === "turnComplete" || event.type === "ended") {
      if (!runtimeActive
        || (incomingExecutionId && runtimeRecord.turnExecutionId !== incomingExecutionId)) return;
      clearStreamingTextUsage(threadId);
      useTaskStore.getState().clearTaskBubbleIfAwaitingReplacement(threadId);
      const turnComplete = event.type === "turnComplete" ? event : undefined;
      const costUsd = turnComplete?.costUsd ?? null;
      const tokensIn = turnComplete?.tokensIn ?? 0;
      const tokensOut = turnComplete?.tokensOut ?? 0;
      const terminalPhase: ThreadRecord["runtimePhase"] = event.type === "turnComplete"
        ? "completed"
        : event.outcome === "completed"
          ? "completed"
          : event.outcome === "errored"
            ? "errored"
            : event.outcome === "cancelled"
              ? "cancelled"
              : "interrupted";
      const terminalStatus: "completed" | "errored" | "interrupted" = terminalPhase === "completed"
        ? "completed"
        : terminalPhase === "errored"
          ? "errored"
          : "interrupted";

      // Commit any remaining streaming content and stop the agent,
      // Tool calls remain in-place and collapse into a summary.
      const streamContent = getRec(threadId).streaming;

      // Build an ephemeral system message for guardrail stops (budget/turn limit).
      // Folded into the same set() call to avoid a double render pass.
      const reason = turnComplete?.reason;
      const isGuardrailStop = reason === "error_max_budget_usd" || reason === "max_turns";
      const guardrailMsg: Message | null = isGuardrailStop ? {
        id: crypto.randomUUID(),
        thread_id: threadId,
        role: "system",
        content: `Agent stopped: ${reason === "error_max_budget_usd" ? "Budget cap reached" : "Max turns reached"}. You can adjust guardrails in Settings > Agent.`,
        sequence: 0,
        tokens_used: null,
        cost_usd: null,
        timestamp: new Date().toISOString(),
        tool_calls: null,
        files_changed: null,
        attachments: null,
      } : null;

      // First: mark all tool calls as complete (in place) and commit the message
      if (streamContent) {
        const message: Message = {
          id: crypto.randomUUID(),
          thread_id: threadId,
          role: "assistant",
          content: streamContent,
          tool_calls: null,
          files_changed: null,
          cost_usd: costUsd,
          tokens_used: tokensIn + tokensOut || null,
          timestamp: new Date().toISOString(),
          sequence: messageSequenceFor(threadId),
          attachments: null,
        };
        set((state) => {
          const rec = getThreadRecord(state.records, threadId);
          const segments = rec.thoughtSegments;
          const lastSeg = segments[segments.length - 1];
          const closedSegments =
            lastSeg && lastSeg.endedAt === undefined
              ? [...segments.slice(0, -1), { ...lastSeg, endedAt: Date.now() }]
              : segments;
          const completedCalls = rec.toolCalls.map((tc) =>
            tc.isComplete ? tc : { ...tc, isComplete: true },
          );
          const dedupedGuardrail =
            guardrailMsg &&
            !rec.messages.some(
              (m) => m.role === "system" && m.content.startsWith("Agent stopped:"),
            )
              ? guardrailMsg
              : null;
          const pending = [message, ...(dedupedGuardrail ? [dedupedGuardrail] : [])];
          const { responseKey, nextLiveKey } = claimTurnResponseKey(
            rec,
            threadId,
            message.id,
          );

          const basePatch = {
            streaming: "",
            streamingPreview: "",
            runtimePhase: terminalPhase,
            currentTurnMessageId: message.id,
            ...queuePendingTurnPersistMessage(rec, message.id),
            currentTurnResponseKey: nextLiveKey,
            assistantResponseKeys: {
              ...rec.assistantResponseKeys,
              [message.id]: responseKey,
            },
            thoughtSegments: closedSegments,
            toolCalls: completedCalls,
            permissions: [] as StoredPermission[],
            rateLimit: undefined,
          };

          const { messages: capped, evicted } = capMessages([...rec.messages, ...pending]);
          const prunedAssistantResponseKeys = pruneAssistantResponseKeys(
            basePatch.assistantResponseKeys,
            capped,
          );
          return {
            records: patchThreadRecord(state.records, threadId, {
              ...basePatch,
              messages: capped,
              assistantResponseKeys: prunedAssistantResponseKeys,
              ...(evicted ? { hasMoreMessages: true } : {}),
            }),
          };
        });
      } else {
        set((state) => {
          const rec = getThreadRecord(state.records, threadId);
          const completedCalls = rec.toolCalls.map((tc) =>
            tc.isComplete ? tc : { ...tc, isComplete: true },
          );
          const dedupedGuardrail =
            guardrailMsg &&
            !rec.messages.some(
              (m) => m.role === "system" && m.content.startsWith("Agent stopped:"),
            )
              ? guardrailMsg
              : null;

          const basePatch = {
            streaming: "",
            streamingPreview: "",
            runtimePhase: terminalPhase,
            toolCalls: completedCalls,
            permissions: [] as StoredPermission[],
            rateLimit: undefined,
            ...(rec.currentTurnMessageId
              ? {
                  ...queuePendingTurnPersistMessage(rec, rec.currentTurnMessageId),
                }
              : {}),
          };

          if (dedupedGuardrail) {
            const { messages: capped, evicted } = capMessages([...rec.messages, dedupedGuardrail]);
            return {
              records: patchThreadRecord(state.records, threadId, {
                ...basePatch,
                messages: capped,
                ...(evicted ? { hasMoreMessages: true } : {}),
              }),
            };
          }

          return {
            records: patchThreadRecord(state.records, threadId, basePatch),
          };
        });
      }
      conversationResidency.retainInactiveConversation(threadId);

      // Update context tracker. Prefer the SDK-reported contextWindow (authoritative)
      // over the local registry. The DB is updated server-side; contextByThread is
      // the live source within a session and loaded from thread.list on cold start.
      //
      // Skip context update if the thread is currently compacting. A turnComplete
      // can fire during compaction (from the compaction API call itself) carrying
      // the pre-compaction input token count, which would flash near-100% fill.
      // Compaction cleanup (isCompactingByThread) is handled solely by the
      // session.compacting handler to keep lifecycle management in one place.
      if (tokensIn > 0 && !getRec(threadId).isCompacting) {
        const sdkContextWindow = turnComplete?.contextWindow;
        const totalProcessedTokens = turnComplete?.totalProcessedTokens;
        // Prefer the actual model that ran (post-fallback) so context window
        // sizing reflects Haiku's limits rather than the requested Opus model.
        const fallback = getRec(threadId).lastFallback;
        const thread = useWorkspaceStore.getState().threads.find((t) => t.id === threadId);
        const modelId = fallback?.actualModel
          ?? thread?.model
          ?? "claude-sonnet-4-6";
        // Effective mode chain: thread override > settings default > "200k".
        // Uses get() (not state) because this runs outside the set() callback.
        const settingsDefaults = useSettingsStore.getState().settings.model.defaults;
        const effectiveMode: ContextWindowMode =
          (thread?.context_window_mode as ContextWindowMode | null | undefined)
          ?? settingsDefaults.contextWindow
          ?? "200k";
        const contextWindow = resolveContextWindow({
          sdkContextWindow,
          modelId,
          contextWindowMode: effectiveMode,
          previousContextWindow: getRec(threadId).context?.contextWindow,
        });
        set((state) => ({
          records: patchThreadRecord(state.records, threadId, {
            context: {
              lastTokensIn: tokensIn,
              contextWindow,
              totalProcessedTokens,
              tokensOut,
              cacheReadTokens: turnComplete?.cacheReadTokens,
              cacheWriteTokens: turnComplete?.cacheWriteTokens,
              costMultiplier: turnComplete?.costMultiplier,
            },
          }),
        }));
      }

      // Tool calls remain in state (all marked complete). They render as
      // a collapsed summary in-place. When turn.persisted fires, the DB-backed
      // summary replaces them and tool calls are cleared.

      // Sync the thread's status in workspaceStore so the sidebar reflects the
      // terminal outcome without waiting for a full thread reload.
      // If the user is already viewing this thread, skip the badge and
      // immediately mark viewed so the DB transitions to "paused".
      const isActiveThread = useWorkspaceStore.getState().activeThreadId === threadId;
      if (isActiveThread) {
        getTransport().markThreadViewed(threadId).catch(() => {});
      } else {
        useWorkspaceStore.setState((ws) => ({
          threads: ws.threads.map((t) =>
            t.id === threadId ? { ...t, status: terminalStatus } : t,
          ),
        }));
      }

      // Auto-dequeue: send next queued message after a brief visual pause.
      // Only on turnComplete (not session.ended) so explicit stops don't drain the queue.
      // Uses tracked timers to prevent double-dequeue from duplicate events.
      // Skip dequeue when a guardrail stopped the session to avoid restarting
      // an agent that was intentionally capped by budget or turn limits.
      if (event.type === "turnComplete" && !isGuardrailStop) {
        if (hasPendingPlanQuestions(threadId)) return;
        clearDequeueTimer(threadId);
        const timer = setTimeout(() => {
          dequeueTimers.delete(threadId);
          // Guard: verify the thread still exists and isn't already running
          const threadExists = useWorkspaceStore.getState().threads.some(
            (t) => t.id === threadId && t.deleted_at == null,
          );
          if (!threadExists) return;
          if (get().runningThreadIds.has(threadId)) return;

          // Skip auto-drain while the user is editing a queued message.
          // The queue will resume when the edit is saved or cancelled.
          if (useQueueStore.getState().editingThreadId === threadId) return;
          if (hasPendingPlanQuestions(threadId)) return;

          const next = useQueueStore.getState().dequeueNext(threadId);
          if (next) {
            void (async (): Promise<void> => {
              try {
                await get().sendMessage(
                  threadId,
                  next.content,
                  next.model,
                  next.permissionMode,
                  next.attachments.length > 0 ? next.attachments : undefined,
                  next.displayContent,
                  next.reasoningLevel,
                  next.provider,
                  next.copilotAgent,
                  next.contextWindow,
                  next.thinking,
                  next.codexFastMode,
                  next.replyToMessageId,
                  next.quotedText,
                  undefined,
                  next.mentions,
                  next.previewAnnotations,
                  next.goalObjective,
                  next.orchestrationMode,
                );
              } catch {
                void releaseBrowserCaptureSpills(next.browserCaptureSpillPaths ?? []);
              }
            })();
          }
        }, 400);
        dequeueTimers.set(threadId, timer);
      }
      return;
    }

    if (event.type === "quotaUpdate") {
      const providerId = event.providerId as string;
      const categories = Array.isArray(event.categories)
        ? (event.categories as QuotaCategory[])
        : [];
      const billingMode = event.billingMode as ProviderBillingMode | undefined;
      const sessionCostUsd = event.sessionCostUsd as number | undefined;
      const serviceTier = event.serviceTier as "standard" | "priority" | "batch" | undefined;
      const numTurns = event.numTurns as number | undefined;
      const durationMs = event.durationMs as number | undefined;
      if (providerId) {
        const incoming: ProviderUsageInfo = {
          providerId,
          quotaCategories: categories,
          billingMode,
          sessionCostUsd,
          serviceTier,
          numTurns,
          durationMs,
          usageStatus: categories.length > 0 ? "ready" : "ready-empty",
          fetchedAt: new Date().toISOString(),
        };
        const providerSnapshot = mergeProviderUsageSnapshot(
          providerUsageSnapshots.get(providerId),
          providerQuotaSnapshot(incoming),
        );
        providerUsageSnapshots.set(providerId, providerSnapshot);
        set((state) => {
          const rec = getThreadRecord(state.records, threadId);
          const existing = rec.usageByProvider[providerId];
          return {
            records: patchThreadRecord(state.records, threadId, {
              usageByProvider: {
                ...rec.usageByProvider,
                [providerId]: mergeThreadUsageSnapshot(existing, providerSnapshot, incoming),
              },
            }),
          };
        });
        get().fetchProviderUsage(threadId, providerId);
      }
      return;
    }

    if (event.type === "contextEstimate") {
      const tokensIn = event.tokensIn as number;
      const ctxWindow = event.contextWindow as number | undefined;
      // Only apply if not compacting — the compaction-start zero sentinel is
      // authoritative while compaction is in progress.
      if (tokensIn > 0 && !getRec(threadId).isCompacting) {
        set((state) => {
          const prev = getThreadRecord(state.records, threadId).context;
          return {
            records: patchThreadRecord(state.records, threadId, {
              context: {
                ...prev,
                lastTokensIn: tokensIn,
                contextWindow: ctxWindow ?? prev?.contextWindow,
                totalProcessedTokens: prev?.totalProcessedTokens,
              },
            }),
          };
        });
      }
      return;
    }

    if (event.type === "rateLimited") {
      const active = event.active as boolean;
      patchRec(threadId, {
        rateLimit: active
          ? {
              retryAfterMs: event.retryAfterMs as number | undefined,
              limitType: event.limitType as string | undefined,
              utilization: event.utilization as number | undefined,
            }
          : undefined,
      });
      return;
    }

    if (event.type === "apiRetry") {
      patchRec(threadId, {
        apiRetry: {
          reason: event.reason as string,
          attempt: event.attempt as number | undefined,
          maxRetries: event.maxRetries as number | undefined,
          delayMs: event.delayMs as number | undefined,
        },
      });
      return;
    }

    if (event.type === "compacting") {
      const active = event.active as boolean;
      if (!active) {
        const wasCompacting = getRec(threadId).isCompacting;
        if (wasCompacting) {
          const systemMsg: Message = {
            id: crypto.randomUUID(),
            thread_id: threadId,
            role: "system",
            content: "Context compacted",
            sequence: messageSequenceFor(threadId),
            timestamp: new Date().toISOString(),
            tool_calls: null,
            files_changed: null,
            cost_usd: null,
            tokens_used: null,
            attachments: null,
          };
          patchRec(threadId, (rec) => {
            const { messages: capped, evicted } = capMessages([...rec.messages, systemMsg]);
            return {
              messages: capped,
              ...(evicted ? { hasMoreMessages: true } : {}),
            };
          });
        }
      }
      set((state) => {
        const rec = getThreadRecord(state.records, threadId);
        const prev = rec.context;
        return {
          records: patchThreadRecord(state.records, threadId, {
            isCompacting: active,
            ...(active
              ? {
                  context: {
                    ...prev,
                    lastTokensIn: 0,
                    contextWindow: prev?.contextWindow,
                    totalProcessedTokens: prev?.totalProcessedTokens,
                  },
                }
              : {}),
          }),
        };
      });
      return;
    }

    if (event.type === "modelFallback") {
      const requestedModel = event.requestedModel as string;
      const actualModel = event.actualModel as string;

      const actualDefinition = findModelById(actualModel);
      const normalizedActual = actualDefinition?.id ?? actualModel;

      patchRec(threadId, {
        lastFallback: { requestedModel, actualModel: normalizedActual },
      });

      // Only notify the user if they are viewing this thread
      if (useWorkspaceStore.getState().activeThreadId === threadId) {
        const actualLabel = actualDefinition?.label ?? normalizedActual;
        const requestedLabel = findModelById(requestedModel)?.label ?? requestedModel;
        useToastStore.getState().show(
          "info",
          `Switched to ${actualLabel}`,
          `${requestedLabel} was unavailable`,
        );
      }
      return;
    }

    if (event.type === "error") {
      if (!runtimeActive
        || (incomingExecutionId && runtimeRecord.turnExecutionId !== incomingExecutionId)) return;
      clearStreamingTextUsage(threadId);
      const errorMsg = typeof event.error === "string" ? event.error : String(event.error ?? "Unknown error");
      const errorMessage: Message = {
        id: crypto.randomUUID(),
        thread_id: threadId,
        role: "system",
        content: JSON.stringify({ __type: "agent_error", message: errorMsg }),
        tool_calls: null,
        files_changed: null,
        cost_usd: null,
        tokens_used: null,
        timestamp: new Date().toISOString(),
        sequence: messageSequenceFor(threadId),
        attachments: null,
      };
      set((state) => {
        const rec = getThreadRecord(state.records, threadId);
        const basePatch = {
          error: errorMsg,
          runtimePhase: "errored" as const,
          streaming: "",
          streamingPreview: "",
          agentStartTime: undefined,
          currentTurnMessageId: "",
          currentTurnResponseKey: "",
          toolCalls: [] as ToolCall[],
          isCompacting: false,
          rateLimit: undefined,
          apiRetry: undefined,
        };
        const { messages: capped, evicted } = capMessages([...rec.messages, errorMessage]);
        return {
          records: patchThreadRecord(state.records, threadId, {
            ...basePatch,
            messages: capped,
            ...(evicted ? { hasMoreMessages: true } : {}),
          }),
        };
      });

      // Clear any pending dequeue timer and queue for this thread on error
      clearDequeueTimer(threadId);
      useQueueStore.getState().clearQueue(threadId);

      // Sync the thread's status in workspaceStore so the sidebar shows
      // the red "Errored" badge without waiting for a full thread reload.
      useWorkspaceStore.setState((ws) => ({
        threads: ws.threads.map((t) =>
          t.id === threadId ? { ...t, status: "errored" as const } : t,
        ),
      }));
      return;
    }

    if (event.type === "mcpServerStartupStatus") {
      if (
        event.status === "failed"
        && useWorkspaceStore.getState().activeThreadId === threadId
      ) {
        const reason = event.error || event.failureReason || "Startup failed";
        useToastStore.getState().show(
          "error",
          "MCP server unavailable",
          `The turn will continue without it. ${event.name}: ${reason}`,
        );
      }
      return;
    }

    // These event types are either consumed server-side or have no thread
    // conversation effect in the current web client.
    if (
      event.type === "generatedAttachment" ||
      event.type === "compactSummary" ||
      event.type === "toolInputDelta" ||
      event.type === "providerUnavailable"
    ) {
      return;
    }

    const unsupportedEvent: never = event;
    void unsupportedEvent;

  },

  handleFileEffectsUpdated: (threadId, turnId, summary) => {
    set((state) => {
      const rec = getThreadRecord(state.records, threadId);
      if (rec.fileEffectTurnId !== turnId) return state;
      if (summary.revision <= rec.fileEffectSummary.revision) {
        return state;
      }
      return {
        records: patchThreadRecord(state.records, threadId, {
          fileEffectTurnId: turnId,
          fileEffectSummary: summary,
        }),
      };
    });
  },

  /**
   * Fetch provider usage from the server and merge it into usageByProvider.
   * Silently ignores errors so the popover shows stale or empty state rather than crashing.
   */
  fetchProviderUsage: async (threadId, providerId) => {
    try {
      const usage = await getTransport().getProviderUsage(providerId);
      const providerSnapshot = mergeProviderUsageSnapshot(
        providerUsageSnapshots.get(providerId),
        providerQuotaSnapshot(usage),
      );
      providerUsageSnapshots.set(providerId, providerSnapshot);
      patchRec(threadId, (rec) => ({
        usageByProvider: {
          ...rec.usageByProvider,
          [providerId]: mergeThreadUsageSnapshot(rec.usageByProvider[providerId], providerSnapshot, usage),
        },
      }));
    } catch {
      const usage: ProviderUsageInfo = {
        providerId,
        quotaCategories: [],
        usageStatus: "unavailable",
        failedAt: new Date().toISOString(),
        diagnostic: "Usage refresh failed",
      };
      const previousProviderSnapshot = providerUsageSnapshots.get(providerId);
      const providerSnapshot = mergeProviderUsageSnapshot(
        previousProviderSnapshot,
        usage,
      );
      providerUsageSnapshots.set(providerId, providerSnapshot);
      if (!hasProviderUsageData(providerSnapshot)) return;
      patchRec(threadId, (rec) => ({
        usageByProvider: {
          ...rec.usageByProvider,
          [providerId]: mergeThreadUsageSnapshot(rec.usageByProvider[providerId], providerSnapshot, usage),
        },
      }));
    }
  },

  recordThreadRecapGeneration: ({
    threadId,
    text,
    signature,
    coveredMessageId,
    generatedAt,
    source,
  }) => {
    set((state) => {
      const previous = state.recapByThread[threadId];
      return {
        recapByThread: {
          ...state.recapByThread,
          [threadId]: {
            text,
            signature,
            coveredMessageId,
            generatedAt,
            ...(source === "automatic"
              ? { lastAutoGeneratedAt: generatedAt }
              : previous?.lastAutoGeneratedAt
                ? { lastAutoGeneratedAt: previous.lastAutoGeneratedAt }
                : {}),
          },
        },
      };
    });
  },

  clearInterruptStopFileNotice: (threadId) => {
    patchRec(threadId, { interruptStopFileNotice: undefined });
  },

  clearComposerRecallFromStop: (threadId) => {
    patchRec(threadId, { composerRecallFromStop: undefined });
  },

  handleTurnPersisted: (payload) => {
    flushPendingTextDeltas();
    conversationResidency.invalidateConversation(payload.threadId);

    set((state) => {
      const rec = getThreadRecord(state.records, payload.threadId);
      let interruptStopFileNotice = rec.interruptStopFileNotice;
      let awaitingUserStopPersist = rec.awaitingUserStopPersist;
      if (rec.awaitingUserStopPersist) {
        awaitingUserStopPersist = undefined;
        if (payload.filesChanged.length > 0) {
          interruptStopFileNotice = { paths: payload.filesChanged };
        }
      }

      const localMsgId = resolveTurnPersistLocalMessageId(rec, payload.messageId);
      const ensuredMessages =
        payload.filesChanged.length > 0 || payload.toolCallCount > 0
          ? ensureAssistantMessageForTurnPersist(rec, payload.threadId, localMsgId)
          : undefined;
      const outcomeMessages = payload.outcome !== undefined
        ? (ensuredMessages ?? rec.messages).map((message) => {
            if (message.id !== localMsgId) return message;
            return {
              ...message,
              outcome: payload.outcome,
              ...(payload.executionId !== undefined
                ? { outcomeExecutionId: payload.executionId }
                : {}),
            };
          })
        : undefined;
      const ownsLiveFileEffects = payload.turnId != null
        && payload.turnId === rec.fileEffectTurnId
        && (localMsgId === rec.currentTurnMessageId
          || rec.pendingTurnPersistMessageIds.includes(localMsgId));
      return {
        records: patchThreadRecord(state.records, payload.threadId, {
          ...(outcomeMessages ? { messages: outcomeMessages } : {}),
          ...(outcomeMessages ? {} : ensuredMessages ? { messages: ensuredMessages } : {}),
          persistedToolCallCounts: {
            ...rec.persistedToolCallCounts,
            [localMsgId]: payload.toolCallCount,
          },
          persistedFilesChanged: {
            ...rec.persistedFilesChanged,
            [localMsgId]: payload.filesChanged,
          },
          latestTurnWithChanges:
            state.currentThreadId === payload.threadId
              ? payload.filesChanged.length > 0 ? localMsgId : null
              : rec.latestTurnWithChanges,
          serverMessageIds: {
            ...rec.serverMessageIds,
            [localMsgId]: payload.messageId,
          },
          ...clearPendingTurnPersistMessage(rec, localMsgId),
          interruptStopFileNotice,
          awaitingUserStopPersist,
          ...(payload.fileEffects
            && ownsLiveFileEffects
            && payload.fileEffects.revision >= rec.fileEffectSummary.revision
            ? { fileEffectSummary: payload.fileEffects }
            : {}),
        }),
      };
    });

    if (payload.filesChanged.length > 0) {
      useWorkspaceStore.setState((ws) => ({
        threads: ws.threads.map((t) =>
          t.id === payload.threadId && !t.has_file_changes
            ? { ...t, has_file_changes: true }
            : t,
        ),
      }));
    }

    const localIdForBackfill = (() => {
      const rec = getRec(payload.threadId);
      const reverse = Object.entries(rec.serverMessageIds).find(
        ([, sid]) => sid === payload.messageId,
      );
      return reverse?.[0] ?? null;
    })();
    void get()
      .loadNarrativeForMessage(payload.messageId)
      .then(() => {
        const currentId = get().currentThreadId;
        if (!currentId) return;
        if (currentId !== payload.threadId) return;
        const rec = getRec(currentId);
        const serverRes = rec.narrativeByMessage[payload.messageId];
        if (!serverRes) return;
        const persistedThoughtSegments = visiblePersistedThoughtSegments(serverRes.thoughts);
        if (persistedThoughtSegments.length > rec.thoughtSegments.length) {
          patchRec(currentId, (r) => {
            if (r.toolCalls.length === 0) return {};
            if (r.thoughtSegments.length >= persistedThoughtSegments.length) return {};
            return { thoughtSegments: persistedThoughtSegments };
          });
        }
        if (!localIdForBackfill) return;
        if (localIdForBackfill === payload.messageId) return;
        patchRec(currentId, (r) => ({
          narrativeByMessage: {
            ...r.narrativeByMessage,
            [localIdForBackfill]: serverRes,
          },
        }));
      });
  },
  };
});

/**
 * Returns true if the given thread has any unsettled permission requests.
 * Use inside components: `useThreadStore(s => hasPendingPermissions(s, threadId))`.
 */
export function hasPendingPermissions(state: ThreadState, threadId: string): boolean {
  const perms = getThreadRecord(state.records, threadId).permissions;
  return perms.some((p) => !p.settled);
}
