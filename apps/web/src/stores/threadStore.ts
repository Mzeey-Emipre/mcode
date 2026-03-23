import { create } from "zustand";
import type { Message, ToolCall, PermissionMode, InteractionMode } from "@/transport";
import { getTransport, PERMISSION_MODES, INTERACTION_MODES } from "@/transport";

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
  agentStartTimes: Record<string, number>;
  /** Per-thread permission mode and interaction mode. */
  settingsByThread: Record<string, ThreadSettings>;

  // Message actions
  loadMessages: (threadId: string) => Promise<void>;
  sendMessage: (threadId: string, content: string, model?: string, permissionMode?: PermissionMode) => Promise<void>;
  stopAgent: (threadId: string) => Promise<void>;
  addMessage: (message: Message) => void;
  clearMessages: () => void;
  isThreadRunning: (threadId: string) => boolean;
  handleAgentEvent: (threadId: string, event: Record<string, unknown>) => void;

  // Per-thread settings
  getThreadSettings: (threadId: string) => ThreadSettings;
  setThreadSettings: (threadId: string, settings: Partial<ThreadSettings>) => void;
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
  agentStartTimes: {},
  settingsByThread: {},

  loadMessages: async (threadId) => {
    set({ loading: true, error: null, currentThreadId: threadId });
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

  sendMessage: async (threadId, content, model, permissionMode) => {
    // Add user message to local state immediately (optimistic)
    const userMessage: Message = {
      id: crypto.randomUUID(),
      thread_id: threadId,
      role: "user",
      content,
      tool_calls: null,
      files_changed: null,
      cost_usd: null,
      tokens_used: null,
      timestamp: new Date().toISOString(),
      sequence: get().messages.length + 1,
    };

    set((state) => ({
      messages: [...state.messages, userMessage],
      runningThreadIds: new Set([...state.runningThreadIds, threadId]),
      agentStartTimes: { ...state.agentStartTimes, [threadId]: Date.now() },
      error: null,
    }));

    try {
      await getTransport().sendMessage(threadId, content, model, permissionMode);
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

  addMessage: (message) => {
    set((state) => ({
      messages: [...state.messages, message],
    }));
  },

  clearMessages: () => {
    set({ messages: [], error: null, streamingByThread: {} });
    // Note: does NOT reset runningThreadIds - agents may still be running
  },

  isThreadRunning: (threadId) => {
    return get().runningThreadIds.has(threadId);
  },

  getThreadSettings: (threadId) => {
    return get().settingsByThread[threadId] ?? DEFAULT_THREAD_SETTINGS;
  },

  setThreadSettings: (threadId, settings) => {
    set((state) => ({
      settingsByThread: {
        ...state.settingsByThread,
        [threadId]: { ...state.getThreadSettings(threadId), ...settings },
      },
    }));
  },

  handleAgentEvent: (threadId, event) => {
    // Support both old CLI format (event.type) and new sidecar format (event.method)
    const method = (event.method as string) || "";
    const eventType = (event.type as string) || "";
    const params = (event.params as Record<string, unknown>) || event;

    // -- Sidecar events (new format) --

    if (method === "bridge.crashed") {
      set({
        runningThreadIds: new Set(),
        streamingByThread: {},
        error: "Agent bridge crashed. Please restart the app.",
      });
      return;
    }

    if (method === "session.message" || (eventType === "session.message")) {
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
        // Try matching by ID first; fall back to the last incomplete tool call
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
      const tokensIn = (params.totalTokensIn as number) ?? 0;
      const tokensOut = (params.totalTokensOut as number) ?? 0;

      // Commit any remaining streaming content
      const streamContent = get().streamingByThread[threadId] ?? "";
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
        };
        set((state) => {
          const nextStreaming = { ...state.streamingByThread };
          delete nextStreaming[threadId];
          const nextRunning = new Set(state.runningThreadIds);
          nextRunning.delete(threadId);
          const nextStartTimes = { ...state.agentStartTimes };
          delete nextStartTimes[threadId];
          const nextToolCalls = { ...state.toolCallsByThread };
          delete nextToolCalls[threadId];
          return {
            messages: state.currentThreadId === threadId
              ? [...state.messages, message]
              : state.messages,
            streamingByThread: nextStreaming,
            runningThreadIds: nextRunning,
            agentStartTimes: nextStartTimes,
            toolCallsByThread: nextToolCalls,
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
          const nextToolCalls = { ...state.toolCallsByThread };
          delete nextToolCalls[threadId];
          return {
            runningThreadIds: nextRunning,
            streamingByThread: nextStreaming,
            agentStartTimes: nextStartTimes,
            toolCallsByThread: nextToolCalls,
          };
        });
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
      return;
    }

    if (method === "session.delta") {
      const text = (params.text as string) || "";
      if (text) {
        set((state) => ({
          streamingByThread: {
            ...state.streamingByThread,
            [threadId]: (state.streamingByThread[threadId] ?? "") + text,
          },
        }));
      }
      return;
    }

    // -- Legacy CLI events (backward compatibility) --

    if (eventType === "assistant") {
      const msg = event.message as Record<string, unknown> | undefined;
      if (msg) {
        const contentArr = msg.content as Array<Record<string, unknown>> | undefined;
        if (contentArr && Array.isArray(contentArr)) {
          const textParts = contentArr
            .filter((c) => c.type === "text")
            .map((c) => (c.text as string) || "")
            .join("");

          if (textParts) {
            const usage = msg.usage as Record<string, unknown> | undefined;
            const message: Message = {
              id: (msg.id as string) || crypto.randomUUID(),
              thread_id: threadId,
              role: "assistant",
              content: textParts,
              tool_calls: null,
              files_changed: null,
              cost_usd: null,
              tokens_used: (usage?.output_tokens as number) ?? null,
              timestamp: new Date().toISOString(),
              sequence: get().messages.length + 1,
            };
            set((state) => ({
              messages: state.currentThreadId === threadId
                ? [...state.messages, message]
                : state.messages,
            }));
          }
        }
      }
    } else if (eventType === "content_block_delta") {
      const delta = event.delta as Record<string, unknown> | undefined;
      if (delta && delta.type === "text_delta") {
        const text = (delta.text as string) || "";
        set((state) => ({
          streamingByThread: {
            ...state.streamingByThread,
            [threadId]: (state.streamingByThread[threadId] ?? "") + text,
          },
        }));
      }
    } else if (eventType === "result") {
      const content = get().streamingByThread[threadId] ?? "";
      if (content) {
        const resultData = (event.result as Record<string, unknown>) ?? {};
        const message: Message = {
          id: crypto.randomUUID(),
          thread_id: threadId,
          role: "assistant",
          content,
          tool_calls: null,
          files_changed: null,
          cost_usd: (resultData.cost_usd as number) ?? null,
          tokens_used: (resultData.tokens_used as number) ?? null,
          timestamp: new Date().toISOString(),
          sequence: get().messages.length + 1,
        };
        set((state) => {
          const next = { ...state.streamingByThread };
          delete next[threadId];
          return {
            messages: state.currentThreadId === threadId
              ? [...state.messages, message]
              : state.messages,
            streamingByThread: next,
          };
        });
      }
    } else if (eventType === "agent_finished") {
      set((state) => {
        const nextRunning = new Set(state.runningThreadIds);
        nextRunning.delete(threadId);
        const nextStreaming = { ...state.streamingByThread };
        delete nextStreaming[threadId];
        return { runningThreadIds: nextRunning, streamingByThread: nextStreaming };
      });
    }
  },
}));
