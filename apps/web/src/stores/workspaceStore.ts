import { create } from "zustand";
import type { Workspace, Thread, GitBranch, PermissionMode, WorktreeInfo } from "@/transport";
import { getTransport } from "@/transport";
import { useThreadStore } from "./threadStore";
import { getSetting, type NamingMode } from "@/lib/settings";

/** Generate a short random branch name for auto-mode worktrees (e.g. `mcode-a1b2c3d4`). */
function generateBranchId(): string {
  return `mcode-${Math.random().toString(36).slice(2, 10)}`;
}

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
  newThreadMode: "direct" | "worktree" | "existing-worktree";
  newThreadBranch: string;
  worktrees: WorktreeInfo[];
  worktreesLoading: boolean;
  namingMode: NamingMode;
  customBranchName: string;
  autoPreviewBranch: string;
  selectedWorktree: WorktreeInfo | null;

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
  createAndSendMessage: (content: string, model: string, permissionMode?: PermissionMode) => Promise<Thread>;
  deleteThread: (threadId: string, cleanupWorktree: boolean) => Promise<void>;
  setActiveThread: (id: string | null) => void;
  setPendingNewThread: (value: boolean) => void;
  updateThreadTitle: (threadId: string, title: string) => Promise<void>;

  // Branch actions
  loadBranches: (workspaceId: string) => Promise<void>;
  getCurrentBranch: (workspaceId: string) => Promise<string>;
  checkoutBranch: (workspaceId: string, branch: string) => Promise<void>;
  setNewThreadMode: (mode: "direct" | "worktree" | "existing-worktree") => void;
  setNewThreadBranch: (branch: string) => void;

  // Worktree actions
  loadWorktrees: (workspaceId: string) => Promise<void>;
  setNamingMode: (mode: NamingMode) => void;
  setCustomBranchName: (name: string) => void;
  setSelectedWorktree: (worktree: WorktreeInfo | null) => void;
  regenerateAutoPreview: () => void;
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
  worktrees: [],
  worktreesLoading: false,
  namingMode: "auto" as const,
  customBranchName: "",
  autoPreviewBranch: generateBranchId(),
  selectedWorktree: null,

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
      worktrees: [],
      selectedWorktree: null,
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

  createAndSendMessage: async (content, model, permissionMode) => {
    const workspaceId = get().activeWorkspaceId;
    if (!workspaceId) throw new Error("No workspace selected");

    const { newThreadMode, newThreadBranch, namingMode, customBranchName, autoPreviewBranch, selectedWorktree } = get();

    let mode: "direct" | "worktree" = "direct";
    let branch = newThreadBranch || "main";
    let existingWorktreePath: string | undefined;

    if (newThreadMode === "worktree") {
      mode = "worktree";
      branch = namingMode === "custom" ? customBranchName : autoPreviewBranch;
    } else if (newThreadMode === "existing-worktree") {
      mode = "worktree";
      if (!selectedWorktree) throw new Error("No worktree selected");
      branch = selectedWorktree.branch;
      existingWorktreePath = selectedWorktree.path;
    }

    set({ error: null });
    try {
      const thread = await getTransport().createAndSendMessage(
        workspaceId, content, model, permissionMode, mode, branch, existingWorktreePath,
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
      ...(value
        ? {
            newThreadMode: "direct" as const,
            newThreadBranch: "",
            namingMode: getSetting("worktree.defaultNamingMode"),
            customBranchName: "",
            autoPreviewBranch: generateBranchId(),
            selectedWorktree: null,
          }
        : {}),
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

  loadWorktrees: async (workspaceId) => {
    set({ worktreesLoading: true });
    try {
      const worktrees = await getTransport().listWorktrees(workspaceId);
      if (get().activeWorkspaceId !== workspaceId) return;
      set({ worktrees, worktreesLoading: false });
    } catch (e) {
      if (get().activeWorkspaceId !== workspaceId) return;
      set({ worktreesLoading: false, error: String(e) });
    }
  },

  setNamingMode: (mode) => set({ namingMode: mode }),
  setCustomBranchName: (name) => set({ customBranchName: name }),
  setSelectedWorktree: (worktree) => set({ selectedWorktree: worktree }),
  regenerateAutoPreview: () => set({ autoPreviewBranch: generateBranchId() }),
}));
