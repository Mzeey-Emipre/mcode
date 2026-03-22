import { create } from "zustand";
import type { Workspace, Thread } from "@/transport";
import { getTransport } from "@/transport";

interface WorkspaceState {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  threads: Thread[];
  activeThreadId: string | null;
  loading: boolean;
  error: string | null;

  // Workspace actions
  loadWorkspaces: () => Promise<void>;
  createWorkspace: (name: string, path: string) => Promise<Workspace>;
  deleteWorkspace: (id: string) => Promise<void>;
  setActiveWorkspace: (id: string | null) => void;

  // Thread actions
  loadThreads: (workspaceId: string) => Promise<void>;
  createThread: (
    title: string,
    mode: "direct" | "worktree",
    branch: string,
  ) => Promise<Thread>;
  deleteThread: (threadId: string, cleanupWorktree: boolean) => Promise<void>;
  setActiveThread: (id: string | null) => void;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaces: [],
  activeWorkspaceId: null,
  threads: [],
  activeThreadId: null,
  loading: false,
  error: null,

  loadWorkspaces: async () => {
    set({ loading: true, error: null });
    try {
      const workspaces = await getTransport().listWorkspaces();
      set({ workspaces, loading: false });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  createWorkspace: async (name, path) => {
    set({ error: null });
    try {
      const workspace = await getTransport().createWorkspace(name, path);
      set((state) => ({ workspaces: [workspace, ...state.workspaces] }));
      return workspace;
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  deleteWorkspace: async (id) => {
    set({ error: null });
    try {
      await getTransport().deleteWorkspace(id);
      set((state) => ({
        workspaces: state.workspaces.filter((w) => w.id !== id),
        activeWorkspaceId: state.activeWorkspaceId === id ? null : state.activeWorkspaceId,
        // Clear threads if deleting the active workspace
        threads: state.activeWorkspaceId === id ? [] : state.threads,
        activeThreadId: state.activeWorkspaceId === id ? null : state.activeThreadId,
      }));
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  setActiveWorkspace: (id) => {
    set({ activeWorkspaceId: id, threads: [], activeThreadId: null });
    if (id) {
      get().loadThreads(id);
    }
  },

  loadThreads: async (workspaceId) => {
    set({ loading: true, error: null });
    try {
      const threads = await getTransport().listThreads(workspaceId);
      if (get().activeWorkspaceId === workspaceId) {
        set({ threads, loading: false });
      }
    } catch (e) {
      if (get().activeWorkspaceId === workspaceId) {
        set({ error: String(e), loading: false });
      }
    }
  },

  createThread: async (title, mode, branch) => {
    const { activeWorkspaceId } = get();
    if (!activeWorkspaceId) throw new Error("No active workspace");

    set({ error: null });
    try {
      const thread = await getTransport().createThread(
        activeWorkspaceId,
        title,
        mode,
        branch,
      );
      set((state) => ({ threads: [thread, ...state.threads] }));
      return thread;
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  deleteThread: async (threadId, cleanupWorktree) => {
    set({ error: null });
    try {
      await getTransport().deleteThread(threadId, cleanupWorktree);
      set((state) => ({
        threads: state.threads.filter((t) => t.id !== threadId),
        activeThreadId: state.activeThreadId === threadId ? null : state.activeThreadId,
      }));
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  setActiveThread: (id) => {
    set({ activeThreadId: id });
  },
}));
