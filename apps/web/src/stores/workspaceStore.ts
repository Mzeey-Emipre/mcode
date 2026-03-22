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
    const workspace = await getTransport().createWorkspace(name, path);
    set((state) => ({ workspaces: [workspace, ...state.workspaces] }));
    return workspace;
  },

  deleteWorkspace: async (id) => {
    await getTransport().deleteWorkspace(id);
    set((state) => ({
      workspaces: state.workspaces.filter((w) => w.id !== id),
      activeWorkspaceId: state.activeWorkspaceId === id ? null : state.activeWorkspaceId,
    }));
  },

  setActiveWorkspace: (id) => {
    set({ activeWorkspaceId: id, threads: [], activeThreadId: null });
    if (id) {
      get().loadThreads(id);
    }
  },

  loadThreads: async (workspaceId) => {
    try {
      const threads = await getTransport().listThreads(workspaceId);
      set({ threads });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  createThread: async (title, mode, branch) => {
    const { activeWorkspaceId } = get();
    if (!activeWorkspaceId) throw new Error("No active workspace");

    const thread = await getTransport().createThread(
      activeWorkspaceId,
      title,
      mode,
      branch,
    );
    set((state) => ({ threads: [thread, ...state.threads] }));
    return thread;
  },

  deleteThread: async (threadId, cleanupWorktree) => {
    await getTransport().deleteThread(threadId, cleanupWorktree);
    set((state) => ({
      threads: state.threads.filter((t) => t.id !== threadId),
      activeThreadId: state.activeThreadId === threadId ? null : state.activeThreadId,
    }));
  },

  setActiveThread: (id) => {
    set({ activeThreadId: id });
  },
}));
