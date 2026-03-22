import { create } from "zustand";
import type { Message } from "@/transport";
import { getTransport } from "@/transport";

interface ThreadState {
  messages: Message[];
  isAgentRunning: boolean;
  loading: boolean;
  error: string | null;

  // Message actions
  loadMessages: (threadId: string) => Promise<void>;
  sendMessage: (threadId: string, content: string) => Promise<void>;
  stopAgent: (threadId: string) => Promise<void>;
  addMessage: (message: Message) => void;
  clearMessages: () => void;
}

export const useThreadStore = create<ThreadState>((set) => ({
  messages: [],
  isAgentRunning: false,
  loading: false,
  error: null,

  loadMessages: async (threadId) => {
    set({ loading: true, error: null });
    try {
      const messages = await getTransport().getMessages(threadId, 100);
      set({ messages, loading: false });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  sendMessage: async (threadId, content) => {
    set({ isAgentRunning: true, error: null });
    try {
      await getTransport().sendMessage(threadId, content);
    } catch (e) {
      set({ error: String(e), isAgentRunning: false });
    }
  },

  stopAgent: async (threadId) => {
    try {
      await getTransport().stopAgent(threadId);
      set({ isAgentRunning: false });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  addMessage: (message) => {
    set((state) => ({
      messages: [...state.messages, message],
    }));
  },

  clearMessages: () => {
    set({ messages: [], isAgentRunning: false, error: null });
  },
}));
