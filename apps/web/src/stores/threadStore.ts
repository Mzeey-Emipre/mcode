import { create } from "zustand";
import type { Message } from "@/transport";
import { getTransport } from "@/transport";

interface ThreadState {
  messages: Message[];
  runningThreadIds: Set<string>;
  loading: boolean;
  error: string | null;
  currentThreadId: string | null;
  streamingByThread: Record<string, string>;

  // Message actions
  loadMessages: (threadId: string) => Promise<void>;
  sendMessage: (threadId: string, content: string) => Promise<void>;
  stopAgent: (threadId: string) => Promise<void>;
  addMessage: (message: Message) => void;
  clearMessages: () => void;
  isThreadRunning: (threadId: string) => boolean;
  handleAgentEvent: (threadId: string, event: Record<string, unknown>) => void;
}

export const useThreadStore = create<ThreadState>((set, get) => ({
  messages: [],
  runningThreadIds: new Set<string>(),
  loading: false,
  error: null,
  currentThreadId: null,
  streamingByThread: {},

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

  sendMessage: async (threadId, content) => {
    // Agent continues running after message is queued, cleared by stopAgent
    set((state) => ({
      runningThreadIds: new Set([...state.runningThreadIds, threadId]),
      error: null,
    }));
    try {
      await getTransport().sendMessage(threadId, content);
    } catch (e) {
      set((state) => {
        const next = new Set(state.runningThreadIds);
        next.delete(threadId);
        return { error: String(e), runningThreadIds: next };
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

  handleAgentEvent: (threadId, event) => {
    const eventType = event.type as string;

    if (eventType === "content_block_delta") {
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
      // Agent turn complete: commit streaming content as a message
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
      // Agent process exited
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
