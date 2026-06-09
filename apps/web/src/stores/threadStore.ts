import { create } from "zustand";
import type { Message, ToolCall, HookExecution, PermissionMode, InteractionMode, AttachmentMeta, ToolCallRecord } from "@/transport";
import type { ContextWindowMode, ReasoningLevel, PlanQuestion, PlanAnswer, QuotaCategory } from "@mcode/contracts";
import type { PermissionRequest, PermissionDecision } from "@mcode/contracts";
import { PlanQuestionSchema, PERMISSION_MODES, INTERACTION_MODES } from "@mcode/contracts";
import { getTransport } from "@/transport";
import { useWorkspaceStore } from "./workspaceStore";
import { useQueueStore } from "./queueStore";
import { LruCache } from "@/lib/lru-cache";
import { useTaskStore, coerceTaskStatus } from "./taskStore";
import { usePlanStore } from "./planStore";
import type { TaskItem } from "./taskStore";
import { useToastStore } from "./toastStore";
import { findModelById } from "@/lib/model-registry";
import { resolveContextWindow } from "@/lib/resolve-context-window";
import { useSettingsStore } from "./settingsStore";
import {
  cacheRecord,
  evictCachedRecord,
  getCachedRecord,
} from "@/lib/thread-hydrator/record-cache";
import { shallowEqualBy } from "@/lib/shallowEqualBy";
import { forgetScrollTop } from "@/components/chat/scrollPositionMemory";
import { releaseBrowserCaptureSpills } from "@/lib/browser-capture-spill";
import { isGoalControlCommand } from "@/lib/goal-command";
import {
  createThreadHydrator,
  registerThreadHydrator,
  type ThreadHydratorWriteState,
} from "@/lib/thread-hydrator";
import {
  type ThreadRecord,
  type HandoffMeta,
  type ThreadSettings,
  type StoredPermission,
  getThreadRecord,
  patchThreadRecord,
  deleteThreadRecord,
} from "./thread-record";

export type { HandoffMeta, ThreadSettings, StoredPermission } from "./thread-record";
export { getHandoffStatus } from "./thread-record";

interface ThreadState {
  records: Map<string, ThreadRecord>;
  currentThreadId: string | null;
  runningThreadIds: Set<string>;
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

  // Message actions
  loadMessages: (threadId: string) => Promise<void>;
  loadOlderMessages: (threadId: string) => Promise<void>;
  sendMessage: (threadId: string, content: string, model?: string, permissionMode?: PermissionMode, attachments?: AttachmentMeta[], displayContent?: string, reasoningLevel?: ReasoningLevel, provider?: string, copilotAgent?: string, contextWindow?: ContextWindowMode, thinking?: boolean, codexFastMode?: boolean, replyToMessageId?: string, quotedText?: string, planAction?: import("@mcode/contracts").PlanAction) => Promise<void>;
  stopAgent: (threadId: string) => Promise<void>;
  /** Replace runningThreadIds with the authoritative server snapshot. Called on WS (re)connect. */
  hydrateRunningThreads: (ids: string[]) => void;
  addMessage: (message: Message) => void;
  clearMessages: () => void;
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
  handleAgentEvent: (threadId: string, event: Record<string, unknown>) => void;

  /**
   * Fetch the persisted narrative (tools, thoughts, hooks) for an assistant
   * message and cache it under `narrativeByMessage[messageId]`. Returns the
   * existing in-flight promise on concurrent calls to avoid duplicate RPCs.
   * Idempotent: returns immediately if the message is already cached.
   */
  loadNarrativeForMessage: (messageId: string) => Promise<void>;
  /** Drop the cached narrative for a message - call from edit/delete paths. */
  evictNarrativeForMessage: (messageId: string) => void;

  /** Handle server-side tool call persistence confirmation. */
  handleTurnPersisted: (payload: { threadId: string; messageId: string; toolCallCount: number; filesChanged: string[] }) => void;
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

function clearDequeueTimer(threadId: string) {
  const timer = dequeueTimers.get(threadId);
  if (timer) {
    clearTimeout(timer);
    dequeueTimers.delete(threadId);
  }
}

/**
 * Resume auto-drain for a thread that was paused while the user edited a
 * queued message. Schedules the same 400ms-delayed check used by the
 * turnComplete handler. No-op when the thread is busy or the queue is empty.
 */
export function scheduleDrainAfterEdit(threadId: string): void {
  clearDequeueTimer(threadId);
  const timer = setTimeout(() => {
    dequeueTimers.delete(threadId);
    const threadExists = useWorkspaceStore.getState().threads.some(
      (t) => t.id === threadId && t.deleted_at == null,
    );
    if (!threadExists) return;
    if (useThreadStore.getState().runningThreadIds.has(threadId)) return;
    if (useQueueStore.getState().editingThreadId === threadId) return;

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
    toolCalls: [],
    thoughtSegments: [],
    hooks: [],
  };
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

/** Number of older messages to fetch per pagination request. */
export const OLDER_PAGE_SIZE = 50;

/** Maximum messages kept in the in-memory sliding window. */
export const MESSAGE_WINDOW_SIZE = 200;

/** Initial message fetch size per thread */
export const MESSAGE_FETCH_SIZE = 100;

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
  if (messages.length <= MESSAGE_WINDOW_SIZE) {
    return { messages, evicted: false };
  }
  return {
    messages: messages.slice(messages.length - MESSAGE_WINDOW_SIZE),
    evicted: true,
  };
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

/** Zustand store for thread-scoped messages, streaming session state, and agent event handling. */
/** One coalesced `session.textDelta` span for rAF flushing; merges adjacent chunks with same `isFinalResponse`. */
type PendingTextChunk = { delta: string; isFinalResponse: boolean };

export const useThreadStore = create<ThreadState>((set, get) => {
  let textDeltaFlushRaf: number | null = null;
  const pendingTextDeltaByThread = new Map<string, PendingTextChunk[]>();

  const getRec = (threadId: string) => getThreadRecord(get().records, threadId);

  const patchRec = (
    threadId: string,
    patch: Partial<ThreadRecord> | ((current: ThreadRecord) => Partial<ThreadRecord>),
  ) => {
    set((s) => ({ records: patchThreadRecord(s.records, threadId, patch) }));
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
    if (pendingTextDeltaByThread.size === 0) return;
    const batch = new Map<string, PendingTextChunk[]>();
    for (const [tid, chunks] of pendingTextDeltaByThread) {
      batch.set(tid, chunks.map((c) => ({ delta: c.delta, isFinalResponse: c.isFinalResponse })));
    }
    pendingTextDeltaByThread.clear();
    set((state) => {
      let records = state.records;
      for (const [tid, chunks] of batch) {
        const rec = getThreadRecord(records, tid);
        let streaming = rec.streaming;
        let streamingPreview = rec.streamingPreview;
        let segments = [...rec.thoughtSegments];
        for (const chunk of chunks) {
          const acc = chunk.delta;
          if (!acc) continue;
          const combined = streaming + acc;
          streaming = combined;
          streamingPreview = combined.length > 200 ? combined.slice(-200) : combined;

          if (chunk.isFinalResponse) {
            continue;
          }

          const last = segments[segments.length - 1];
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
          const shouldReopen =
            last &&
            last.endedAt !== undefined &&
            (last.text.length < TINY_SEGMENT_THRESHOLD ||
              looksLikeContinuation(last.text, acc));
          if (!last || (last.endedAt !== undefined && !shouldReopen)) {
            segments = [...segments, { text: acc, startedAt: Date.now() }];
          } else if (last.endedAt !== undefined && shouldReopen) {
            const reopened: typeof last = { ...last, text: last.text + acc };
            delete (reopened as { endedAt?: number }).endedAt;
            segments = [...segments.slice(0, -1), reopened];
          } else {
            segments = [
              ...segments.slice(0, -1),
              { ...last, text: last.text + acc },
            ];
          }
        }
        records = patchThreadRecord(records, tid, {
          streaming,
          streamingPreview,
          thoughtSegments: segments,
        });
      }
      return { records };
    });
  };

  const messageSequenceFor = (threadId: string) => getRec(threadId).messages.length + 1;

  const scheduleTextDeltaFlush = () => {
    if (textDeltaFlushRaf != null) return;
    textDeltaFlushRaf = requestAnimationFrame(() => {
      textDeltaFlushRaf = null;
      flushPendingTextDeltas();
    });
  };

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
  });
  registerThreadHydrator(threadHydrator);

  return {
    records: new Map<string, ThreadRecord>(),
    currentThreadId: null,
    runningThreadIds: new Set<string>(),
    toolCallRecordCache: new LruCache<string, ToolCallRecord[]>(TOOL_CALL_CACHE_SIZE),
    recentlyAnsweredPlanMessageIds: new Set<string>(),

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

  /**
   * Fetch persisted messages for a thread from the database.
   * Delegates to {@link ThreadHydrator} which owns cache lookup, RPC fetch,
   * auxiliary fanout, and narrative prefetch.
   */
  loadMessages: async (threadId) => {
    await threadHydrator.hydrate(threadId, "active");
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

    patchRec(threadId, { isLoadingMore: true });

    try {
      const cursor = getRec(threadId).oldestLoadedSequence;
      const epoch = getRec(threadId).loadEpoch;
      const { messages: olderMessages, hasMore } = await getTransport().getMessages(threadId, OLDER_PAGE_SIZE, cursor);

      const isStale = get().currentThreadId !== threadId
        || getRec(threadId).loadEpoch !== epoch;
      if (isStale) {
        patchRec(threadId, { isLoadingMore: false });
        return;
      }

      const newCounts: Record<string, number> = {};
      for (const msg of olderMessages) {
        if (msg.tool_call_count && msg.tool_call_count > 0) {
          newCounts[msg.id] = msg.tool_call_count;
        }
      }

      const newOldest = olderMessages.length > 0 ? olderMessages[0].sequence : cursor;

      patchRec(threadId, (r) => ({
        messages: [...olderMessages, ...r.messages],
        persistedToolCallCounts: { ...r.persistedToolCallCounts, ...newCounts },
        oldestLoadedSequence: newOldest,
        hasMoreMessages: hasMore,
        isLoadingMore: false,
      }));

      const updated = getRec(threadId);
      cacheRecord(threadId, updated);

      // Hydrate file change data for older messages from snapshots
      const olderMsgIds = new Set(olderMessages.map((m) => m.id));
      getTransport()
        .listSnapshots(threadId)
        .then((snapshots) => {
          const relevant = snapshots.filter(
            (s) => s.files_changed.length > 0 && olderMsgIds.has(s.message_id),
          );
          if (relevant.length === 0) return;
          set((state) => {
            if (state.currentThreadId !== threadId) return {};
            const rec = getThreadRecord(state.records, threadId);
            const nextFilesChanged = { ...rec.persistedFilesChanged };
            for (const snap of relevant) {
              nextFilesChanged[snap.message_id] = snap.files_changed;
            }
            return {
              records: patchThreadRecord(state.records, threadId, {
                persistedFilesChanged: nextFilesChanged,
              }),
            };
          });
          // Keep the LRU message cache in sync: the cache was written before this
          // async merge, so a cache-hit thread switch otherwise drops prepended
          // turns' file lists until a full reload.
          const cached = getCachedRecord(threadId);
          if (!cached) return;
          const mergedFiles = { ...cached.persistedFilesChanged };
          for (const snap of relevant) {
            mergedFiles[snap.message_id] = snap.files_changed;
          }
          cacheRecord(threadId, {
            ...cached,
            persistedFilesChanged: mergedFiles,
          });
        })
        .catch(() => {});
    } catch {
      patchRec(threadId, { isLoadingMore: false });
    }
  },

  /**
   * Send a user message and start the agent. Optimistically appends the
   * message to local state, marks the thread as running, then dispatches
   * to the transport layer. On failure, rolls back the running state.
   */
  sendMessage: async (threadId, content, model, permissionMode, attachments, displayContent, reasoningLevel, provider, copilotAgent, contextWindow, thinking, codexFastMode, replyToMessageId, quotedText, planAction) => {
    evictCachedRecord(threadId);

    // A `/goal` control form (show/clear/reset/bare) never starts a provider
    // turn - the server services it synchronously and returns. It must not
    // touch turn running-state: marking an idle thread running would strand it
    // (no Ended clears it, by design - see goal-command.ts), and on send
    // failure the rollback below must not clear the running-state of a real
    // turn the control command was issued against mid-flight (#583).
    const isControlCommand = isGoalControlCommand(content);

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
      attachments: attachments?.map((a) => ({
        id: a.id,
        name: a.name,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
      })) ?? null,
      reply_to_message_id: replyToMessageId ?? null,
      quoted_text: quotedText ?? null,
    };

    set((state) => {
      const settingsPatch =
        reasoningLevel !== undefined ||
        contextWindow !== undefined ||
        thinking !== undefined ||
        codexFastMode !== undefined
          ? {
              settings: {
                ...state.getThreadSettings(threadId),
                ...(reasoningLevel !== undefined && { reasoningLevel }),
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
          lastFallback: undefined,
          rateLimit: undefined,
          apiRetry: undefined,
          error: null,
        }),
        runningThreadIds: isControlCommand
          ? state.runningThreadIds
          : new Set([...state.runningThreadIds, threadId]),
      };
    });

    try {
      const { interactionMode } = get().getThreadSettings(threadId);
      await getTransport().sendMessage(
        threadId,
        content,
        model,
        permissionMode,
        attachments,
        displayContent,
        reasoningLevel,
        provider,
        interactionMode,
        copilotAgent,
        contextWindow,
        thinking,
        codexFastMode,
        replyToMessageId,
        quotedText,
        planAction,
      );
    } catch (e) {
      if (planAction === "revise") {
        usePlanStore.getState().setGenerating(threadId, false);
      }
      set((state) => {
        // Control commands never added the thread to running-state, so leave it
        // untouched on rollback - a real turn in flight may own it (#583).
        const next = new Set(state.runningThreadIds);
        if (!isControlCommand) next.delete(threadId);
        return {
          records: patchThreadRecord(state.records, threadId, {
            error: String(e),
            agentStartTime: undefined,
          }),
          runningThreadIds: next,
        };
      });
    }
  },

  /** Request the agent to stop on a thread. Always marks the thread as not running, even on error. */
  stopAgent: async (threadId) => {
    let stopSucceeded = false;
    patchRec(threadId, { awaitingUserStopPersist: true });
    try {
      await getTransport().stopAgent(threadId);
      stopSucceeded = true;
    } catch (e) {
      patchRec(threadId, () => ({
        error: String(e),
        awaitingUserStopPersist: undefined,
      }));
    }

    const snap = get();
    let lastUserText: string | null = null;
    if (snap.currentThreadId === threadId) {
      const messages = getRec(threadId).messages;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") {
          lastUserText = messages[i].content;
          break;
        }
      }
    }

    set((state) => {
      const next = new Set(state.runningThreadIds);
      next.delete(threadId);
      return {
        runningThreadIds: next,
        records: patchThreadRecord(state.records, threadId, (rec) => ({
          rateLimit: undefined,
          apiRetry: undefined,
          composerRecallFromStop:
            stopSucceeded && lastUserText !== null && state.currentThreadId === threadId
              ? { text: lastUserText }
              : rec.composerRecallFromStop,
        })),
      };
    });
  },

  hydrateRunningThreads: (ids) => {
    set((state) => {
      const current = state.runningThreadIds;
      if (current.size === ids.length && ids.every((id) => current.has(id))) {
        return {};
      }
      const now = Date.now();
      let records = state.records;
      for (const id of ids) {
        const rec = getThreadRecord(records, id);
        if (rec.agentStartTime === undefined) {
          records = patchThreadRecord(records, id, { agentStartTime: now });
        }
      }
      return { runningThreadIds: new Set(ids), records };
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

  /**
   * Reset the active thread's message list and ephemeral streaming state.
   * Does NOT reset runningThreadIds since agents may still be executing.
   */
  clearMessages: () => {
    flushPendingTextDeltas();
    const current = get().currentThreadId;
    if (current) evictCachedRecord(current);

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
          oldestLoadedSequence: 0,
          hasMoreMessages: false,
          isLoadingMore: false,
          loadEpoch: getThreadRecord(state.records, current).loadEpoch,
          persistedToolCallCounts: {},
          persistedFilesChanged: {},
          latestTurnWithChanges: null,
          serverMessageIds: {},
          narrativeByMessage: {},
        }),
      }));
    }
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
      permissionMode?: ThreadSettings["permissionMode"];
      copilotAgent?: string | null;
      contextWindow?: ContextWindowMode | null;
      thinking?: boolean | null;
      codexFastMode?: boolean | null;
      defaultOpenInApp?: string | null;
    } = {
      ...(patch.permissionMode !== undefined ? { permissionMode: patch.permissionMode } : {}),
      ...(patch.interactionMode !== undefined ? { interactionMode: patch.interactionMode } : {}),
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
    evictCachedRecord(threadId);
    clearDequeueTimer(threadId);
    forgetScrollTop(threadId);

    const isCurrentThread = get().currentThreadId === threadId;

    set((state) => {
      const nextRunning = new Set(state.runningThreadIds);
      nextRunning.delete(threadId);

      return {
        runningThreadIds: nextRunning,
        records: deleteThreadRecord(state.records, threadId),
        ...(isCurrentThread ? { currentThreadId: null } : {}),
      };
    });

    if (isCurrentThread) {
      get().toolCallRecordCache.clear();
    }
  },

  clearThreadStateMany: (threadIds) => {
    if (threadIds.length === 0) return;

    for (const threadId of threadIds) {
      evictCachedRecord(threadId);
      clearDequeueTimer(threadId);
      forgetScrollTop(threadId);
    }

    const currentThreadId = get().currentThreadId;
    const deletingCurrentThread = currentThreadId !== null && threadIds.includes(currentThreadId);

    set((state) => {
      const nextRunning = new Set(state.runningThreadIds);
      for (const threadId of threadIds) {
        nextRunning.delete(threadId);
      }

      let records = state.records;
      for (const threadId of threadIds) {
        records = deleteThreadRecord(records, threadId);
      }

      return {
        runningThreadIds: nextRunning,
        records,
        ...(deletingCurrentThread ? { currentThreadId: null } : {}),
      };
    });

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
      runningThreadIds: new Set([...s.runningThreadIds, threadId]),
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
        runningThreadIds: new Set([...Array.from(s.runningThreadIds).filter((id) => id !== threadId)]),
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

  loadNarrativeForMessage: async (messageId) => {
    const currentId = get().currentThreadId;
    if (!currentId) return;
    const rec = getRec(currentId);
    if (rec.narrativeByMessage[messageId]) return;
    const existing = narrativeInflight.get(messageId);
    if (existing) return existing;
    const p = getTransport()
      .listNarrative(messageId)
      .then((res) => {
        patchRec(currentId, (r) => ({
          narrativeByMessage: { ...r.narrativeByMessage, [messageId]: res },
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

  evictNarrativeForMessage: (messageId) => {
    const currentId = get().currentThreadId;
    if (!currentId) return;
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
  handleAgentEvent: (threadId, event) => {
    const method = (event.method as string) || "";
    const params = (event.params as Record<string, unknown>) || event;

    if (method !== "session.textDelta") {
      flushPendingTextDeltas();
    }

    // Only evict the message cache on structural changes that add or modify
    // persisted messages. Streaming deltas (textDelta, toolProgress) are
    // ephemeral and don't change what loadMessages would return from the DB.
    const isStructuralEvent =
      method === "session.turnComplete" ||
      method === "session.ended" ||
      method === "session.message" ||
      method === "session.error";
    if (isStructuralEvent) {
      evictCachedRecord(threadId);
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

    if (method !== "session.apiRetry" && getRec(threadId).apiRetry) {
      patchRec(threadId, { apiRetry: undefined });
    }

    if (method === "session.system") {
      const subtype = params.subtype as string;
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
          if (state.currentThreadId !== threadId) return {};
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

    if (method === "session.turnStarted") {
      set((state) => {
        if (state.runningThreadIds.has(threadId)) return {};
        const next = new Set(state.runningThreadIds);
        next.add(threadId);
        return {
          runningThreadIds: next,
          records: patchThreadRecord(state.records, threadId, {
            agentStartTime: Date.now(),
            ...resetTurnEphemeral(getThreadRecord(state.records, threadId)),
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

    if (method === "session.message") {
      markPriorToolCallsComplete();
      const content = (params.content as string) || "";
      if (content) {
        const message: Message = {
          id: (params.messageId as string) || crypto.randomUUID(),
          thread_id: threadId,
          role: "assistant",
          content,
          tool_calls: null,
          files_changed: null,
          cost_usd: null,
          tokens_used: (params.tokens as number) ?? null,
          timestamp: new Date().toISOString(),
          sequence: messageSequenceFor(threadId),
          attachments: null,
          // Server injects the model after persisting; defaults to null when
          // unknown (legacy clients, non-Claude providers without model info).
          model: (params.model as string | null | undefined) ?? null,
        };
        set((state) => {
          const rec = getThreadRecord(state.records, threadId);
          const segments = rec.thoughtSegments;
          const lastSeg = segments[segments.length - 1];
          const closedSegments =
            lastSeg && lastSeg.endedAt === undefined
              ? [...segments.slice(0, -1), { ...lastSeg, endedAt: Date.now() }]
              : segments;

          const turnPatch = {
            currentTurnMessageId: message.id,
            streaming: "",
            streamingPreview: "",
            thoughtSegments: closedSegments,
          };

          if (state.currentThreadId !== threadId) {
            return { records: patchThreadRecord(state.records, threadId, turnPatch) };
          }

          if (rec.messages.some((m) => m.id === message.id)) {
            return { records: patchThreadRecord(state.records, threadId, turnPatch) };
          }

          const last = rec.messages[rec.messages.length - 1];
          if (
            last?.role === "assistant" &&
            last.content === content &&
            last.id !== message.id
          ) {
            const previousId = last.id;
            const nextPersistedToolCallCounts = { ...rec.persistedToolCallCounts };
            if (previousId in nextPersistedToolCallCounts) {
              nextPersistedToolCallCounts[message.id] = nextPersistedToolCallCounts[previousId];
              delete nextPersistedToolCallCounts[previousId];
            }

            const nextPersistedFilesChanged = { ...rec.persistedFilesChanged };
            if (previousId in nextPersistedFilesChanged) {
              nextPersistedFilesChanged[message.id] = nextPersistedFilesChanged[previousId];
              delete nextPersistedFilesChanged[previousId];
            }

            const nextServerMessageIds = { ...rec.serverMessageIds };
            if (previousId in nextServerMessageIds) {
              nextServerMessageIds[message.id] = nextServerMessageIds[previousId];
              delete nextServerMessageIds[previousId];
            }

            const replaced = rec.messages.slice(0, -1).concat({
              ...last,
              id: message.id,
              tokens_used: message.tokens_used,
              timestamp: message.timestamp,
            });
            const { messages: capped, evicted } = capMessages(replaced);
            return {
              records: patchThreadRecord(state.records, threadId, {
                ...turnPatch,
                messages: capped,
                persistedToolCallCounts: nextPersistedToolCallCounts,
                persistedFilesChanged: nextPersistedFilesChanged,
                serverMessageIds: nextServerMessageIds,
                latestTurnWithChanges:
                  rec.latestTurnWithChanges === previousId ? message.id : rec.latestTurnWithChanges,
                ...(evicted ? { hasMoreMessages: true } : {}),
              }),
            };
          }

          const { messages: capped, evicted } = capMessages([...rec.messages, message]);
          return {
            records: patchThreadRecord(state.records, threadId, {
              ...turnPatch,
              messages: capped,
              ...(evicted ? { hasMoreMessages: true } : {}),
            }),
          };
        });
      }
      return;
    }

    if (method === "session.toolUse") {
      const toolCallId = (params.toolCallId as string) || "";
      const existingCalls = getRec(threadId).toolCalls;
      const toolName = (params.toolName as string) || "unknown";
      const incomingInput = (params.toolInput as Record<string, unknown>) || {};
      if (toolCallId) {
        const existing = existingCalls.find((tc) => tc.id === toolCallId);
        if (existing) {
          // Cursor Task: provisional ToolUse on tool_call, enriched ToolUse on cursor/task.
          if (
            !existing.isComplete &&
            existing.toolName === "Agent" &&
            toolName === "Agent"
          ) {
            set((state) => {
              const calls = getThreadRecord(state.records, threadId).toolCalls;
              const updated = calls.map((tc) =>
                tc.id === toolCallId
                  ? { ...tc, toolInput: { ...tc.toolInput, ...incomingInput } }
                  : tc,
              );
              return { records: patchThreadRecord(state.records, threadId, { toolCalls: updated }) };
            });
          }
          return;
        }
      }

      const parentToolCallId = params.parentToolCallId as string | undefined;

      // Only mark prior tool calls complete if this isn't a subagent's tool call
      // (subagent calls should not mark the parent Agent call as complete)
      if (!parentToolCallId) {
        markPriorToolCallsComplete();
      }
      // Intercept TodoWrite calls to populate the task panel.
      // Sub-agent calls are grouped by their parent Agent's description so
      // multiple sub-agents each get their own collapsible section.
      if (toolName === "TodoWrite") {
        const toolInput = (params.toolInput as Record<string, unknown>) || {};
        const todos = toolInput.todos as Array<Record<string, unknown>> | undefined;
        if (todos && Array.isArray(todos)) {
          const group = parentToolCallId
            ? resolveAgentGroupLabel(existingCalls, parentToolCallId)
            : "Tasks";

          const taskItems: TaskItem[] = todos.map((t, i) => ({
            id: t.id != null ? String(t.id) : String(i),
            content: String(t.content ?? ""),
            status: coerceTaskStatus(t.status),
            group,
          }));

          // Always merge by group so sub-agent groups are never wiped out
          // by a top-level TodoWrite call (or vice versa).
          useTaskStore.getState().setTaskGroup(threadId, group, taskItems);
        }
      }

      const toolCall: ToolCall = {
        id: toolCallId || crypto.randomUUID(),
        toolName,
        toolInput: incomingInput,
        output: null,
        isError: false,
        isComplete: false,
        parentToolCallId: parentToolCallId || undefined,
        startedAt: Date.now(),
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

    if (method === "session.toolResult") {
      const toolCallId = (params.toolCallId as string) || "";
      const output = (params.output as string) || "";
      const isError = (params.isError as boolean) || false;
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
          const fromInput = tc.toolInput.durationMs;
          const durationMs =
            typeof fromInput === "number" && Number.isFinite(fromInput)
              ? fromInput
              : tc.startedAt != null
                ? Math.max(0, Date.now() - tc.startedAt)
                : undefined;
          return {
            ...tc,
            output,
            isError,
            isComplete: true,
            ...(durationMs != null ? { durationMs } : {}),
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
    if (method === "session.textDelta") {
      const delta = (params.delta as string) || "";
      if (!delta) return;
      const isFinalResponse = params.isFinalResponse === true;
      const hadPending = pendingTextDeltaByThread.has(threadId);
      const existing = pendingTextDeltaByThread.get(threadId) ?? [];
      const next = [...existing];
      const tail = next[next.length - 1];
      if (tail && tail.isFinalResponse === isFinalResponse) {
        next[next.length - 1] = { delta: tail.delta + delta, isFinalResponse };
      } else {
        next.push({ delta, isFinalResponse });
      }
      pendingTextDeltaByThread.set(threadId, next);
      if (!hadPending) {
        markPriorToolCallsComplete();
      }
      scheduleTextDeltaFlush();
      return;
    }

    if (method === "session.assistantMessageBoundary") {
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
      const isFinalResponse = params.isFinalResponse === true;
      // Flush any pending text delta chunks first so the open thought we
      // operate on reflects every delta that arrived for this message.
      flushPendingTextDeltas();
      set((state) => {
        const rec = getThreadRecord(state.records, threadId);
        const segments = rec.thoughtSegments;
        const last = segments[segments.length - 1];
        if (!last || last.endedAt !== undefined) {
          return state;
        }
        const nextSegments = isFinalResponse
          ? segments.slice(0, -1)
          : [...segments.slice(0, -1), { ...last, endedAt: Date.now() }];
        return {
          records: patchThreadRecord(state.records, threadId, {
            thoughtSegments: nextSegments,
          }),
        };
      });
      return;
    }

    if (method === "session.toolProgress") {
      const toolCallId = (params.toolCallId as string) || "";
      const elapsedSeconds = (params.elapsedSeconds as number) ?? 0;
      if (!toolCallId) return;
      set((state) => {
        const current = getThreadRecord(state.records, threadId).toolCalls;
        let changed = false;
        const updated = current.map((tc) => {
          if (tc.id === toolCallId && !tc.isComplete && tc.elapsedSeconds !== elapsedSeconds) {
            changed = true;
            return { ...tc, elapsedSeconds };
          }
          return tc;
        });
        // Return same state reference when nothing changed — Zustand skips notification.
        if (!changed) return state;
        return { records: patchThreadRecord(state.records, threadId, { toolCalls: updated }) };
      });
      return;
    }

    if (method === "session.hookStarted") {
      const hookName = (params.hookName as string) || "unknown";
      const hookType = (params.hookType as "permission" | "stop") || "stop";
      const toolName = params.toolName as string | undefined;
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

    if (method === "session.hookProgress") {
      const hookName = (params.hookName as string) || "";
      const output = (params.output as string) || "";
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

    if (method === "session.hookCompleted") {
      const hookName = (params.hookName as string) || "";
      const exitCode = (params.exitCode as number) ?? 1;
      const durationMs = (params.durationMs as number) ?? 0;
      const didBlock = (params.didBlock as boolean) ?? false;
      const persistedMessageId = params.persistedMessageId as string | undefined;
      const persistedHookId = params.persistedHookId as string | undefined;
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

    if (method === "session.turnComplete" || method === "session.ended") {
      const costUsd = (params.costUsd as number) ?? null;
      const tokensIn = ((params.tokensIn as number) ?? (params.totalTokensIn as number)) ?? 0;
      const tokensOut = ((params.tokensOut as number) ?? (params.totalTokensOut as number)) ?? 0;

      // Commit any remaining streaming content and stop the agent,
      // Tool calls remain in-place and collapse into a summary.
      const streamContent = getRec(threadId).streaming;

      // Build an ephemeral system message for guardrail stops (budget/turn limit).
      // Folded into the same set() call to avoid a double render pass.
      const reason = method === "session.turnComplete" ? params.reason as string | undefined : undefined;
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
          const nextRunning = new Set(state.runningThreadIds);
          nextRunning.delete(threadId);
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

          const basePatch = {
            streaming: "",
            streamingPreview: "",
            thoughtSegments: closedSegments,
            toolCalls: completedCalls,
            permissions: [] as StoredPermission[],
            rateLimit: undefined,
          };

          if (state.currentThreadId !== threadId) {
            return {
              runningThreadIds: nextRunning,
              records: patchThreadRecord(state.records, threadId, basePatch),
            };
          }

          const { messages: capped, evicted } = capMessages([...rec.messages, ...pending]);
          return {
            runningThreadIds: nextRunning,
            records: patchThreadRecord(state.records, threadId, {
              ...basePatch,
              messages: capped,
              ...(evicted ? { hasMoreMessages: true } : {}),
            }),
          };
        });
      } else {
        set((state) => {
          const rec = getThreadRecord(state.records, threadId);
          const nextRunning = new Set(state.runningThreadIds);
          nextRunning.delete(threadId);
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
            toolCalls: completedCalls,
            permissions: [] as StoredPermission[],
            rateLimit: undefined,
          };

          if (dedupedGuardrail && state.currentThreadId === threadId) {
            const { messages: capped, evicted } = capMessages([...rec.messages, dedupedGuardrail]);
            return {
              runningThreadIds: nextRunning,
              records: patchThreadRecord(state.records, threadId, {
                ...basePatch,
                messages: capped,
                ...(evicted ? { hasMoreMessages: true } : {}),
              }),
            };
          }

          return {
            runningThreadIds: nextRunning,
            records: patchThreadRecord(state.records, threadId, basePatch),
          };
        });
      }

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
        const sdkContextWindow = params.contextWindow as number | undefined;
        const totalProcessedTokens = params.totalProcessedTokens as number | undefined;
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
              cacheReadTokens: params.cacheReadTokens as number | undefined,
              cacheWriteTokens: params.cacheWriteTokens as number | undefined,
              costMultiplier: params.costMultiplier as number | undefined,
            },
          }),
        }));
      }

      // Tool calls remain in state (all marked complete). They render as
      // a collapsed summary in-place. When turn.persisted fires, the DB-backed
      // summary replaces them and tool calls are cleared.

      // Sync the thread's status in workspaceStore so the sidebar shows
      // the green "Completed" badge without waiting for a full thread reload.
      // If the user is already viewing this thread, skip the badge and
      // immediately mark viewed so the DB transitions to "paused".
      const isActiveThread = useWorkspaceStore.getState().activeThreadId === threadId;
      if (isActiveThread) {
        getTransport().markThreadViewed(threadId).catch(() => {});
      } else {
        useWorkspaceStore.setState((ws) => ({
          threads: ws.threads.map((t) =>
            t.id === threadId ? { ...t, status: "completed" as const } : t,
          ),
        }));
      }

      // Auto-dequeue: send next queued message after a brief visual pause.
      // Only on turnComplete (not session.ended) so explicit stops don't drain the queue.
      // Uses tracked timers to prevent double-dequeue from duplicate events.
      // Skip dequeue when a guardrail stopped the session to avoid restarting
      // an agent that was intentionally capped by budget or turn limits.
      if (method === "session.turnComplete" && !isGuardrailStop) {
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

    if (method === "session.quotaUpdate") {
      const providerId = params.providerId as string;
      const categories = Array.isArray(params.categories)
        ? (params.categories as QuotaCategory[])
        : [];
      const sessionCostUsd = params.sessionCostUsd as number | undefined;
      const serviceTier = params.serviceTier as "standard" | "priority" | "batch" | undefined;
      const numTurns = params.numTurns as number | undefined;
      const durationMs = params.durationMs as number | undefined;
      if (providerId) {
        set((state) => {
          const rec = getThreadRecord(state.records, threadId);
          const existing = rec.usageByProvider[providerId];
          return {
            records: patchThreadRecord(state.records, threadId, {
              usageByProvider: {
                ...rec.usageByProvider,
                [providerId]: {
                  providerId,
                  quotaCategories: categories.length > 0 ? categories : (existing?.quotaCategories ?? []),
                  sessionCostUsd: sessionCostUsd ?? existing?.sessionCostUsd,
                  serviceTier: serviceTier ?? existing?.serviceTier,
                  numTurns: numTurns ?? existing?.numTurns,
                  durationMs: durationMs ?? existing?.durationMs,
                },
              },
            }),
          };
        });
        get().fetchProviderUsage(threadId, providerId);
      }
      return;
    }

    if (method === "session.contextEstimate") {
      const tokensIn = params.tokensIn as number;
      const ctxWindow = params.contextWindow as number | undefined;
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

    if (method === "session.rateLimited") {
      const active = params.active as boolean;
      patchRec(threadId, {
        rateLimit: active
          ? {
              retryAfterMs: params.retryAfterMs as number | undefined,
              limitType: params.limitType as string | undefined,
              utilization: params.utilization as number | undefined,
            }
          : undefined,
      });
      return;
    }

    if (method === "session.apiRetry") {
      patchRec(threadId, {
        apiRetry: {
          reason: params.reason as string,
          attempt: params.attempt as number | undefined,
          maxRetries: params.maxRetries as number | undefined,
          delayMs: params.delayMs as number | undefined,
        },
      });
      return;
    }

    if (method === "session.compacting") {
      const active = params.active as boolean;
      if (!active) {
        const wasCompacting = getRec(threadId).isCompacting;
        if (wasCompacting && get().currentThreadId === threadId) {
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
          get().addMessage(systemMsg);
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

    if (method === "session.modelFallback") {
      const requestedModel = params.requestedModel as string;
      const actualModel = params.actualModel as string;

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

    if (method === "session.error") {
      const errorMsg = typeof params.error === "string" ? params.error : String(params.error ?? "Unknown error");
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
        const nextRunning = new Set(state.runningThreadIds);
        nextRunning.delete(threadId);
        const basePatch = {
          error: errorMsg,
          streaming: "",
          streamingPreview: "",
          agentStartTime: undefined,
          toolCalls: [] as ToolCall[],
          isCompacting: false,
          rateLimit: undefined,
          apiRetry: undefined,
        };
        if (state.currentThreadId !== threadId) {
          return {
            runningThreadIds: nextRunning,
            records: patchThreadRecord(state.records, threadId, basePatch),
          };
        }
        const { messages: capped, evicted } = capMessages([...rec.messages, errorMessage]);
        return {
          runningThreadIds: nextRunning,
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

  },

  /**
   * Fetch provider usage from the server and merge it into usageByProvider.
   * Silently ignores errors so the popover shows stale or empty state rather than crashing.
   */
  fetchProviderUsage: async (threadId, providerId) => {
    try {
      const usage = await getTransport().getProviderUsage(providerId);
      patchRec(threadId, (rec) => ({
        usageByProvider: {
          ...rec.usageByProvider,
          [providerId]: { ...rec.usageByProvider[providerId], ...usage },
        },
      }));
    } catch {
      // Silently fail — popover shows stale or empty state
    }
  },

  clearInterruptStopFileNotice: (threadId) => {
    patchRec(threadId, { interruptStopFileNotice: undefined });
  },

  clearComposerRecallFromStop: (threadId) => {
    patchRec(threadId, { composerRecallFromStop: undefined });
  },

  handleTurnPersisted: (payload) => {
    flushPendingTextDeltas();
    evictCachedRecord(payload.threadId);

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

      let localMsgId = payload.messageId;
      const trackedMsgId = rec.currentTurnMessageId;
      if (trackedMsgId) {
        localMsgId = trackedMsgId;
      } else if (state.currentThreadId === payload.threadId) {
        for (let i = rec.messages.length - 1; i >= 0; i--) {
          if (rec.messages[i].role === "assistant") {
            localMsgId = rec.messages[i].id;
            break;
          }
        }
      }

      return {
        records: patchThreadRecord(state.records, payload.threadId, {
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
          currentTurnMessageId: "",
          interruptStopFileNotice,
          awaitingUserStopPersist,
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
        const rec = getRec(currentId);
        const serverRes = rec.narrativeByMessage[payload.messageId];
        if (!serverRes || !localIdForBackfill) return;
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
