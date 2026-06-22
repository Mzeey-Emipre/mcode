import { create } from "zustand";
import type { Workspace, Thread, GitBranch, PermissionMode, WorktreeInfo, AttachmentMeta, PrDetail } from "@/transport";
import {
  type WorkspaceThread,
  buildPlaceholderWorkspaceThread,
  titleFromMessageContent,
} from "@/lib/workspace-thread";
import type { ChecksStatus, CreateAndSendResult } from "@mcode/contracts";
import { generateInternalBranchName } from "@/lib/branch-name";
import { getTransport } from "@/transport";
import { useThreadStore } from "./threadStore";
import { deleteThreadRecord, patchThreadRecord } from "./thread-record";
import { useTerminalStore } from "./terminalStore";
import { useQueueStore } from "./queueStore";
import { useTaskStore } from "./taskStore";
import { useComposerDraftStore } from "./composerDraftStore";
import { useDiffStore } from "./diffStore";
import { usePreviewReferenceQueueStore } from "./previewReferenceQueueStore";
import { usePreviewTabsStore } from "./previewTabsStore";
import type { ContextWindowMode, ReasoningLevel, InteractionMode } from "@mcode/contracts";

/** Minimum interval between syncThreadPrs calls per workspace. */
const SYNC_THROTTLE_MS = 30_000;
/** Tracks the last syncThreadPrs request time per workspace. */
const lastSyncTime = new Map<string, number>();

async function clearPreviewResources(threadId: string): Promise<void> {
  await usePreviewTabsStore.getState().clearScope(threadId);
  usePreviewReferenceQueueStore.getState().clearThread(threadId);
}

/**
 * Trailing-edge debounce window for `markThreadViewed` RPCs. Rapid sidebar
 * navigation (e.g. arrow-keys, fast clicks) collapses to one RPC per thread
 * instead of one per click. The "completed -> paused" optimistic local
 * transition is unaffected and still applies synchronously on every click.
 */
const MARK_VIEWED_DEBOUNCE_MS = 150;
const pendingMarkViewedTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleMarkThreadViewed(threadId: string): void {
  const existing = pendingMarkViewedTimers.get(threadId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pendingMarkViewedTimers.delete(threadId);
    getTransport().markThreadViewed(threadId).catch(() => { /* non-critical */ });
  }, MARK_VIEWED_DEBOUNCE_MS);
  pendingMarkViewedTimers.set(threadId, timer);
}

/**
 * Bumped immediately before applying local additions/removals that must win over
 * in-flight {@link WorkspaceState.loadThreads} responses. Without this, a slow
 * `thread.list` that started before branching (for example) can finish after the
 * new thread was merged and overwrite the sidebar with an older snapshot.
 */
const threadListMutationEpochByWorkspace = new Map<string, number>();

function bumpThreadListMutationEpoch(workspaceId: string): void {
  threadListMutationEpochByWorkspace.set(
    workspaceId,
    (threadListMutationEpochByWorkspace.get(workspaceId) ?? 0) + 1,
  );
}

/** Clears mutation-epoch bookkeeping. Used by Vitest only. */
export function __resetThreadListMutationEpochForTests(): void {
  threadListMutationEpochByWorkspace.clear();
}

/** RPC payload remembered so a failed placeholder can retry. Used by Vitest only. */
export function __clearPendingThreadCreationsForTests(): void {
  pendingThreadCreationByPlaceholderId.clear();
}

/** Parameters to replay {@link McodeTransport.createAndSendMessage} after an optimistic insert. */
interface PendingThreadCreation {
  workspaceId: string;
  content: string;
  /** Persisted/UI caption when outbound `content` includes hidden augmentation. */
  displayContent?: string;
  model: string;
  permissionMode?: PermissionMode;
  transportMode: "direct" | "worktree";
  branch: string;
  existingWorktreePath?: string;
  attachments?: AttachmentMeta[];
  reasoningLevel?: ReasoningLevel;
  provider?: string;
  interactionMode?: InteractionMode;
  sourceThreadId?: string;
  forkedFromMessageId?: string;
  copilotAgent?: string;
  contextWindow?: ContextWindowMode;
  thinking?: boolean;
  codexFastMode?: boolean;
}

const pendingThreadCreationByPlaceholderId = new Map<string, PendingThreadCreation>();

async function runCreateAndSend(pending: PendingThreadCreation): Promise<CreateAndSendResult> {
  return getTransport().createAndSendMessage(
    pending.workspaceId,
    pending.content,
    pending.model,
    pending.permissionMode,
    pending.transportMode,
    pending.branch,
    pending.existingWorktreePath,
    pending.attachments,
    pending.reasoningLevel,
    pending.provider,
    pending.interactionMode,
    pending.sourceThreadId,
    pending.forkedFromMessageId,
    pending.copilotAgent,
    pending.contextWindow,
    pending.thinking,
    pending.codexFastMode,
    pending.displayContent,
  );
}
/**
 * Optional RPC dispatch callback used by workspace actions. Tests inject a
 * stub here; production code uses {@link getTransport} directly. The shape
 * mirrors the transport's `call` method so handlers can be swapped freely.
 */
export type WorkspaceRpcCall = (method: string, params: unknown) => Promise<unknown>;

/** Full state shape and action interface for the workspace store. */
interface WorkspaceState {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  threads: WorkspaceThread[];
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
  /** The workspace ID whose worktrees are currently in the `worktrees` array. Null before any load. */
  worktreesLoadedForWorkspace: string | null;
  /** Internal branch name used when provisioning a new worktree thread. */
  autoPreviewBranch: string;
  selectedWorktree: WorktreeInfo | null;
  openPrs: PrDetail[];
  openPrsLoading: boolean;
  fetchingBranch: string | null;
  /** Whether the user has explicitly picked a branch in BranchPicker. Prevents live updates from overriding the user's selection. */
  branchManuallySelected: boolean;
  /** In-memory map of thread ID → PR URL, populated immediately on PR creation so the header can link without waiting for the next poll. */
  prUrlsByThreadId: Record<string, string>;
  /** In-memory map of thread ID → latest CI check status, updated by the thread.checksUpdated push channel. */
  checksById: Record<string, ChecksStatus>;

  // Workspace actions
  loadWorkspaces: () => Promise<void>;
  createWorkspace: (name: string, path: string) => Promise<Workspace>;
  deleteWorkspace: (id: string) => Promise<void>;
  /** Remove a workspace from local state immediately (used by push channel handlers). */
  removeWorkspaceFromState: (id: string) => void;
  /**
   * Set the active workspace by ID. Clears the active thread if it belongs to a
   * different workspace, and bumps the workspace's last_opened_at locally so
   * the project selector re-sorts immediately. Pass an optional `call` to
   * route the touchLastOpened RPC through a custom dispatcher (used in tests).
   */
  setActiveWorkspace: (id: string | null, call?: WorkspaceRpcCall) => void;
  /** Pin or unpin a workspace. Optimistically updates local state; reverts on RPC failure. */
  pinWorkspace: (id: string, pinned: boolean, call?: WorkspaceRpcCall) => Promise<void>;
  /** Remove a workspace from the recents list. Clears last_opened_at and pinned locally; reverts on RPC failure. */
  removeRecent: (id: string, call?: WorkspaceRpcCall) => Promise<void>;
  /** Reorder a workspace in the sidebar (zero-based index). Optimistic update with RPC persistence. */
  reorderWorkspace: (id: string, newIndex: number, call?: WorkspaceRpcCall) => Promise<void>;

  // Thread actions
  loadThreads: (workspaceId: string) => Promise<void>;
  createThread: (
    title: string,
    mode: "direct" | "worktree",
    branch: string,
  ) => Promise<Thread>;
  createAndSendMessage: (
    content: string,
    model: string,
    permissionMode?: PermissionMode,
    attachments?: AttachmentMeta[],
    reasoningLevel?: ReasoningLevel,
    provider?: string,
    interactionMode?: InteractionMode,
    copilotAgent?: string,
    contextWindow?: ContextWindowMode,
    thinking?: boolean,
    codexFastMode?: boolean,
    displayContent?: string,
  ) => Promise<Thread>;
  /** Branch an existing thread into a new child with handoff context. */
  branchThread: (params: {
    sourceThreadId: string;
    content: string;
    displayContent?: string;
    model: string;
    provider?: string;
    mode: "direct" | "worktree" | "existing-worktree";
    branch?: string;
    existingWorktreePath?: string;
    forkedFromMessageId?: string;
    permissionMode?: PermissionMode;
    reasoningLevel?: ReasoningLevel;
    attachments?: AttachmentMeta[];
    interactionMode?: InteractionMode;
    copilotAgent?: string;
    contextWindow?: ContextWindowMode;
    thinking?: boolean;
    codexFastMode?: boolean;
  }) => Promise<Thread>;
  /**
   * Re-run server creation for a placeholder thread after {@link WorkspaceThread.clientError}.
   */
  retryPreparingThread: (placeholderId: string) => Promise<Thread>;
  /** Remove a failed or abandoned placeholder row and drop selection when it was active. */
  dismissPreparingThread: (placeholderId: string) => void;
  /** Surface connection loss while {@link WorkspaceThread.clientPreparing} is true. */
  failPreparingThreadOnConnectionLost: (placeholderId: string) => void;
  deleteThread: (threadId: string, cleanupWorktree: boolean) => Promise<void>;
  setActiveThread: (id: string | null) => void;
  setPendingNewThread: (value: boolean) => void;
  updateThreadTitle: (threadId: string, title: string) => Promise<void>;
  /** Clear non-fatal warnings for a thread (user dismissed the warning banner). */
  dismissWarnings: (threadId: string) => void;

  // Branch actions
  loadBranches: (workspaceId: string) => Promise<void>;
  getCurrentBranch: (workspaceId: string) => Promise<string | null>;
  checkoutBranch: (workspaceId: string, branch: string) => Promise<void>;
  setNewThreadMode: (mode: "direct" | "worktree" | "existing-worktree") => void;
  setNewThreadBranch: (branch: string) => void;
  /** Set whether the user has explicitly picked a branch, preventing live branch updates from overriding it. */
  setBranchManuallySelected: (value: boolean) => void;

  // Worktree actions
  loadWorktrees: (workspaceId: string) => Promise<void>;
  setSelectedWorktree: (worktree: WorktreeInfo | null) => void;
  regenerateAutoPreview: () => void;

  // Branch-from-chat state
  /** Execution mode chosen for the branched thread (direct, new worktree, existing worktree). */
  branchExecMode: "direct" | "worktree" | "existing-worktree";
  /** Base branch selected in the branch-from-chat branch picker. */
  branchTargetBranch: string;
  /** Path of the existing worktree to attach to when branchExecMode is "existing-worktree". */
  branchWorktreePath: string;
  /** Internal branch name for branch-from-chat worktree mode. Independent of autoPreviewBranch. */
  branchAutoPreview: string;

  // Branch-from-chat actions
  /** Initialize branch-mode state from the parent thread and user settings. */
  initBranchMode: (parentThread: Thread | undefined) => void;
  /** Set the execution mode for the branched thread. */
  setBranchExecMode: (mode: "direct" | "worktree" | "existing-worktree") => void;
  /** Set the base branch for the branched thread. */
  setBranchTargetBranch: (branch: string) => void;
  /** Set the existing worktree path for the branched thread. */
  setBranchWorktreePath: (path: string) => void;
  loadOpenPrs: (workspaceId: string) => Promise<void>;
  fetchBranch: (workspaceId: string, branch: string, prNumber?: number) => Promise<void>;
  /**
   * Record a PR that was just created from the dialog. Updates `pr_number` and
   * `pr_status` on the thread immediately and caches the URL so the header can
   * link without waiting for the next background poll.
   */
  recordPrCreated: (threadId: string, prNumber: number, prUrl: string) => void;
}

/** Zustand store for workspace, thread, branch, and PR state management. */
export const useWorkspaceStore = create<WorkspaceState>((set, get) => {
  const applyOptimisticSuccess = (
    placeholderId: string,
    workspaceId: string,
    result: CreateAndSendResult,
    transportWasWorktree: boolean,
  ) => {
    const { warnings, ...thread } = result;
    if (!pendingThreadCreationByPlaceholderId.has(placeholderId)) {
      return;
    }
    if (!get().workspaces.some((w) => w.id === workspaceId)) {
      pendingThreadCreationByPlaceholderId.delete(placeholderId);
      return;
    }
    const pending = pendingThreadCreationByPlaceholderId.get(placeholderId);
    bumpThreadListMutationEpoch(workspaceId);
    pendingThreadCreationByPlaceholderId.delete(placeholderId);
    const startTime =
      useThreadStore.getState().records.get(placeholderId)?.agentStartTime ?? Date.now();
    useThreadStore.setState((state) => {
      const nextRunning = new Set(state.runningThreadIds);
      nextRunning.delete(placeholderId);
      nextRunning.add(thread.id);
      let records = deleteThreadRecord(state.records, placeholderId);
      records = patchThreadRecord(records, thread.id, { agentStartTime: startTime });
      return { runningThreadIds: nextRunning, records };
    });
    set((state) => {
      const without = state.threads.filter((t) => t.id !== placeholderId);
      const deduped = without.filter((t) => t.id !== thread.id);
      const hydratedThread: WorkspaceThread = {
        ...thread,
        model: pending?.model ?? thread.model ?? null,
        provider: pending?.provider ?? thread.provider ?? "claude",
        reasoning_level: pending?.reasoningLevel ?? thread.reasoning_level ?? null,
        interaction_mode: pending?.interactionMode ?? thread.interaction_mode ?? null,
        permission_mode: pending?.permissionMode ?? thread.permission_mode ?? null,
        context_window_mode: pending?.contextWindow ?? thread.context_window_mode ?? null,
        thinking: pending?.thinking ?? thread.thinking ?? null,
        codex_fast_mode: (
          pending?.provider === "codex" ? (pending.codexFastMode ?? null) : null
        ) ?? thread.codex_fast_mode ?? null,
        copilot_agent: (
          pending?.provider === "copilot" ? (pending.copilotAgent ?? null) : null
        ) ?? thread.copilot_agent ?? null,
      };
      const wt: WorkspaceThread = warnings?.length
        ? { ...hydratedThread, clientWarnings: warnings }
        : hydratedThread;
      const nextThreads: WorkspaceThread[] = [wt, ...deduped];
      const stillOnPlaceholder = state.activeThreadId === placeholderId;
      return {
        threads: nextThreads,
        activeThreadId: stillOnPlaceholder ? thread.id : state.activeThreadId,
        error: null,
        ...(transportWasWorktree ? { worktreesLoadedForWorkspace: null } : {}),
      };
    });
    if (get().activeThreadId === thread.id) {
      void useThreadStore.getState().loadMessages(thread.id);
    }
  };

  const applyOptimisticFailure = (placeholderId: string, err: unknown) => {
    const msg = String(err);
    useThreadStore.setState((state) => {
      const nextRunning = new Set(state.runningThreadIds);
      nextRunning.delete(placeholderId);
      return {
        runningThreadIds: nextRunning,
        records: deleteThreadRecord(state.records, placeholderId),
      };
    });
    set((state) => ({
      threads: state.threads.map((t) =>
        t.id === placeholderId
          ? { ...t, clientPreparing: false, clientError: msg }
          : t,
      ),
      error: msg,
    }));
  };

  return {
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
  worktreesLoadedForWorkspace: null,
  autoPreviewBranch: generateInternalBranchName(),
  selectedWorktree: null,
  openPrs: [],
  openPrsLoading: false,
  fetchingBranch: null,
  branchManuallySelected: false,
  // Branch-from-chat fields — safe defaults; always reset by initBranchMode before use.
  branchExecMode: "direct" as const,
  branchTargetBranch: "",
  branchWorktreePath: "",
  branchAutoPreview: generateInternalBranchName(),
  prUrlsByThreadId: {},
  checksById: {},

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
      // The server is idempotent on path: re-adding an existing folder returns
      // the live workspace (bumped to the top server-side). Dedupe by id before
      // prepending so a re-add moves the existing entry to the front instead of
      // rendering it twice.
      set((state) => ({
        workspaces: [
          workspace,
          ...state.workspaces.filter((w) => w.id !== workspace.id),
        ],
      }));
      return workspace;
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  deleteWorkspace: async (id) => {
    set({ error: null });
    try {
      const deletedThreadIds = get()
        .threads.filter((t) => t.workspace_id === id)
        .map((t) => t.id);
      await Promise.all(deletedThreadIds.map((tid) => clearPreviewResources(tid)));
      await getTransport().deleteWorkspace(id);
      bumpThreadListMutationEpoch(id);
      const draftStore = useComposerDraftStore.getState();
      const taskStore = useTaskStore.getState();
      const terminalStore = useTerminalStore.getState();
      const diffStore = useDiffStore.getState();
      for (const tid of deletedThreadIds) {
        draftStore.clearDraft(tid);
        taskStore.clearTasks(tid);
        terminalStore.clearThread(tid);
        diffStore.clearThread(tid);
      }
      // The right panel is workspace-global, so its state is dropped once per
      // workspace rather than per thread.
      diffStore.clearWorkspace(id);
      // Remove threads from store FIRST (same ordering as deleteThread) so
      // any in-flight timer callbacks see threads as gone before timers are cancelled.
      const deletedIdSet = new Set(deletedThreadIds);
      set((state) => ({
        workspaces: state.workspaces.filter((w) => w.id !== id),
        activeWorkspaceId:
          state.activeWorkspaceId === id ? null : state.activeWorkspaceId,
        threads: state.threads.filter((t) => t.workspace_id !== id),
        activeThreadId:
          state.activeThreadId &&
          deletedThreadIds.includes(state.activeThreadId)
            ? null
            : state.activeThreadId,
        checksById: Object.fromEntries(
          Object.entries(state.checksById).filter(([tid]) => !deletedIdSet.has(tid)),
        ),
      }));
      // One batched Zustand set() for all threads instead of N sequential calls.
      useThreadStore.getState().clearThreadStateMany(deletedThreadIds);
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  removeWorkspaceFromState: (id) => {
    set((state) => ({
      workspaces: state.workspaces.filter((w) => w.id !== id),
      activeWorkspaceId: state.activeWorkspaceId === id ? null : state.activeWorkspaceId,
    }));
  },

  setActiveWorkspace: (id, call) => {
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
      worktreesLoading: false,
      worktreesLoadedForWorkspace: null,
      selectedWorktree: null,
      openPrs: [],
      openPrsLoading: false,
      fetchingBranch: null,
      branchManuallySelected: false,
    });
    if (id) {
      get().loadThreads(id);
      // Optimistically bump the local last_opened_at so the project selector
      // re-sorts immediately. Without this the row only moves to the top of
      // "Recent" after the next workspace list refresh, which feels laggy.
      const now = Date.now();
      set((s) => ({
        workspaces: s.workspaces.map((w) =>
          w.id === id ? { ...w, last_opened_at: now } : w
        ),
      }));
      // Record this as the last-opened workspace for recency ordering in the project selector.
      if (call) {
        call("workspace.touchLastOpened", { id }).catch(() => {});
      } else {
        getTransport().touchLastOpened(id).catch(() => {});
      }
    }
  },

  pinWorkspace: async (id, pinned, call) => {
    // Snapshot the prior pinned value so a retry/no-op (where the previous
    // value already matches `pinned`) reverts to the correct state instead of
    // toggling away from it.
    const prevPinned = get().workspaces.find((w) => w.id === id)?.pinned;
    // Optimistic update so the UI reflects the change instantly.
    set((s) => ({
      workspaces: s.workspaces.map((w) => w.id === id ? { ...w, pinned } : w),
    }));
    try {
      if (call) {
        await call("workspace.pin", { id, pinned });
      } else {
        await getTransport().pinWorkspace(id, pinned);
      }
    } catch (err) {
      // Revert the optimistic update on failure using the snapshot.
      if (prevPinned !== undefined) {
        set((s) => ({
          workspaces: s.workspaces.map((w) =>
            w.id === id ? { ...w, pinned: prevPinned } : w
          ),
        }));
      }
      throw err;
    }
  },

  removeRecent: async (id, call) => {
    // Snapshot the prior state so we can revert if the RPC fails — otherwise a
    // server error would silently strip the row from the UI's recents list.
    const prev = get().workspaces.find((w) => w.id === id);
    // Optimistic update: clear recency and pinned state locally.
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === id ? { ...w, pinned: false, last_opened_at: null } : w
      ),
    }));
    try {
      if (call) {
        await call("workspace.removeRecent", { id });
      } else {
        await getTransport().removeRecent(id);
      }
    } catch (err) {
      if (prev) {
        set((s) => ({
          workspaces: s.workspaces.map((w) =>
            w.id === id
              ? { ...w, pinned: prev.pinned, last_opened_at: prev.last_opened_at }
              : w
          ),
        }));
      }
      throw err;
    }
  },

  reorderWorkspace: async (id, newIndex, call) => {
    const prev = get().workspaces.slice();
    const oldIndex = prev.findIndex((w) => w.id === id);
    if (oldIndex < 0) return;
    const bounded = Math.max(0, Math.min(newIndex, prev.length - 1));
    if (oldIndex === bounded) return;
    const next = [...prev];
    const [removed] = next.splice(oldIndex, 1);
    next.splice(bounded, 0, removed!);
    set({ workspaces: next, error: null });
    try {
      if (call) {
        await call("workspace.reorder", { id, newIndex: bounded });
      } else {
        await getTransport().reorderWorkspace(id, bounded);
      }
    } catch (err) {
      set({ workspaces: prev, error: String(err) });
      throw err;
    }
  },

  loadThreads: async (workspaceId) => {
    const epochAtStart = threadListMutationEpochByWorkspace.get(workspaceId) ?? 0;
    // Stale-while-revalidate: only show loading spinner if there are NO
    // existing threads for this workspace. If threads are already in state
    // (from a prior load), keep showing them while the refresh runs.
    const hasStaleThreads = get().threads.some((t) => t.workspace_id === workspaceId);
    set({ loading: !hasStaleThreads, error: null });
    try {
      const newThreads = await getTransport().listThreads(workspaceId);
      if ((threadListMutationEpochByWorkspace.get(workspaceId) ?? 0) !== epochAtStart) {
        set({ loading: false });
        return;
      }
      // Replace threads for this workspace; keep threads from other workspaces intact.
      // Retain optimistic placeholder rows until the server confirms the real thread.
      set((state) => {
        const placeholders = state.threads.filter(
          (t) =>
            t.workspace_id === workspaceId &&
            (t.clientPreparing === true || t.clientError != null),
        );
        const incomingIds = new Set(newThreads.map((t) => t.id));
        const extraPlaceholders = placeholders.filter((p) => !incomingIds.has(p.id));
        const mergedForWorkspace = [...extraPlaceholders, ...newThreads];
        return {
          threads: [
            ...state.threads.filter((t) => t.workspace_id !== workspaceId),
            ...mergedForWorkspace,
          ],
          loading: false,
        };
      });

      const epochForPrSync = epochAtStart;

      // Background PR sync: scanned for new PRs and refreshed stale PR states (throttled)
      const now = Date.now();
      const lastSync = lastSyncTime.get(workspaceId) ?? 0;
      if (now - lastSync >= SYNC_THROTTLE_MS) {
        lastSyncTime.set(workspaceId, now);
        getTransport().syncThreadPrs(workspaceId).then((results) => {
          if (results.length === 0) return;
          // Discard results if the workspace changed while the request was in flight
          if (get().activeWorkspaceId !== workspaceId) return;
          if ((threadListMutationEpochByWorkspace.get(workspaceId) ?? 0) !== epochForPrSync) {
            return;
          }
          const resultMap = new Map(results.map((r) => [r.threadId, r]));
          set((state) => ({
            threads: state.threads.map((t) => {
              const match = resultMap.get(t.id);
              if (!match) return t;
              // null prNumber means the stale PR was cleared server-side
              return { ...t, pr_number: match.prNumber, pr_status: match.prStatus };
            }),
          }));
        }).catch(() => {});
      }
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
      bumpThreadListMutationEpoch(activeWorkspaceId);
      set((state) => ({ threads: [thread, ...state.threads] }));
      return thread;
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  createAndSendMessage: async (
    content,
    model,
    permissionMode,
    attachments,
    reasoningLevel,
    provider,
    interactionMode,
    copilotAgent,
    contextWindow,
    thinking,
    codexFastMode,
    displayContent,
  ) => {
    const workspaceId = get().activeWorkspaceId;
    if (!workspaceId) throw new Error("No workspace selected");

    const { newThreadMode, newThreadBranch, autoPreviewBranch, selectedWorktree } = get();

    let mode: "direct" | "worktree" = "direct";
    let branch = newThreadBranch || "main";
    let existingWorktreePath: string | undefined;

    if (newThreadMode === "worktree") {
      mode = "worktree";
      branch = newThreadBranch || autoPreviewBranch;
    } else if (newThreadMode === "existing-worktree") {
      mode = "worktree";
      if (!selectedWorktree) throw new Error("No worktree selected");
      branch = selectedWorktree.branch;
      existingWorktreePath = selectedWorktree.path;
    }

    const clientPreparingContext =
      newThreadMode === "worktree"
        ? "new-worktree"
        : newThreadMode === "existing-worktree"
          ? "new-existing-worktree"
          : "new-direct";

    const placeholderId = crypto.randomUUID();
    const pending: PendingThreadCreation = {
      workspaceId,
      content,
      displayContent,
      model,
      permissionMode,
      transportMode: mode,
      branch,
      existingWorktreePath,
      attachments,
      reasoningLevel,
      provider,
      interactionMode,
      copilotAgent,
      contextWindow,
      thinking,
      codexFastMode,
    };

    const captionForUi = displayContent ?? content;

    const placeholder = buildPlaceholderWorkspaceThread({
      id: placeholderId,
      workspaceId,
      title: titleFromMessageContent(captionForUi),
      queuedMessage: captionForUi,
      transportMode: mode,
      branch,
      clientPreparingContext,
      model,
      provider,
      reasoningLevel,
      interactionMode,
      permissionMode,
      contextWindow,
      thinking,
      codexFastMode: provider === "codex" ? (codexFastMode ?? null) : null,
      copilotAgent: provider === "copilot" ? (copilotAgent ?? null) : null,
    });

    bumpThreadListMutationEpoch(workspaceId);
    pendingThreadCreationByPlaceholderId.set(placeholderId, pending);
    set((state) => ({
      threads: [placeholder, ...state.threads],
      activeThreadId: placeholderId,
      pendingNewThread: false,
      branchManuallySelected: false,
      error: null,
    }));

    useThreadStore.setState((state) => ({
      runningThreadIds: new Set([...state.runningThreadIds, placeholderId]),
      records: patchThreadRecord(state.records, placeholderId, { agentStartTime: Date.now() }),
    }));

    try {
      const result = await runCreateAndSend(pending);
      applyOptimisticSuccess(placeholderId, workspaceId, result, mode === "worktree");
      return result;
    } catch (e) {
      applyOptimisticFailure(placeholderId, e);
      throw e;
    }
  },

  branchThread: async (params) => {
    const workspaceId = get().activeWorkspaceId;
    if (!workspaceId) throw new Error("No workspace selected");

    let transportMode: "direct" | "worktree" = "direct";
    const branch = params.branch ?? "main";
    let existingWorktreePath: string | undefined;

    if (params.mode === "worktree") {
      transportMode = "worktree";
    } else if (params.mode === "existing-worktree") {
      if (!params.existingWorktreePath) {
        throw new Error("existingWorktreePath is required for existing-worktree mode");
      }
      transportMode = "worktree";
      existingWorktreePath = params.existingWorktreePath;
    }

    const clientPreparingContext =
      params.mode === "worktree"
        ? "branch-worktree"
        : params.mode === "existing-worktree"
          ? "branch-existing-worktree"
          : "branch-direct";

    const placeholderId = crypto.randomUUID();
    const pending: PendingThreadCreation = {
      workspaceId,
      content: params.content,
      displayContent: params.displayContent,
      model: params.model,
      permissionMode: params.permissionMode,
      transportMode,
      branch,
      existingWorktreePath,
      attachments: params.attachments,
      reasoningLevel: params.reasoningLevel,
      provider: params.provider,
      interactionMode: params.interactionMode,
      sourceThreadId: params.sourceThreadId,
      forkedFromMessageId: params.forkedFromMessageId,
      copilotAgent: params.copilotAgent,
      contextWindow: params.contextWindow,
      thinking: params.thinking,
      codexFastMode: params.codexFastMode,
    };

    const branchCaptionForUi = params.displayContent ?? params.content;

    const placeholder = buildPlaceholderWorkspaceThread({
      id: placeholderId,
      workspaceId,
      title: titleFromMessageContent(branchCaptionForUi),
      queuedMessage: branchCaptionForUi,
      transportMode,
      branch,
      clientPreparingContext,
      model: params.model,
      provider: params.provider,
      reasoningLevel: params.reasoningLevel,
      interactionMode: params.interactionMode,
      permissionMode: params.permissionMode,
      contextWindow: params.contextWindow,
      thinking: params.thinking,
      codexFastMode: params.provider === "codex" ? (params.codexFastMode ?? null) : null,
      copilotAgent: params.provider === "copilot" ? (params.copilotAgent ?? null) : null,
      parentThreadId: params.sourceThreadId,
      forkedFromMessageId: params.forkedFromMessageId,
    });

    bumpThreadListMutationEpoch(workspaceId);
    pendingThreadCreationByPlaceholderId.set(placeholderId, pending);
    set((state) => ({
      threads: [placeholder, ...state.threads],
      activeThreadId: placeholderId,
      pendingNewThread: false,
      branchManuallySelected: false,
      error: null,
    }));

    useThreadStore.setState((state) => ({
      runningThreadIds: new Set([...state.runningThreadIds, placeholderId]),
      records: patchThreadRecord(state.records, placeholderId, { agentStartTime: Date.now() }),
    }));

    try {
      const result = await runCreateAndSend(pending);
      applyOptimisticSuccess(placeholderId, workspaceId, result, transportMode === "worktree");
      return result;
    } catch (e) {
      applyOptimisticFailure(placeholderId, e);
      throw e;
    }
  },

  retryPreparingThread: async (placeholderId) => {
    const pending = pendingThreadCreationByPlaceholderId.get(placeholderId);
    if (!pending) {
      throw new Error("No pending creation for this thread");
    }
    const row = get().threads.find((t) => t.id === placeholderId);
    if (!row?.clientError) {
      throw new Error("Thread is not in a retryable state");
    }
    set((state) => ({
      error: null,
      threads: state.threads.map((t) =>
        t.id === placeholderId
          ? { ...t, clientPreparing: true, clientError: null }
          : t,
      ),
    }));
    useThreadStore.setState((state) => ({
      runningThreadIds: new Set([...state.runningThreadIds, placeholderId]),
      records: patchThreadRecord(state.records, placeholderId, { agentStartTime: Date.now() }),
    }));
    try {
      const result = await runCreateAndSend(pending);
      applyOptimisticSuccess(placeholderId, pending.workspaceId, result, pending.transportMode === "worktree");
      return result;
    } catch (e) {
      applyOptimisticFailure(placeholderId, e);
      throw e;
    }
  },

  dismissPreparingThread: (placeholderId) => {
    pendingThreadCreationByPlaceholderId.delete(placeholderId);
    useThreadStore.getState().clearThreadState(placeholderId);
    set((state) => ({
      threads: state.threads.filter((t) => t.id !== placeholderId),
      activeThreadId: state.activeThreadId === placeholderId ? null : state.activeThreadId,
    }));
  },

  failPreparingThreadOnConnectionLost: (placeholderId) => {
    const row = get().threads.find((t) => t.id === placeholderId);
    if (!row?.clientPreparing) return;
    applyOptimisticFailure(placeholderId, new Error("Connection lost while creating this thread. Try again."));
  },

  deleteThread: async (threadId, cleanupWorktree) => {
    set({ error: null });
    try {
      pendingThreadCreationByPlaceholderId.delete(threadId);
      const row = get().threads.find((t) => t.id === threadId);
      const workspaceIdForEpoch = row?.workspace_id;
      const isClientOnly = !!(row?.clientPreparing || row?.clientError);

      if (isClientOnly) {
        await clearPreviewResources(threadId);
        if (workspaceIdForEpoch) {
          bumpThreadListMutationEpoch(workspaceIdForEpoch);
        }
        useTerminalStore.getState().clearThread(threadId);
        useQueueStore.getState().clearQueue(threadId);
        useComposerDraftStore.getState().clearDraft(threadId);
        useTaskStore.getState().clearTasks(threadId);
        useDiffStore.getState().clearThread(threadId);
        set((state) => {
          const remainingUrls = Object.fromEntries(
            Object.entries(state.prUrlsByThreadId).filter(([k]) => k !== threadId),
          ) as Record<string, string>;
          const remainingChecks = Object.fromEntries(
            Object.entries(state.checksById).filter(([k]) => k !== threadId),
          ) as typeof state.checksById;
          return {
            threads: state.threads.filter((t) => t.id !== threadId),
            activeThreadId: state.activeThreadId === threadId ? null : state.activeThreadId,
            prUrlsByThreadId: remainingUrls,
            checksById: remainingChecks,
          };
        });
        useThreadStore.getState().clearThreadState(threadId);
        return;
      }

      await clearPreviewResources(threadId);
      await getTransport().deleteThread(threadId, cleanupWorktree);
      if (workspaceIdForEpoch) {
        bumpThreadListMutationEpoch(workspaceIdForEpoch);
      }
      useTerminalStore.getState().clearThread(threadId);
      useQueueStore.getState().clearQueue(threadId);
      useComposerDraftStore.getState().clearDraft(threadId);
      useTaskStore.getState().clearTasks(threadId);
      useDiffStore.getState().clearThread(threadId);
      // Remove from threads[] FIRST so any in-flight dequeue timer callback's
      // threadExists guard sees the thread as deleted before clearThreadState
      // cancels the timer. This closes the race window between the timer
      // callback checking membership and the timer being cancelled.
      set((state) => {
        const remainingUrls = Object.fromEntries(
          Object.entries(state.prUrlsByThreadId).filter(([k]) => k !== threadId),
        ) as Record<string, string>;
        const remainingChecks = Object.fromEntries(
          Object.entries(state.checksById).filter(([k]) => k !== threadId),
        ) as typeof state.checksById;
        return {
          threads: state.threads.filter((t) => t.id !== threadId),
          activeThreadId: state.activeThreadId === threadId ? null : state.activeThreadId,
          prUrlsByThreadId: remainingUrls,
          checksById: remainingChecks,
        };
      });
      useThreadStore.getState().clearThreadState(threadId);
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  /**
   * Set the active thread and clear the "completed" badge if present.
   *
   * When a user opens a completed thread, the green badge is dismissed
   * both locally (optimistic) and in the DB (via markThreadViewed IPC)
   * so it stays cleared across workspace switches and app restarts.
   */
  setActiveThread: (id) => {
    const thread = id ? get().threads.find((t) => t.id === id) : null;
    const isCompleted = thread?.status === "completed";

    set((state) => ({
      activeThreadId: id,
      ...(id ? { pendingNewThread: false } : {}),
      threads: isCompleted
        ? state.threads.map((t) =>
            t.id === id ? { ...t, status: "paused" as const } : t,
          )
        : state.threads,
    }));

    if (isCompleted && id) {
      scheduleMarkThreadViewed(id);
    }
  },

  setPendingNewThread: (value) => {
    set({
      pendingNewThread: value,
      ...(value
        ? {
            newThreadMode: "direct" as const,
            newThreadBranch: "",
            autoPreviewBranch: generateInternalBranchName(),
            selectedWorktree: null,
            branchManuallySelected: false,
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

  dismissWarnings: (threadId) => {
    set((state) => ({
      threads: state.threads.map((t) =>
        t.id === threadId ? { ...t, clientWarnings: null } : t,
      ),
    }));
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
    set({
      newThreadMode: mode,
      ...(mode === "worktree" ? { newThreadBranch: "" } : {}),
    });
  },

  setNewThreadBranch: (branch) => {
    set({ newThreadBranch: branch });
  },

  setBranchManuallySelected: (value) => {
    set({ branchManuallySelected: value });
  },

  loadWorktrees: async (workspaceId) => {
    set({ worktreesLoading: true, error: null });
    try {
      const worktrees = await getTransport().listWorktrees(workspaceId);
      if (get().activeWorkspaceId !== workspaceId) return;
      set({ worktrees, worktreesLoading: false, worktreesLoadedForWorkspace: workspaceId, error: null });
    } catch (e) {
      if (get().activeWorkspaceId !== workspaceId) return;
      set({ worktreesLoading: false, error: String(e) });
    }
  },

  setSelectedWorktree: (worktree) => set({ selectedWorktree: worktree }),
  regenerateAutoPreview: () => set({ autoPreviewBranch: generateInternalBranchName() }),
  initBranchMode: (parentThread) => {
    const defaultExecMode: "direct" | "worktree" | "existing-worktree" =
      parentThread?.mode === "worktree" ? "existing-worktree" : "direct";
    set({
      branchExecMode: defaultExecMode,
      branchTargetBranch: parentThread?.branch ?? "",
      branchWorktreePath: parentThread?.worktree_path ?? "",
      branchAutoPreview: generateInternalBranchName(),
    });
  },
  setBranchExecMode: (mode) => set({ branchExecMode: mode }),
  setBranchTargetBranch: (branch) => set({ branchTargetBranch: branch }),
  setBranchWorktreePath: (path) => set({ branchWorktreePath: path }),

  loadOpenPrs: async (workspaceId) => {
    set({ openPrsLoading: true });
    try {
      const openPrs = await getTransport().listOpenPrs(workspaceId);
      if (get().activeWorkspaceId !== workspaceId) return;
      set({ openPrs, openPrsLoading: false });
    } catch (e) {
      if (get().activeWorkspaceId !== workspaceId) return;
      set({ openPrsLoading: false, error: String(e) });
    }
  },

  fetchBranch: async (workspaceId, branch, prNumber?) => {
    set({ fetchingBranch: branch });
    try {
      await getTransport().fetchBranch(workspaceId, branch, prNumber);
      // Refresh branches so the newly fetched branch appears as local
      await get().loadBranches(workspaceId);
    } finally {
      set({ fetchingBranch: null });
    }
  },

  recordPrCreated: (threadId, prNumber, prUrl) => {
    set((state) => {
      const thread = state.threads.find((t) => t.id === threadId);
      if (!thread) return state;
      return {
        threads: state.threads.map((t) =>
          t.id === threadId ? { ...t, pr_number: prNumber, pr_status: "OPEN" } : t,
        ),
        prUrlsByThreadId: { ...state.prUrlsByThreadId, [threadId]: prUrl },
      };
    });
  },
};
});
