import { create } from "zustand";
import type { Message, ToolCall, PermissionMode, InteractionMode, AttachmentMeta } from "@/transport";
import { getTransport, PERMISSION_MODES, INTERACTION_MODES } from "@/transport";
import { useWorkspaceStore } from "./workspaceStore";
import { useQueueStore } from "./queueStore";

export interface ThreadSettings {
  permissionMode: PermissionMode;
  interactionMode: InteractionMode;
}

interface ThreadState {
  messages: Message[];
  runningThreadIds: Set<string>;
  loading: boolean;
  error: string | null;
  currentThreadId: string | null;
  streamingByThread: Record<string, string>;
  toolCallsByThread: Record<string, ToolCall[]>;
  /** Tool calls kept briefly after turn complete so the user can see the final state. */
  fadingToolCallsByThread: Record<string, ToolCall[]>;
  agentStartTimes: Record<string, number>;
  /** Per-thread permission mode and interaction mode. */
  settingsByThread: Record<string, ThreadSettings>;

  // Message actions
  loadMessages: (threadId: string) => Promise<void>;
  sendMessage: (threadId: string, content: string, model?: string, permissionMode?: PermissionMode, attachments?: AttachmentMeta[], displayContent?: string) => Promise<void>;
  stopAgent: (threadId: string) => Promise<void>;
  addMessage: (message: Message) => void;
  clearMessages: () => void;
  isThreadRunning: (threadId: string) => boolean;
  handleAgentEvent: (threadId: string, event: Record<string, unknown>) => void;

  // Per-thread settings
  getThreadSettings: (threadId: string) => ThreadSettings;
  setThreadSettings: (threadId: string, settings: Partial<ThreadSettings>) => void;
}

/** Pending fade-out timers per thread, so we can cancel on new turns. */
const fadingTimers = new Map<string, ReturnType<typeof setTimeout>[]>();

/** Cancel and remove all pending fade-out timers for a thread. */
function clearFadingTimers(threadId: string) {
  const timers = fadingTimers.get(threadId);
  if (timers) {
    timers.forEach(clearTimeout);
    fadingTimers.delete(threadId);
  }
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

export const useThreadStore = create<ThreadState>((set, get) => ({
  messages: [],
  runningThreadIds: new Set<string>(),
  loading: false,
  error: null,
  currentThreadId: null,
  streamingByThread: {},
  toolCallsByThread: {},
  fadingToolCallsByThread: {},
  agentStartTimes: {},
  settingsByThread: {},

  /**
   * Fetch persisted messages for a thread from the database.
   * For non-running threads, clears stale real-time state (tool calls,
   * streaming text, fading tool calls, agent start times) so artifacts
   * from a previous visit don't linger. Running threads keep their
   * real-time state intact to avoid disrupting live tool call rendering.
   */
  loadMessages: async (threadId) => {
    // Clear stale real-time state for non-running threads so tool calls
    // from a previous visit don't linger when switching back.
    const isRunning = get().runningThreadIds.has(threadId);
    if (!isRunning) {
      clearFadingTimers(threadId);
      set((state) => {
        const nextToolCalls = { ...state.toolCallsByThread };
        delete nextToolCalls[threadId];
        const nextFading = { ...state.fadingToolCallsByThread };
        delete nextFading[threadId];
        const nextStreaming = { ...state.streamingByThread };
        delete nextStreaming[threadId];
        const nextStartTimes = { ...state.agentStartTimes };
        delete nextStartTimes[threadId];
        return {
          loading: true,
          error: null,
          currentThreadId: threadId,
          toolCallsByThread: nextToolCalls,
          fadingToolCallsByThread: nextFading,
          streamingByThread: nextStreaming,
          agentStartTimes: nextStartTimes,
        };
      });
    } else {
      set({ loading: true, error: null, currentThreadId: threadId });
    }
    try {
      const messages = await getTransport().getMessages(threadId, 100);
      // Only commit if this thread is still current
      if (get().currentThreadId === threadId) {
        set({ messages, loading: false });
      }
    } catch (e) {
      if (get().currentThreadId === threadId) {
        set({ error: String(e), loading: false });
      }
    }
  },

  /**
   * Send a user message and start the agent. Optimistically appends the
   * message to local state, marks the thread as running, then dispatches
   * to the transport layer. On failure, rolls back the running state.
   */
  sendMessage: async (threadId, content, model, permissionMode, attachments, displayContent) => {
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
      messages: [...state.messages, userMessage],
      runningThreadIds: new Set([...state.runningThreadIds, threadId]),
      agentStartTimes: { ...state.agentStartTimes, [threadId]: Date.now() },
      error: null,
    }));

    try {
      await getTransport().sendMessage(threadId, content, model, permissionMode, attachments);
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
      return { runningThreadIds: next };
    });
  },

  /** Append a single message to the current thread's message list. */
  addMessage: (message) => {
    set((state) => ({
      messages: [...state.messages, message],
    }));
  },

  /**
   * Reset the shared message list and all ephemeral streaming/fading state.
   * Cancels pending fade-out timers to prevent stale writes.
   * Does NOT reset runningThreadIds since agents may still be executing.
   */
  clearMessages: () => {
    // Cancel all pending fade-out timers to prevent stale writes
    for (const threadId of fadingTimers.keys()) {
      clearFadingTimers(threadId);
    }
    set({ messages: [], error: null, streamingByThread: {}, fadingToolCallsByThread: {} });
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
        const updated = current.map((tc) =>
          tc.isComplete ? tc : { ...tc, isComplete: true }
        );
        return {
          toolCallsByThread: { ...state.toolCallsByThread, [threadId]: updated },
        };
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
        set((state) => ({
          messages: state.currentThreadId === threadId
            ? [...state.messages, message]
            : state.messages,
        }));
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
        set((state) => ({
          messages: state.currentThreadId === threadId
            ? [...state.messages, message]
            : state.messages,
        }));
      }
      return;
    }

    if (method === "session.toolUse") {
      // New tool call arriving means any previous ones have finished
      markPriorToolCallsComplete();
      // Cancel any pending fade-out from a previous turn on this thread
      clearFadingTimers(threadId);
      const toolCall: ToolCall = {
        id: (params.toolCallId as string) || crypto.randomUUID(),
        toolName: (params.toolName as string) || "unknown",
        toolInput: (params.toolInput as Record<string, unknown>) || {},
        output: null,
        isError: false,
        isComplete: false,
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
        let matched = false;
        const updated = hasIdMatch
          ? calls.map((tc) =>
              tc.id === toolCallId ? { ...tc, output, isError, isComplete: true } : tc
            )
          : calls.map((tc) => {
              if (!matched && !tc.isComplete) {
                matched = true;
                return { ...tc, output, isError, isComplete: true };
              }
              return tc;
            });
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
      // but keep tool calls in their active slot briefly before fading out.
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
          const nextRunning = new Set(state.runningThreadIds);
          nextRunning.delete(threadId);
          const nextStartTimes = { ...state.agentStartTimes };
          delete nextStartTimes[threadId];
          // Mark all tool calls as complete and keep in active slot briefly
          const currentCalls = state.toolCallsByThread[threadId] ?? [];
          const completedCalls = currentCalls.map((tc) =>
            tc.isComplete ? tc : { ...tc, isComplete: true }
          );
          return {
            messages: state.currentThreadId === threadId
              ? [...state.messages, message]
              : state.messages,
            streamingByThread: nextStreaming,
            runningThreadIds: nextRunning,
            agentStartTimes: nextStartTimes,
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
          const nextStartTimes = { ...state.agentStartTimes };
          delete nextStartTimes[threadId];
          const currentCalls = state.toolCallsByThread[threadId] ?? [];
          const completedCalls = currentCalls.map((tc) =>
            tc.isComplete ? tc : { ...tc, isComplete: true }
          );
          return {
            runningThreadIds: nextRunning,
            streamingByThread: nextStreaming,
            agentStartTimes: nextStartTimes,
            toolCallsByThread: completedCalls.length > 0
              ? { ...state.toolCallsByThread, [threadId]: completedCalls }
              : state.toolCallsByThread,
          };
        });
      }

      // After a brief pause, move tool calls to fading state for exit animation.
      // Store timer IDs so they can be cancelled if a new turn starts.
      clearFadingTimers(threadId);
      const timers: ReturnType<typeof setTimeout>[] = [];
      timers.push(setTimeout(() => {
        set((state) => {
          const calls = state.toolCallsByThread[threadId];
          if (!calls || calls.length === 0) return {};
          const nextToolCalls = { ...state.toolCallsByThread };
          delete nextToolCalls[threadId];
          return {
            toolCallsByThread: nextToolCalls,
            fadingToolCallsByThread: { ...state.fadingToolCallsByThread, [threadId]: calls },
          };
        });
      }, 800));
      timers.push(setTimeout(() => {
        set((state) => {
          const next = { ...state.fadingToolCallsByThread };
          delete next[threadId];
          return { fadingToolCallsByThread: next };
        });
        fadingTimers.delete(threadId);
      }, 3500));
      fadingTimers.set(threadId, timers);

      // Sync the thread's status in workspaceStore so the sidebar shows
      // the green "Completed" badge without waiting for a full thread reload.
      useWorkspaceStore.setState((ws) => ({
        threads: ws.threads.map((t) =>
          t.id === threadId ? { ...t, status: "completed" as const } : t,
        ),
      }));

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
            );
          }
        }, 400);
        dequeueTimers.set(threadId, timer);
      }
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
        return {
          error: errorMsg,
          runningThreadIds: nextRunning,
          streamingByThread: nextStreaming,
          agentStartTimes: nextStartTimes,
          toolCallsByThread: nextToolCalls,
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
}));
