import { create } from "zustand";
import type { Message } from "@/transport";
import { getTransport } from "@/transport";

interface ThreadState {
  messages: Message[];
  runningThreadIds: Set<string>;
  loading: boolean;
  error: string | null;
  currentThreadId: string | null;

  // Message actions
  loadMessages: (threadId: string) => Promise<void>;
  sendMessage: (threadId: string, content: string) => Promise<void>;
  stopAgent: (threadId: string) => Promise<void>;
  addMessage: (message: Message) => void;
  clearMessages: () => void;
  isThreadRunning: (threadId: string) => boolean;
}

export const useThreadStore = create<ThreadState>((set, get) => ({
  messages: [],
  runningThreadIds: new Set<string>(),
  loading: false,
  error: null,
  currentThreadId: null,

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
    set({ messages: [], error: null });
    // Note: does NOT reset runningThreadIds - agents may still be running
  },

  isThreadRunning: (threadId) => {
    return get().runningThreadIds.has(threadId);
  },
}));
