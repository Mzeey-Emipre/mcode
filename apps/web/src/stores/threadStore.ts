import { create } from "zustand";
import type { Message, ToolCall, PermissionMode, InteractionMode, AttachmentMeta, ToolCallRecord } from "@/transport";
import type { ReasoningLevel, PlanQuestion, PlanAnswer } from "@mcode/contracts";
import { PlanQuestionSchema } from "@mcode/contracts";
import { getTransport, PERMISSION_MODES, INTERACTION_MODES } from "@/transport";
import { useWorkspaceStore } from "./workspaceStore";
import { useQueueStore } from "./queueStore";
import { LruCache } from "@/lib/lru-cache";
import { useTaskStore, coerceTaskStatus } from "./taskStore";
import type { TaskItem } from "./taskStore";
import { useToastStore } from "./toastStore";
import { findModelById, getContextWindow, DEFAULT_CONTEXT_WINDOW } from "@/lib/model-registry";

export interface ThreadSettings {
  permissionMode: PermissionMode;
  interactionMode: InteractionMode;
  /** Reasoning level selected for this thread, forwarded on the post-wizard answer turn. */
  reasoningLevel?: ReasoningLevel;
}

interface ThreadState {
  messages: Message[];
  runningThreadIds: Set<string>;
  loading: boolean;
  error: string | null;
  currentThreadId: string | null;
  /** Full accumulated streaming text per thread, used for finalization into a message. */
  streamingByThread: Record<string, string>;
  /** Tail-truncated preview of the streaming text (last 200 chars), used by StreamingCard for render optimization. */
  streamingPreviewByThread: Record<string, string>;
  toolCallsByThread: Record<string, ToolCall[]>;
  agentStartTimes: Record<string, number>;
  /** Per-thread permission mode and interaction mode. */
  settingsByThread: Record<string, ThreadSettings>;
  /** Tool call counts per message ID, populated from turn.persisted events and loadMessages. */
  persistedToolCallCounts: Record<string, number>;
  /** Files changed per message ID, populated from turn.persisted events. Empty array = no changes. */
  persistedFilesChanged: Record<string, string[]>;
  /** Message ID of the most recent completed turn with file changes. Only this turn's summary is expanded; older ones auto-collapse. */
  latestTurnWithChanges: string | null;
  /** Maps client-generated message IDs to server-persisted message IDs for API calls. */
  serverMessageIds: Record<string, string>;
  /** Active subagent count per thread (incremented on Agent toolUse, decremented on Agent toolResult). */
  activeSubagentsByThread: Record<string, number>;
  /** Cache for tool call records to avoid re-fetching from server. */
  toolCallRecordCache: LruCache<string, ToolCallRecord[]>;
  /** Tracks the local message ID for the most recent assistant message per thread, used by handleTurnPersisted to correctly assign tool call counts. */
  currentTurnMessageIdByThread: Record<string, string>;
  /** Lowest sequence number currently loaded per thread, used as cursor for "load older". */
  oldestLoadedSequence: Record<string, number>;
  /** Whether older messages exist beyond what is loaded, per thread. */
  hasMoreMessages: Record<string, boolean>;
  /** Guard against duplicate scroll-triggered fetches per thread. */
  isLoadingMore: Record<string, boolean>;
  /** Monotonic counter incremented on each loadMessages call, used to discard stale loadOlderMessages responses. */
  loadEpochByThread: Record<string, number>;
  /** Last known token usage and context window size per thread, updated on turn completion. */
  contextByThread: Record<string, { lastTokensIn: number; contextWindow: number }>;
  /** Whether the SDK is currently compacting the context window for a thread. */
  isCompactingByThread: Record<string, boolean>;
  /** Questions proposed by the model in plan mode, keyed by thread ID. Null when not pending. */
  planQuestionsByThread: Record<string, PlanQuestion[] | null>;
  /** User's answers to plan questions, keyed by thread ID then question ID. */
  planAnswersByThread: Record<string, Map<string, PlanAnswer>>;
  /** Currently focused question index per thread (0-based). */
  activeQuestionIndexByThread: Record<string, number>;
  /** Plan wizard status per thread. */
  planQuestionsStatusByThread: Record<string, "idle" | "pending" | "answered">;

  /** Store tool call records in the cache. */
  cacheToolCallRecords: (key: string, records: ToolCallRecord[]) => void;
  /** Retrieve cached tool call records, or null if not cached. */
  getCachedToolCallRecords: (key: string) => ToolCallRecord[] | null;
  /** Evict the entire tool call record cache. Records are re-fetched on next expand. */
  clearToolCallRecordCache: () => void;

  // Message actions
  loadMessages: (threadId: string) => Promise<void>;
  loadOlderMessages: (threadId: string) => Promise<void>;
  sendMessage: (threadId: string, content: string, model?: string, permissionMode?: PermissionMode, attachments?: AttachmentMeta[], displayContent?: string, reasoningLevel?: ReasoningLevel, provider?: string) => Promise<void>;
  stopAgent: (threadId: string) => Promise<void>;
  addMessage: (message: Message) => void;
  clearMessages: () => void;
  isThreadRunning: (threadId: string) => boolean;
  /** Set questions received from the model and show the wizard. */
  setPlanQuestions: (threadId: string, questions: PlanQuestion[]) => void;
  /** Record the user's answer for one question. */
  setPlanAnswer: (threadId: string, questionId: string, answer: PlanAnswer) => void;
  /** Navigate to a specific question index. */
  setActiveQuestionIndex: (threadId: string, index: number) => void;
  /** Submit all answers to the server and dismiss the wizard. */
  submitPlanAnswers: (threadId: string) => Promise<void>;
  /** Reset plan question state for a thread (called on clear/reload). */
  clearPlanQuestions: (threadId: string) => void;
  handleAgentEvent: (threadId: string, event: Record<string, unknown>) => void;

  /** Handle server-side tool call persistence confirmation. */
  handleTurnPersisted: (payload: { threadId: string; messageId: string; toolCallCount: number; filesChanged: string[] }) => void;

  // Per-thread settings
  getThreadSettings: (threadId: string) => ThreadSettings;
  setThreadSettings: (threadId: string, settings: Partial<ThreadSettings>) => void;
}

/** Pending dequeue timers per thread, so duplicate turnComplete events don't double-dequeue. */
const dequeueTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearDequeueTimer(threadId: string) {
  const timer = dequeueTimers.get(threadId);
  if (timer) {
    clearTimeout(timer);
    dequeueTimers.delete(threadId);
  }
}

const DEFAULT_THREAD_SETTINGS: ThreadSettings = {
  permissionMode: PERMISSION_MODES.FULL,
  interactionMode: INTERACTION_MODES.CHAT,
};

/** Maximum entries in the tool call record LRU cache. */
export const TOOL_CALL_CACHE_SIZE = 200;

/** Number of older messages to fetch per pagination request. */
export const OLDER_PAGE_SIZE = 50;

/** Maximum messages kept in the in-memory sliding window. */
export const MESSAGE_WINDOW_SIZE = 200;

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
function extractPendingPlanQuestions(messages: Message[]): PlanQuestion[] | null {
  const PLAN_QUESTIONS_RE = /```plan-questions\n([\s\S]*?)```/;

  // Walk messages in reverse to find the last assistant message with a plan-questions block
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "user") {
      // A user message after the assistant message means questions were already answered
      return null;
    }
    if (msg.role === "assistant") {
      const match = PLAN_QUESTIONS_RE.exec(msg.content);
      if (!match) return null;
      try {
        const raw = JSON.parse(match[1]);
        if (!Array.isArray(raw)) return null;
        const results = raw.map((item) => PlanQuestionSchema.safeParse(item));
        // Reject the whole batch if any question fails — partial batches break
        // index continuity between the wizard UI and the answer map keys.
        if (results.some((r) => !r.success)) return null;
        const validated = results.map((r) => (r as { success: true; data: PlanQuestion }).data);
        return validated.length > 0 ? validated : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

export const useThreadStore = create<ThreadState>((set, get) => {
  return {
  messages: [],
  runningThreadIds: new Set<string>(),
  loading: false,
  error: null,
  currentThreadId: null,
  streamingByThread: {},
  streamingPreviewByThread: {},
  toolCallsByThread: {},
  agentStartTimes: {},
  settingsByThread: {},
  persistedToolCallCounts: {},
  persistedFilesChanged: {},
  latestTurnWithChanges: null,
  serverMessageIds: {},
  activeSubagentsByThread: {},
  toolCallRecordCache: new LruCache<string, ToolCallRecord[]>(TOOL_CALL_CACHE_SIZE),
  currentTurnMessageIdByThread: {},
  oldestLoadedSequence: {},
  hasMoreMessages: {},
  isLoadingMore: {},
  loadEpochByThread: {},
  contextByThread: {},
  isCompactingByThread: {},
  planQuestionsByThread: {},
  planAnswersByThread: {},
  activeQuestionIndexByThread: {},
  planQuestionsStatusByThread: {},

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
   * For non-running threads, clears stale real-time state (tool calls,
   * streaming text, agent start times) so artifacts
   * from a previous visit don't linger. Running threads keep their
   * real-time state intact to avoid disrupting live tool call rendering.
   */
  loadMessages: async (threadId) => {
    // Clear stale real-time state for non-running threads so tool calls
    // from a previous visit don't linger when switching back.
    const isRunning = get().runningThreadIds.has(threadId);
    if (!isRunning) {
      get().toolCallRecordCache.clear();
      set((state) => {
        const nextToolCalls = { ...state.toolCallsByThread };
        delete nextToolCalls[threadId];
        const nextStreaming = { ...state.streamingByThread };
        delete nextStreaming[threadId];
        const nextStartTimes = { ...state.agentStartTimes };
        delete nextStartTimes[threadId];
        const nextTurnMsgIds = { ...state.currentTurnMessageIdByThread };
        delete nextTurnMsgIds[threadId];
        const nextCompacting = { ...state.isCompactingByThread };
        delete nextCompacting[threadId];
        return {
          loading: true,
          error: null,
          currentThreadId: threadId,
          messages: [],
          persistedToolCallCounts: {},
          persistedFilesChanged: {},
          latestTurnWithChanges: null,
          isLoadingMore: {},
          loadEpochByThread: { ...state.loadEpochByThread, [threadId]: (state.loadEpochByThread[threadId] ?? 0) + 1 },
          toolCallsByThread: nextToolCalls,
          streamingByThread: nextStreaming,
          agentStartTimes: nextStartTimes,
          currentTurnMessageIdByThread: nextTurnMsgIds,
          isCompactingByThread: nextCompacting,
        };
      });
    } else {
      set((state) => ({
        loading: true,
        error: null,
        currentThreadId: threadId,
        messages: [],
        persistedToolCallCounts: {},
        persistedFilesChanged: {},
        latestTurnWithChanges: null,
        isLoadingMore: {},
        loadEpochByThread: { ...state.loadEpochByThread, [threadId]: (state.loadEpochByThread[threadId] ?? 0) + 1 },
      }));
    }
    try {
      const { messages, hasMore } = await getTransport().getMessages(threadId, 100);
      // Only commit if this thread is still current
      if (get().currentThreadId === threadId) {
        // Populate persisted tool call counts from loaded messages
        const counts: Record<string, number> = {};
        for (const msg of messages) {
          if (msg.tool_call_count && msg.tool_call_count > 0) {
            counts[msg.id] = msg.tool_call_count;
          }
        }
        const oldest = messages.length > 0 ? messages[0].sequence : 0;
        set({
          messages,
          loading: false,
          persistedToolCallCounts: counts,
          oldestLoadedSequence: { [threadId]: oldest },
          hasMoreMessages: { [threadId]: hasMore },
          isLoadingMore: {},
        });

        // Hydrate task panel from persisted TodoWrite state.
        getTransport()
          .getThreadTasks(threadId)
          .then((tasks) => {
            if (tasks && tasks.length > 0 && !useTaskStore.getState().tasksByThread[threadId]?.length) {
              const items: TaskItem[] = tasks.map((t, i) => ({
                id: String(i),
                content: t.content,
                status: coerceTaskStatus(t.status),
                group: "Tasks",
              }));
              useTaskStore.getState().setTasks(threadId, items);
            }
          })
          .catch((err) => {
            console.debug("[taskHydration] Failed to load tasks for thread %s:", threadId, err);
          });

        // Restore the plan question wizard if an unanswered plan-questions block
        // exists in the loaded messages. This handles app restart without losing wizard state.
        const existingStatus = get().planQuestionsStatusByThread[threadId];
        if (existingStatus !== "pending") {
          const pendingQuestions = extractPendingPlanQuestions(messages);
          if (pendingQuestions) {
            get().setPlanQuestions(threadId, pendingQuestions);
          }
        }

        // Populate file change summaries from persisted snapshots
        getTransport()
          .listSnapshots(threadId)
          .then((snapshots) => {
            if (snapshots.length === 0) return;
            set((state) => {
              const nextFilesChanged = { ...state.persistedFilesChanged };
              let latestMsgId = state.latestTurnWithChanges;
              let latestTime = "";

              for (const snap of snapshots) {
                if (snap.files_changed.length === 0) continue;
                // Map server message_id to local message ID if possible
                const localId = Object.entries(state.serverMessageIds).find(
                  ([, serverId]) => serverId === snap.message_id,
                )?.[0] ?? snap.message_id;
                nextFilesChanged[localId] = snap.files_changed;
                if (snap.created_at > latestTime) {
                  latestTime = snap.created_at;
                  latestMsgId = localId;
                }
              }

              return {
                persistedFilesChanged: nextFilesChanged,
                latestTurnWithChanges: latestMsgId,
              };
            });
          })
          .catch(() => {});
      }
    } catch (e) {
      if (get().currentThreadId === threadId) {
        set({ error: String(e), loading: false });
      }
    }
  },

  /**
   * Fetch the next batch of older messages for scroll-up pagination.
   * Uses sequence cursor to load messages older than what is currently in memory.
   * Guards against duplicate in-flight requests and stale thread responses.
   */
  loadOlderMessages: async (threadId) => {
    const state = get();
    if (!state.hasMoreMessages[threadId]) return;
    if (state.isLoadingMore[threadId]) return;

    set((s) => ({
      isLoadingMore: { ...s.isLoadingMore, [threadId]: true },
    }));

    try {
      const cursor = get().oldestLoadedSequence[threadId];
      const epoch = get().loadEpochByThread[threadId] ?? 0;
      const { messages: olderMessages, hasMore } = await getTransport().getMessages(threadId, OLDER_PAGE_SIZE, cursor);

      // Discard if thread switched or loadMessages reset state since we started
      const isStale = get().currentThreadId !== threadId
        || (get().loadEpochByThread[threadId] ?? 0) !== epoch;
      if (isStale) {
        set((s) => ({ isLoadingMore: { ...s.isLoadingMore, [threadId]: false } }));
        return;
      }

      // Populate tool call counts from older messages
      const newCounts: Record<string, number> = {};
      for (const msg of olderMessages) {
        if (msg.tool_call_count && msg.tool_call_count > 0) {
          newCounts[msg.id] = msg.tool_call_count;
        }
      }

      const newOldest = olderMessages.length > 0 ? olderMessages[0].sequence : cursor;

      set((s) => ({
        messages: [...olderMessages, ...s.messages],
        persistedToolCallCounts: { ...s.persistedToolCallCounts, ...newCounts },
        oldestLoadedSequence: { ...s.oldestLoadedSequence, [threadId]: newOldest },
        hasMoreMessages: { ...s.hasMoreMessages, [threadId]: hasMore },
        isLoadingMore: { ...s.isLoadingMore, [threadId]: false },
      }));
    } catch {
      // Silent failure: reset loading guard so next scroll can retry
      set((s) => ({
        isLoadingMore: { ...s.isLoadingMore, [threadId]: false },
      }));
    }
  },

  /**
   * Send a user message and start the agent. Optimistically appends the
   * message to local state, marks the thread as running, then dispatches
   * to the transport layer. On failure, rolls back the running state.
   */
  sendMessage: async (threadId, content, model, permissionMode, attachments, displayContent, reasoningLevel, provider) => {
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
      sequence: get().messages.length + 1,
      attachments: attachments?.map((a) => ({
        id: a.id,
        name: a.name,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
      })) ?? null,
    };

    set((state) => ({
      ...(state.currentThreadId === threadId
        ? (() => {
            const { messages: capped, evicted } = capMessages([...state.messages, userMessage]);
            return { messages: capped, ...(evicted && state.currentThreadId ? { hasMoreMessages: { ...state.hasMoreMessages, [state.currentThreadId]: true } } : {}) };
          })()
        : {}),
      runningThreadIds: new Set([...state.runningThreadIds, threadId]),
      agentStartTimes: { ...state.agentStartTimes, [threadId]: Date.now() },
      // Persist reasoningLevel so the post-wizard answer turn forwards the same setting
      settingsByThread: reasoningLevel !== undefined
        ? { ...state.settingsByThread, [threadId]: { ...state.getThreadSettings(threadId), reasoningLevel } }
        : state.settingsByThread,
      error: null,
    }));

    try {
      const { interactionMode } = get().getThreadSettings(threadId);
      await getTransport().sendMessage(threadId, content, model, permissionMode, attachments, reasoningLevel, provider, interactionMode);
    } catch (e) {
      set((state) => {
        const next = new Set(state.runningThreadIds);
        next.delete(threadId);
        const nextStartTimes = { ...state.agentStartTimes };
        delete nextStartTimes[threadId];
        return { error: String(e), runningThreadIds: next, agentStartTimes: nextStartTimes };
      });
    }
  },

  /** Request the agent to stop on a thread. Always marks the thread as not running, even on error. */
  stopAgent: async (threadId) => {
    try {
      await getTransport().stopAgent(threadId);
    } catch (e) {
      set({ error: String(e) });
    }
    // Always mark as stopped, even on error
    set((state) => {
      const next = new Set(state.runningThreadIds);
      next.delete(threadId);
      return {
        runningThreadIds: next,
      };
    });
  },

  /** Append a single message to the current thread's message list. */
  addMessage: (message) => {
    set((state) => {
      const next = [...state.messages, message];
      const { messages: capped, evicted } = capMessages(next);
      return {
        messages: capped,
        ...(evicted && state.currentThreadId ? { hasMoreMessages: { ...state.hasMoreMessages, [state.currentThreadId]: true } } : {}),
      };
    });
  },

  /**
   * Reset the shared message list and all ephemeral streaming state.
   * Does NOT reset runningThreadIds since agents may still be executing.
   */
  clearMessages: () => {
    get().toolCallRecordCache.clear();
    set({
      messages: [],
      error: null,
      streamingByThread: {},
      streamingPreviewByThread: {},
      toolCallsByThread: {},
      persistedToolCallCounts: {},
      persistedFilesChanged: {},
      latestTurnWithChanges: null,
      serverMessageIds: {},
      currentTurnMessageIdByThread: {},
      oldestLoadedSequence: {},
      hasMoreMessages: {},
      isLoadingMore: {},
      loadEpochByThread: {},
    });
    // Note: does NOT reset runningThreadIds - agents may still be running
  },

  /** Check whether an agent is currently executing on the given thread. */
  isThreadRunning: (threadId) => {
    return get().runningThreadIds.has(threadId);
  },

  /** Return per-thread settings (permission mode, interaction mode), falling back to defaults. */
  getThreadSettings: (threadId) => {
    return get().settingsByThread[threadId] ?? DEFAULT_THREAD_SETTINGS;
  },

  /** Merge partial settings into the per-thread settings record. */
  setThreadSettings: (threadId, settings) => {
    set((state) => ({
      settingsByThread: {
        ...state.settingsByThread,
        [threadId]: { ...state.getThreadSettings(threadId), ...settings },
      },
    }));
  },

  setPlanQuestions: (threadId, questions) => {
    set((state) => ({
      planQuestionsByThread: { ...state.planQuestionsByThread, [threadId]: questions },
      planAnswersByThread: { ...state.planAnswersByThread, [threadId]: new Map() },
      activeQuestionIndexByThread: { ...state.activeQuestionIndexByThread, [threadId]: 0 },
      planQuestionsStatusByThread: { ...state.planQuestionsStatusByThread, [threadId]: "pending" },
    }));
  },

  setPlanAnswer: (threadId, questionId, answer) => {
    set((state) => {
      const existing = state.planAnswersByThread[threadId] ?? new Map<string, PlanAnswer>();
      const updated = new Map(existing);
      updated.set(questionId, answer);
      return {
        planAnswersByThread: { ...state.planAnswersByThread, [threadId]: updated },
      };
    });
  },

  setActiveQuestionIndex: (threadId, index) => {
    set((state) => ({
      activeQuestionIndexByThread: { ...state.activeQuestionIndexByThread, [threadId]: index },
    }));
  },

  submitPlanAnswers: async (threadId) => {
    const state = get();
    const answersMap = state.planAnswersByThread[threadId] ?? new Map<string, PlanAnswer>();
    const questions = state.planQuestionsByThread[threadId] ?? [];
    const { permissionMode, reasoningLevel } = state.getThreadSettings(threadId);

    // Build an answer for every question; unanswered questions get nulls
    const answers: PlanAnswer[] = questions.map((q) => {
      const a = answersMap.get(q.id);
      return a ?? { questionId: q.id, selectedOptionId: null, freeText: null };
    });

    // Hide the wizard and mark the thread running before the RPC so the
    // composer stays disabled for the entire continuation request, not just
    // after it resolves.
    set((s) => ({
      planQuestionsStatusByThread: { ...s.planQuestionsStatusByThread, [threadId]: "answered" },
      runningThreadIds: new Set([...s.runningThreadIds, threadId]),
      agentStartTimes: { ...s.agentStartTimes, [threadId]: Date.now() },
    }));

    try {
      await getTransport().answerPlanQuestions(threadId, answers, permissionMode, reasoningLevel);
    } catch (e) {
      // Revert to pending on error so user can retry
      set((s) => ({
        planQuestionsStatusByThread: { ...s.planQuestionsStatusByThread, [threadId]: "pending" },
        runningThreadIds: new Set([...Array.from(s.runningThreadIds).filter((id) => id !== threadId)]),
        error: String(e),
      }));
    }
  },

  clearPlanQuestions: (threadId) => {
    set((state) => {
      const nextQuestions = { ...state.planQuestionsByThread };
      const nextAnswers = { ...state.planAnswersByThread };
      const nextIndex = { ...state.activeQuestionIndexByThread };
      const nextStatus = { ...state.planQuestionsStatusByThread };
      delete nextQuestions[threadId];
      delete nextAnswers[threadId];
      delete nextIndex[threadId];
      delete nextStatus[threadId];
      return {
        planQuestionsByThread: nextQuestions,
        planAnswersByThread: nextAnswers,
        activeQuestionIndexByThread: nextIndex,
        planQuestionsStatusByThread: nextStatus,
      };
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

    // Helper: mark all prior incomplete tool calls as complete.
    // The Claude Agent SDK handles tool execution internally and does not
    // emit standalone "session.toolResult" events. So when a new event
    // arrives that implies previous tools finished (new toolUse, message,
    // delta, or turnComplete), we mark prior calls as done.
    const markPriorToolCallsComplete = () => {
      const calls = get().toolCallsByThread[threadId];
      if (!calls || !calls.some((tc) => !tc.isComplete)) return;
      set((state) => {
        const current = state.toolCallsByThread[threadId] ?? [];
        // Count how many Agent calls are being completed in this sweep.
        const agentCompletions = current.filter(
          (tc) => !tc.isComplete && tc.toolName === "Agent"
        ).length;
        const updated = current.map((tc) =>
          tc.isComplete ? tc : { ...tc, isComplete: true }
        );
        const result: Partial<ThreadState> = {
          toolCallsByThread: { ...state.toolCallsByThread, [threadId]: updated },
        };
        if (agentCompletions > 0) {
          // Fall back to agentCompletions when the counter is absent — this keeps the
          // arithmetic correct even if the increment was missed (e.g. the Agent toolUse
          // event arrived on a thread we weren't tracking yet).
          const count = (state.activeSubagentsByThread[threadId] ?? agentCompletions) - agentCompletions;
          const nextSubagents = { ...state.activeSubagentsByThread };
          if (count <= 0) delete nextSubagents[threadId];
          else nextSubagents[threadId] = count;
          result.activeSubagentsByThread = nextSubagents;
        }
        return result;
      });
    };

    // -- Sidecar events (new format) --

    if (method === "session.system") {
      const subtype = params.subtype as string;
      if (subtype === "session_restarted") {
        const message: Message = {
          id: crypto.randomUUID(),
          thread_id: threadId,
          role: "system",
          content: "Session restarted. The agent no longer has context from earlier messages.",
          tool_calls: null,
          files_changed: null,
          cost_usd: null,
          tokens_used: null,
          timestamp: new Date().toISOString(),
          sequence: get().messages.length + 1,
          attachments: null,
        };
        set((state) => {
          if (state.currentThreadId !== threadId) return {};
          const { messages: capped, evicted } = capMessages([...state.messages, message]);
          return {
            messages: capped,
            ...(evicted && state.currentThreadId ? { hasMoreMessages: { ...state.hasMoreMessages, [state.currentThreadId]: true } } : {}),
          };
        });
      }
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
          sequence: get().messages.length + 1,
          attachments: null,
        };
        set((state) => {
          // Clear streaming text so turnComplete won't duplicate this message.
          const nextStreaming = { ...state.streamingByThread };
          delete nextStreaming[threadId];
          const nextPreview = { ...state.streamingPreviewByThread };
          delete nextPreview[threadId];
          const trackTurn = {
            currentTurnMessageIdByThread: {
              ...state.currentTurnMessageIdByThread,
              [threadId]: message.id,
            },
            streamingByThread: nextStreaming,
            streamingPreviewByThread: nextPreview,
          };
          if (state.currentThreadId !== threadId) return trackTurn;
          // In Electron, MessagePort and WebSocket are independent channels
          // with no ordering guarantee. Skip if already in messages to prevent
          // duplicates when both channels deliver the same message.
          if (state.messages.some((m) => m.id === message.id)) return trackTurn;
          const { messages: capped, evicted } = capMessages([...state.messages, message]);
          return {
            messages: capped,
            ...(evicted && state.currentThreadId ? { hasMoreMessages: { ...state.hasMoreMessages, [state.currentThreadId]: true } } : {}),
            ...trackTurn,
          };
        });
      }
      return;
    }

    if (method === "session.toolUse") {
      const parentToolCallId = params.parentToolCallId as string | undefined;

      // Only mark prior tool calls complete if this isn't a subagent's tool call
      // (subagent calls should not mark the parent Agent call as complete)
      if (!parentToolCallId) {
        markPriorToolCallsComplete();
      }
      // Track subagent count
      const toolName = (params.toolName as string) || "unknown";

      // Intercept TodoWrite calls to populate the task panel
      if (toolName === "TodoWrite") {
        const toolInput = (params.toolInput as Record<string, unknown>) || {};
        const todos = toolInput.todos as Array<Record<string, unknown>> | undefined;
        if (todos && Array.isArray(todos)) {
          const taskItems: TaskItem[] = todos.map((t, i) => ({
            // Prefer SDK-provided stable id; fall back to index-based surrogate
            id: t.id != null ? String(t.id) : String(i),
            content: String(t.content ?? ""),
            status: coerceTaskStatus(t.status),
            group: "Tasks",
          }));
          useTaskStore.getState().setTasks(threadId, taskItems);
          // Show the right panel on the tasks tab when tasks are received.
          // Imported lazily to avoid circular dependency at module evaluation time.
          import("./diffStore").then(({ useDiffStore }) => {
            useDiffStore.getState().showPanel();
            useDiffStore.getState().setActiveTab("tasks");
          });
        }
      }

      if (toolName === "Agent") {
        set((state) => ({
          activeSubagentsByThread: {
            ...state.activeSubagentsByThread,
            [threadId]: (state.activeSubagentsByThread[threadId] ?? 0) + 1,
          },
        }));
      }

      const toolCall: ToolCall = {
        id: (params.toolCallId as string) || crypto.randomUUID(),
        toolName,
        toolInput: (params.toolInput as Record<string, unknown>) || {},
        output: null,
        isError: false,
        isComplete: false,
        parentToolCallId: parentToolCallId || undefined,
      };
      set((state) => ({
        toolCallsByThread: {
          ...state.toolCallsByThread,
          [threadId]: [...(state.toolCallsByThread[threadId] ?? []), toolCall],
        },
      }));
      return;
    }

    if (method === "session.toolResult") {
      const toolCallId = (params.toolCallId as string) || "";
      const output = (params.output as string) || "";
      const isError = (params.isError as boolean) || false;
      set((state) => {
        const calls = state.toolCallsByThread[threadId] ?? [];
        // Try matching by ID first; fall back to the first incomplete tool call
        // when the SDK sends a null or non-matching toolCallId.
        const hasIdMatch = toolCallId && calls.some((tc) => tc.id === toolCallId);

        // Fallback: pick the first incomplete call, but never pick an Agent call
        // that has active children — completing it prematurely would decrement
        // the subagent count and hide the nested work from the UI.
        const hasActiveChildren = (id: string) =>
          calls.some((c) => c.parentToolCallId === id && !c.isComplete);
        const matchedCall = hasIdMatch
          ? calls.find((tc) => tc.id === toolCallId)
          : calls.find((tc) => !tc.isComplete && !(tc.toolName === "Agent" && hasActiveChildren(tc.id)));
        const isAgentCompletion = matchedCall?.toolName === "Agent";

        let matched = false;
        const updated = hasIdMatch
          ? calls.map((tc) =>
              tc.id === toolCallId ? { ...tc, output, isError, isComplete: true } : tc
            )
          : calls.map((tc) => {
              if (!matched && !tc.isComplete && !(tc.toolName === "Agent" && hasActiveChildren(tc.id))) {
                matched = true;
                return { ...tc, output, isError, isComplete: true };
              }
              return tc;
            });

        const result: Partial<ThreadState> = {
          toolCallsByThread: { ...state.toolCallsByThread, [threadId]: updated },
        };

        // Decrement subagent count when an Agent tool call completes
        if (isAgentCompletion) {
          const count = (state.activeSubagentsByThread[threadId] ?? 1) - 1;
          const nextSubagents = { ...state.activeSubagentsByThread };
          if (count <= 0) delete nextSubagents[threadId];
          else nextSubagents[threadId] = count;
          result.activeSubagentsByThread = nextSubagents;
        }

        return result;
      });
      return;
    }

    // session.textDelta: accumulate streaming text for live preview and finalization.
    if (method === "session.textDelta") {
      const delta = (params.delta as string) || "";
      if (!delta) return;
      // Text deltas signal Claude is responding — mark prior tool calls complete.
      markPriorToolCallsComplete();
      set((state) => {
        const current = state.streamingByThread[threadId] ?? "";
        const combined = current + delta;
        const preview = combined.length > 200 ? combined.slice(-200) : combined;
        return {
          streamingByThread: { ...state.streamingByThread, [threadId]: combined },
          streamingPreviewByThread: { ...state.streamingPreviewByThread, [threadId]: preview },
        };
      });
      return;
    }

    if (method === "session.toolProgress") {
      const toolCallId = (params.toolCallId as string) || "";
      const elapsedSeconds = (params.elapsedSeconds as number) ?? 0;
      if (!toolCallId) return;
      set((state) => {
        const current = state.toolCallsByThread[threadId] ?? [];
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
        return {
          toolCallsByThread: { ...state.toolCallsByThread, [threadId]: updated },
        };
      });
      return;
    }

    if (method === "session.turnComplete" || method === "session.ended") {
      const costUsd = (params.costUsd as number) ?? null;
      const tokensIn = ((params.tokensIn as number) ?? (params.totalTokensIn as number)) ?? 0;
      const tokensOut = ((params.tokensOut as number) ?? (params.totalTokensOut as number)) ?? 0;

      // Commit any remaining streaming content and stop the agent,
      // Tool calls remain in-place and collapse into a summary.
      const streamContent = get().streamingByThread[threadId] ?? "";

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
          sequence: get().messages.length + 1,
          attachments: null,
        };
        set((state) => {
          const nextStreaming = { ...state.streamingByThread };
          delete nextStreaming[threadId];
          const nextPreview = { ...state.streamingPreviewByThread };
          delete nextPreview[threadId];
          const nextRunning = new Set(state.runningThreadIds);
          nextRunning.delete(threadId);
          const nextStartTimes = { ...state.agentStartTimes };
          delete nextStartTimes[threadId];
          const nextSubagents = { ...state.activeSubagentsByThread };
          delete nextSubagents[threadId];
          // Mark all tool calls as complete and keep in active slot briefly
          const currentCalls = state.toolCallsByThread[threadId] ?? [];
          const completedCalls = currentCalls.map((tc) =>
            tc.isComplete ? tc : { ...tc, isComplete: true }
          );
          return {
            ...(state.currentThreadId === threadId
              ? (() => {
                  const { messages: capped, evicted } = capMessages([...state.messages, message]);
                  return { messages: capped, ...(evicted && state.currentThreadId ? { hasMoreMessages: { ...state.hasMoreMessages, [state.currentThreadId]: true } } : {}) };
                })()
              : {}),
            streamingByThread: nextStreaming,
            streamingPreviewByThread: nextPreview,
            runningThreadIds: nextRunning,
            agentStartTimes: nextStartTimes,
            activeSubagentsByThread: nextSubagents,
            toolCallsByThread: completedCalls.length > 0
              ? { ...state.toolCallsByThread, [threadId]: completedCalls }
              : state.toolCallsByThread,
          };
        });
      } else {
        set((state) => {
          const nextRunning = new Set(state.runningThreadIds);
          nextRunning.delete(threadId);
          const nextStreaming = { ...state.streamingByThread };
          delete nextStreaming[threadId];
          const nextPreview = { ...state.streamingPreviewByThread };
          delete nextPreview[threadId];
          const nextStartTimes = { ...state.agentStartTimes };
          delete nextStartTimes[threadId];
          const nextSubagents = { ...state.activeSubagentsByThread };
          delete nextSubagents[threadId];
          const currentCalls = state.toolCallsByThread[threadId] ?? [];
          const completedCalls = currentCalls.map((tc) =>
            tc.isComplete ? tc : { ...tc, isComplete: true }
          );
          return {
            runningThreadIds: nextRunning,
            streamingByThread: nextStreaming,
            streamingPreviewByThread: nextPreview,
            agentStartTimes: nextStartTimes,
            activeSubagentsByThread: nextSubagents,
            toolCallsByThread: completedCalls.length > 0
              ? { ...state.toolCallsByThread, [threadId]: completedCalls }
              : state.toolCallsByThread,
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
      if (tokensIn > 0 && !get().isCompactingByThread[threadId]) {
        const sdkContextWindow = params.contextWindow as number | undefined;
        const modelId = useWorkspaceStore.getState().threads.find((t) => t.id === threadId)?.model ?? "claude-sonnet-4-6";
        const contextWindow = sdkContextWindow ?? getContextWindow(modelId);
        set((state) => ({
          contextByThread: {
            ...state.contextByThread,
            [threadId]: { lastTokensIn: tokensIn, contextWindow },
          },
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
      if (method === "session.turnComplete") {
        clearDequeueTimer(threadId);
        const timer = setTimeout(() => {
          dequeueTimers.delete(threadId);
          // Guard: verify the thread still exists and isn't already running
          const threadExists = useWorkspaceStore.getState().threads.some(
            (t) => t.id === threadId && t.deleted_at == null,
          );
          if (!threadExists) return;
          if (get().runningThreadIds.has(threadId)) return;

          const next = useQueueStore.getState().dequeueNext(threadId);
          if (next) {
            get().sendMessage(
              threadId,
              next.content,
              next.model,
              next.permissionMode,
              next.attachments.length > 0 ? next.attachments : undefined,
              next.displayContent,
              next.reasoningLevel,
              next.provider,
            );
          }
        }, 400);
        dequeueTimers.set(threadId, timer);
      }
      return;
    }

    if (method === "session.contextEstimate") {
      const tokensIn = params.tokensIn as number;
      const ctxWindow = params.contextWindow as number | undefined;
      // Only apply if not compacting — the compaction-start zero sentinel is
      // authoritative while compaction is in progress.
      if (tokensIn > 0 && !get().isCompactingByThread[threadId]) {
        set((state) => ({
          contextByThread: {
            ...state.contextByThread,
            [threadId]: {
              lastTokensIn: tokensIn,
              contextWindow: ctxWindow ?? state.contextByThread[threadId]?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
            },
          },
        }));
      }
      return;
    }

    if (method === "session.compacting") {
      const active = params.active as boolean;
      if (!active) {
        // Only add the system divider if the thread was actually marked as
        // compacting AND this is the currently loaded thread. addMessage appends
        // to the shared messages array, so inserting on a background thread
        // would show the divider in the wrong chat.
        const wasCompacting = get().isCompactingByThread[threadId] ?? false;
        if (wasCompacting && get().currentThreadId === threadId) {
          const systemMsg: Message = {
            id: crypto.randomUUID(),
            thread_id: threadId,
            role: "system",
            content: "Context compacted",
            sequence: get().messages.length + 1,
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
        const next = { ...state.isCompactingByThread };
        if (active) {
          next[threadId] = true;
        } else {
          delete next[threadId];
        }
        // When compaction starts, replace the live context entry with a zero
        // sentinel so the ring hides. Deleting the key would let the UI fall
        // back to the stale persisted value from the thread record.
        // When active=false, leave contextByThread untouched: the post-compaction
        // turnComplete may have already written fresh data.
        const nextCtx = active
          ? {
              ...state.contextByThread,
              [threadId]: { lastTokensIn: 0, contextWindow: state.contextByThread[threadId]?.contextWindow ?? DEFAULT_CONTEXT_WINDOW },
            }
          : state.contextByThread;
        return { isCompactingByThread: next, contextByThread: nextCtx };
      });
      return;
    }

    if (method === "session.modelFallback") {
      const requestedModel = params.requestedModel as string;
      const actualModel = params.actualModel as string;

      // Normalize dated SDK variants (e.g. claude-haiku-4-5-20251001 → claude-haiku-4-5)
      // so the picker always stores and displays the clean base ID.
      const actualDefinition = findModelById(actualModel);
      const normalizedActual = actualDefinition?.id ?? actualModel;

      // Patch workspaceStore so the Composer's model selector updates reactively
      useWorkspaceStore.setState((ws) => ({
        threads: ws.threads.map((t) =>
          t.id === threadId ? { ...t, model: normalizedActual } : t,
        ),
      }));

      // Notify the user which model was actually used
      const actualLabel = actualDefinition?.label ?? normalizedActual;
      const requestedLabel = findModelById(requestedModel)?.label ?? requestedModel;
      useToastStore.getState().show(
        "info",
        `Switched to ${actualLabel}`,
        `${requestedLabel} was unavailable`,
      );
      return;
    }

    if (method === "session.error") {
      const errorMsg = (params.error as string) || "Unknown error";
      set((state) => {
        const nextRunning = new Set(state.runningThreadIds);
        nextRunning.delete(threadId);
        const nextStreaming = { ...state.streamingByThread };
        delete nextStreaming[threadId];
        const nextStartTimes = { ...state.agentStartTimes };
        delete nextStartTimes[threadId];
        const nextToolCalls = { ...state.toolCallsByThread };
        delete nextToolCalls[threadId];
        const nextSubagents = { ...state.activeSubagentsByThread };
        delete nextSubagents[threadId];
        const nextCompacting = { ...state.isCompactingByThread };
        delete nextCompacting[threadId];
        return {
          error: errorMsg,
          runningThreadIds: nextRunning,
          streamingByThread: nextStreaming,
          agentStartTimes: nextStartTimes,
          toolCallsByThread: nextToolCalls,
          activeSubagentsByThread: nextSubagents,
          isCompactingByThread: nextCompacting,
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

  handleTurnPersisted: (payload) => {
    set((state) => {
      // Clear in-memory tool calls now that the DB-backed summary takes over
      const nextToolCalls = { ...state.toolCallsByThread };
      delete nextToolCalls[payload.threadId];

      // The server's messageId may differ from the client's in-memory UUID
      // (client generates its own via crypto.randomUUID()). Prefer the ID
      // tracked during the active turn; fall back to the last assistant message
      // for cases where session.message arrived before tracking was introduced.
      let localMsgId = payload.messageId;
      const trackedMsgId = state.currentTurnMessageIdByThread[payload.threadId];
      if (trackedMsgId) {
        localMsgId = trackedMsgId;
      } else if (state.currentThreadId === payload.threadId) {
        // Fallback: find last assistant message (covers cases where session.message
        // arrived before we started tracking, e.g. on initial load)
        const lastAssistantMsg = [...state.messages]
          .reverse()
          .find((m) => m.role === "assistant");
        if (lastAssistantMsg) localMsgId = lastAssistantMsg.id;
      }

      const nextTurnMsgIds = { ...state.currentTurnMessageIdByThread };
      delete nextTurnMsgIds[payload.threadId];
      return {
        toolCallsByThread: nextToolCalls,
        persistedToolCallCounts: {
          ...state.persistedToolCallCounts,
          [localMsgId]: payload.toolCallCount,
        },
        persistedFilesChanged: {
          ...state.persistedFilesChanged,
          [localMsgId]: payload.filesChanged,
        },
        latestTurnWithChanges:
          payload.filesChanged.length > 0 ? localMsgId : state.latestTurnWithChanges,
        serverMessageIds: {
          ...state.serverMessageIds,
          [localMsgId]: payload.messageId,
        },
        currentTurnMessageIdByThread: nextTurnMsgIds,
      };
    });
  },
  };
});
