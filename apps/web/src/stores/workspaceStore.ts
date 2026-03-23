import { create } from "zustand";
import type { Workspace, Thread, GitBranch } from "@/transport";
import { getTransport } from "@/transport";
import { useThreadStore } from "./threadStore";

interface WorkspaceState {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  threads: Thread[];
  activeThreadId: string | null;
  pendingNewThread: boolean;
  loading: boolean;
  error: string | null;
  branches: GitBranch[];
  branchesLoading: boolean;
  newThreadMode: "direct" | "worktree";
  newThreadBranch: string;

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
  createAndSendMessage: (content: string, model: string) => Promise<Thread>;
  deleteThread: (threadId: string, cleanupWorktree: boolean) => Promise<void>;
  setActiveThread: (id: string | null) => void;
  setPendingNewThread: (value: boolean) => void;
  updateThreadTitle: (threadId: string, title: string) => Promise<void>;

  // Branch actions
  loadBranches: (workspaceId: string) => Promise<void>;
  getCurrentBranch: (workspaceId: string) => Promise<string>;
  checkoutBranch: (workspaceId: string, branch: string) => Promise<void>;
  setNewThreadMode: (mode: "direct" | "worktree") => void;
  setNewThreadBranch: (branch: string) => void;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaces: [],
  activeWorkspaceId: null,
  threads: [],
  activeThreadId: null,
  pendingNewThread: false,
  loading: false,
  error: null,
  branches: [],
  branchesLoading: false,
  newThreadMode: "direct" as const,
  newThreadBranch: "",

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
      set((state) => {
        const deletedThreadIds = new Set(
          state.threads.filter((t) => t.workspace_id === id).map((t) => t.id),
        );
        return {
          workspaces: state.workspaces.filter((w) => w.id !== id),
          activeWorkspaceId:
            state.activeWorkspaceId === id ? null : state.activeWorkspaceId,
          threads: state.threads.filter((t) => t.workspace_id !== id),
          activeThreadId:
            state.activeThreadId && deletedThreadIds.has(state.activeThreadId)
              ? null
              : state.activeThreadId,
        };
      });
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  setActiveWorkspace: (id) => {
    if (id === get().activeWorkspaceId) return;
    // Only clear activeThreadId if the current thread belongs to a different workspace
    const currentThread = get().threads.find(
      (t) => t.id === get().activeThreadId,
    );
    const shouldClearThread = currentThread
      ? currentThread.workspace_id !== id
      : true;
    set({
      activeWorkspaceId: id,
      ...(shouldClearThread ? { activeThreadId: null } : {}),
      branches: [],
      newThreadBranch: "",
    });
    if (id) {
      get().loadThreads(id);
    }
  },

  loadThreads: async (workspaceId) => {
    set({ loading: true, error: null });
    try {
      const newThreads = await getTransport().listThreads(workspaceId);
      // Merge: keep threads from other workspaces, replace threads for this workspace
      set((state) => ({
        threads: [
          ...state.threads.filter((t) => t.workspace_id !== workspaceId),
          ...newThreads,
        ],
        loading: false,
      }));
    } catch (e) {
      set({ error: String(e), loading: false });
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

  createAndSendMessage: async (content, model) => {
    const workspaceId = get().activeWorkspaceId;
    if (!workspaceId) throw new Error("No workspace selected");

    const { newThreadMode, newThreadBranch } = get();
    const branch = newThreadBranch || "main";

    set({ error: null });
    try {
      const thread = await getTransport().createAndSendMessage(
        workspaceId, content, model, undefined, newThreadMode, branch,
      );
      set((state) => ({
        threads: [thread, ...state.threads],
        activeThreadId: thread.id,
        pendingNewThread: false,
      }));

      // Mark the new thread as running in the threadStore so the
      // "Working for Xs" timer appears for the first message too.
      useThreadStore.setState((state) => ({
        runningThreadIds: new Set([...state.runningThreadIds, thread.id]),
        agentStartTimes: { ...state.agentStartTimes, [thread.id]: Date.now() },
      }));

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
    // Only clear pendingNewThread when selecting an actual thread
    set({ activeThreadId: id, ...(id ? { pendingNewThread: false } : {}) });
  },

  setPendingNewThread: (value) => {
    set({
      pendingNewThread: value,
      ...(value ? { newThreadMode: "direct" as const, newThreadBranch: "" } : {}),
    });
  },

  updateThreadTitle: async (threadId, title) => {
    set({ error: null });
    try {
      await getTransport().updateThreadTitle(threadId, title);
      set((state) => ({
        threads: state.threads.map((t) =>
          t.id === threadId ? { ...t, title } : t
        ),
      }));
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  loadBranches: async (workspaceId) => {
    set({ branchesLoading: true });
    try {
      const branches = await getTransport().listBranches(workspaceId);
      if (get().activeWorkspaceId !== workspaceId) return;
      set({ branches, branchesLoading: false });
    } catch (e) {
      if (get().activeWorkspaceId !== workspaceId) return;
      set({ branchesLoading: false, error: String(e) });
    }
  },

  getCurrentBranch: async (workspaceId) => {
    return getTransport().getCurrentBranch(workspaceId);
  },

  checkoutBranch: async (workspaceId, branch) => {
    await getTransport().checkoutBranch(workspaceId, branch);
  },

  setNewThreadMode: (mode) => {
    set({ newThreadMode: mode });
  },

  setNewThreadBranch: (branch) => {
    set({ newThreadBranch: branch });
  },
}));
