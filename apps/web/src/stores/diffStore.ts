import { create } from "zustand";
import type { TurnSnapshot, GitCommit } from "@mcode/contracts";

export type { GitCommit };

/** Active tab in the right panel. */
export type RightPanelTab = "tasks" | "changes" | "preview" | "terminal";

/**
 * View mode within the Review (Changes) tab. The tab is dual-scope: the first
 * four are threadless git working-tree views (read the workspace root); the last
 * three are thread turn views. Each renders exactly one diff. See
 * {@link import("@/lib/review-views").REVIEW_VIEWS} for the selection model.
 */
export type DiffViewMode =
  | "unstaged"
  | "staged"
  | "commit"
  | "branch"
  | "last-turn"
  | "cumulative"
  | "summary";

/** Diff rendering mode. */
export type DiffRenderMode = "unified" | "side-by-side";

/** Minimum right panel width in pixels. */
export const PANEL_MIN_WIDTH = 384;
/**
 * Fallback width when the viewport is unavailable (tests, SSR). Live UI uses half the
 * viewport via {@link getDefaultPanelWidthPx}.
 */
export const PANEL_DEFAULT_WIDTH = 380;
/** Wide snap target for the right panel (double-click drag handle). */
export const PANEL_WIDE_WIDTH = 680;

function clampWidth(w: number): number {
  return Math.max(PANEL_MIN_WIDTH, w);
}

/**
 * Returns the default panel width for the current window (50% of the viewport, clamped
 * to {@link PANEL_MIN_WIDTH}). Used when a thread has no stored width yet.
 */
export function getDefaultPanelWidthPx(): number {
  if (typeof globalThis.window === "undefined") return clampWidth(PANEL_DEFAULT_WIDTH);
  return clampWidth(Math.round(globalThis.window.innerWidth * 0.5));
}

/** Currently selected file for diff viewing. */
export interface SelectedFile {
  source: "snapshot" | "cumulative" | "commit" | "unstaged" | "staged" | "branch";
  /**
   * Identifier resolving the diff for {@link source}: the snapshot ID for
   * `"snapshot"`, the thread ID for `"cumulative"`, the commit SHA for
   * `"commit"`, and the workspace ID for the git working-tree views
   * (`"unstaged"`, `"staged"`, `"branch"`), which read the workspace root.
   */
  id: string;
  filePath: string;
  /** Thread that owns this selection, used to clear on thread deletion. */
  threadId: string;
}

/** Workspace-global right panel state (visibility, width, open tabs, active tab). */
export type RightPanelState = {
  readonly visible: boolean;
  readonly width: number;
  /**
   * The singleton tab types the user has opened, in open order. Empty means no
   * tab is open and the panel shows the card-grid empty state (ADR-0004). Tab
   * types are opened on demand rather than always present.
   */
  readonly openTabs: readonly RightPanelTab[];
  readonly activeTab: RightPanelTab;
};

/** Default line-wrap preference for a thread with no stored override. */
export const DEFAULT_LINE_WRAP = true;

/**
 * Baseline right-panel state for a workspace that has no persisted row (50% viewport width).
 */
export function createDefaultRightPanelState(): RightPanelState {
  return {
    visible: false,
    width: getDefaultPanelWidthPx(),
    openTabs: [],
    activeTab: "tasks",
  };
}

/**
 * Computes the next state slice for a panel visibility change. With a thread,
 * writes the per-thread visibility map; without a thread, writes the workspace
 * threadless `visible` field. Pass `next` to set an explicit value, or
 * `undefined` to toggle the current effective value.
 */
function setPanelVisible(
  state: DiffState,
  workspaceId: string,
  threadId: string | null | undefined,
  next: boolean | undefined,
): Partial<DiffState> {
  if (threadId) {
    const current = state.rightPanelVisibleByThread[threadId] ?? false;
    return {
      rightPanelVisibleByThread: {
        ...state.rightPanelVisibleByThread,
        [threadId]: next ?? !current,
      },
    };
  }
  const current = state.rightPanelByWorkspace[workspaceId] ?? createDefaultRightPanelState();
  return {
    rightPanelByWorkspace: {
      ...state.rightPanelByWorkspace,
      [workspaceId]: { ...current, visible: next ?? !current.visible },
    },
  };
}

/**
 * Static defaults for workspaces with no panel store row; live width uses
 * {@link getDefaultPanelWidthPx} through {@link createDefaultRightPanelState}.
 */
export const RIGHT_PANEL_DEFAULTS: RightPanelState = {
  visible: false,
  width: PANEL_DEFAULT_WIDTH,
  openTabs: [],
  activeTab: "tasks",
} as const;

/** Zustand state shape for the diff panel. */
interface DiffState {
  /** Last preview URL typed or loaded per thread (in-memory only). */
  readonly previewUrlByThread: Record<string, string>;
  /**
   * Workspace-scoped right panel shell keyed by workspace ID. Width and active
   * tab belong to the workspace and persist across thread navigation and with no
   * thread open. The `visible` field here is the *threadless* open/closed state
   * (used when no thread is selected); per-thread open/closed lives in
   * {@link rightPanelVisibleByThread}. Tab *contents* keep their own (thread or
   * workspace-root) scope; see ADR-0004.
   */
  readonly rightPanelByWorkspace: Record<string, RightPanelState>;
  /**
   * Per-thread right panel open/closed state keyed by thread ID. Opening the
   * panel on one thread does not open it on a sibling thread in the same
   * workspace; width and active tab remain shared via {@link rightPanelByWorkspace}.
   * Absent entry means closed. See ADR-0004.
   */
  readonly rightPanelVisibleByThread: Record<string, boolean>;
  /** View mode within the Changes tab. */
  viewMode: DiffViewMode;
  /**
   * The commit the Commit view's picker has resolved to, by SHA. `null` means
   * the picker has not resolved the current scope yet, or the scope has no
   * commits. This is the Commit comparison's picked operand: the Review toolbar's
   * commit picker writes it, and the Commit diff reads it to render exactly that
   * one commit. Reset when the active view changes so a stale pick never bleeds
   * into the next Commit view.
   */
  selectedCommitSha: string | null;
  /** Diff rendering mode. */
  renderMode: DiffRenderMode;
  /** Per-thread line-wrap preference keyed by thread ID. */
  readonly lineWrapByThread: Record<string, boolean>;
  /** Turn snapshots keyed by thread ID. */
  snapshotsByThread: Record<string, TurnSnapshot[]>;
  /** Whether snapshots are currently loading, keyed by thread ID. */
  snapshotsLoadingByThread: Record<string, boolean>;
  /**
   * Whether a deferred snapshot refresh is pending for a thread, keyed by thread ID.
   * Set when a new turn persists while the user is actively viewing the "All" changes
   * view; the CumulativeView surfaces a refresh affordance instead of auto-refetching
   * so the user's scroll position and reading flow aren't disrupted.
   */
  snapshotsPendingByThread: Record<string, boolean>;
  /** Git commits keyed by thread ID. */
  commitsByThread: Record<string, GitCommit[]>;
  /** Whether commits are currently loading, keyed by thread ID. */
  commitsLoadingByThread: Record<string, boolean>;
  /**
   * Inline diff cache keyed by `"threadId:source:id:filePath"`. Survives
   * component unmounts (panel close/reopen, tab switches) so diffs aren't
   * re-fetched. Scoped by thread to prevent cross-thread collisions.
   */
  inlineDiffCache: Record<string, string>;
  /** Currently selected file for diff viewing. */
  selectedFile: SelectedFile | null;
  /** Raw unified diff text for the selected file. */
  diffContent: string | null;
  /** Whether diff content is currently loading. */
  diffLoading: boolean;
  /** Persisted diff summary for the current thread. */
  summaryRecord: {
    id: string;
    threadId: string;
    content: string;
    turnCount: number;
    lastTurnId: string | null;
    model: string;
    createdAt: string;
  } | null;
  /** Whether a summary is currently being generated. */
  summaryLoading: boolean;
  getRightPanel: (workspaceId: string) => RightPanelState;
  /**
   * Effective open/closed state for the panel. With a thread, reads the
   * per-thread map (default closed); without a thread, reads the workspace
   * threadless `visible` field.
   */
  getRightPanelVisible: (workspaceId: string, threadId?: string | null) => boolean;
  /** Toggle the panel for a thread (per-thread) or the threadless shell (workspace). */
  toggleRightPanel: (workspaceId: string, threadId?: string | null) => void;
  /** Open the panel for a thread (per-thread) or the threadless shell (workspace). */
  showRightPanel: (workspaceId: string, threadId?: string | null) => void;
  /** Close the panel for a thread (per-thread) or the threadless shell (workspace). */
  hideRightPanel: (workspaceId: string, threadId?: string | null) => void;
  setRightPanelWidth: (workspaceId: string, width: number) => void;
  setRightPanelTab: (workspaceId: string, tab: RightPanelTab) => void;
  /**
   * Close (remove) a singleton tab from the open set. When the closed tab was
   * active, focus falls back to the most-recently-opened remaining tab; with
   * none left the panel returns to the card-grid empty state. No-op when the tab
   * is not open. See ADR-0004.
   */
  closeRightPanelTab: (workspaceId: string, tab: RightPanelTab) => void;
  setViewMode: (mode: DiffViewMode) => void;
  /** Set the Commit view's picked operand by SHA, or `null` to fall back to the latest commit. */
  setSelectedCommitSha: (sha: string | null) => void;
  setRenderMode: (mode: DiffRenderMode) => void;
  getLineWrap: (threadId: string) => boolean;
  toggleLineWrap: (threadId: string) => void;
  setSnapshots: (threadId: string, snapshots: TurnSnapshot[]) => void;
  setSnapshotsLoading: (threadId: string, loading: boolean) => void;
  /** Flag a thread's all-changes view as having upstream changes not yet reflected. */
  markSnapshotsPending: (threadId: string, pending: boolean) => void;
  setCommits: (threadId: string, commits: GitCommit[]) => void;
  setCommitsLoading: (threadId: string, loading: boolean) => void;
  selectFile: (file: SelectedFile | null) => void;
  setDiffContent: (content: string | null) => void;
  setDiffLoading: (loading: boolean) => void;
  /** Set the loaded summary record. */
  setSummaryRecord: (record: DiffState["summaryRecord"]) => void;
  /** Set summary loading state. */
  setSummaryLoading: (loading: boolean) => void;
  /** Cache a fetched inline diff so it survives component unmounts. */
  cacheInlineDiff: (threadId: string, source: string, id: string, filePath: string, data: string) => void;
  /** Retrieve a cached inline diff, or undefined if not cached. */
  getCachedInlineDiff: (threadId: string, source: string, id: string, filePath: string) => string | undefined;
  /** Persist the omnibox URL for a thread's embedded preview. */
  setPreviewUrlForThread: (threadId: string, url: string) => void;
  clearThread: (threadId: string) => void;
  /** Drop a workspace's persisted panel state (called on workspace deletion). */
  clearWorkspace: (workspaceId: string) => void;
}

/** Zustand store for diff panel and right panel tab state. */
export const useDiffStore = create<DiffState>((set, get) => ({
  previewUrlByThread: {},
  rightPanelByWorkspace: {},
  rightPanelVisibleByThread: {},
  viewMode: "last-turn",
  selectedCommitSha: null,
  renderMode: "unified",
  lineWrapByThread: {},
  snapshotsByThread: {},
  snapshotsLoadingByThread: {},
  snapshotsPendingByThread: {},
  commitsByThread: {},
  commitsLoadingByThread: {},
  inlineDiffCache: {},
  selectedFile: null,
  diffContent: null,
  diffLoading: false,
  summaryRecord: null,
  summaryLoading: false,

  getRightPanel: (workspaceId) =>
    get().rightPanelByWorkspace[workspaceId] ?? createDefaultRightPanelState(),

  getRightPanelVisible: (workspaceId, threadId) => {
    const state = get();
    if (threadId) return state.rightPanelVisibleByThread[threadId] ?? false;
    return state.rightPanelByWorkspace[workspaceId]?.visible ?? false;
  },

  toggleRightPanel: (workspaceId, threadId) =>
    set((state) => setPanelVisible(state, workspaceId, threadId, undefined)),

  showRightPanel: (workspaceId, threadId) =>
    set((state) => setPanelVisible(state, workspaceId, threadId, true)),

  hideRightPanel: (workspaceId, threadId) =>
    set((state) => setPanelVisible(state, workspaceId, threadId, false)),

  setRightPanelWidth: (workspaceId, width) =>
    set((state) => {
      const current = state.rightPanelByWorkspace[workspaceId] ?? createDefaultRightPanelState();
      return {
        rightPanelByWorkspace: {
          ...state.rightPanelByWorkspace,
          [workspaceId]: { ...current, width: clampWidth(width) },
        },
      };
    }),

  setRightPanelTab: (workspaceId, tab) =>
    set((state) => {
      const current = state.rightPanelByWorkspace[workspaceId] ?? createDefaultRightPanelState();
      // Activating a tab opens it: tabs are singletons created on demand, so
      // focusing one that is not yet open adds it to the open set (the card grid
      // is the create surface). Already-open tabs are just refocused.
      const openTabs = current.openTabs.includes(tab)
        ? current.openTabs
        : [...current.openTabs, tab];
      return {
        rightPanelByWorkspace: {
          ...state.rightPanelByWorkspace,
          [workspaceId]: { ...current, openTabs, activeTab: tab },
        },
      };
    }),

  closeRightPanelTab: (workspaceId, tab) =>
    set((state) => {
      const current = state.rightPanelByWorkspace[workspaceId] ?? createDefaultRightPanelState();
      if (!current.openTabs.includes(tab)) return {};
      const openTabs = current.openTabs.filter((t) => t !== tab);
      // Closing the active tab hands focus to the most-recently-opened survivor
      // (the rail's right-most/last entry); with none left, activeTab is left
      // untouched and inert — the empty-state grid renders and the panel's
      // content guards on openTabs.includes(activeTab).
      const activeTab =
        current.activeTab === tab
          ? (openTabs[openTabs.length - 1] ?? current.activeTab)
          : current.activeTab;
      return {
        rightPanelByWorkspace: {
          ...state.rightPanelByWorkspace,
          [workspaceId]: { ...current, openTabs, activeTab },
        },
      };
    }),

  setViewMode: (mode) =>
    set({ viewMode: mode, selectedFile: null, diffContent: null, selectedCommitSha: null }),
  setSelectedCommitSha: (sha) => set({ selectedCommitSha: sha }),
  setRenderMode: (mode) => set({ renderMode: mode }),
  getLineWrap: (threadId) => get().lineWrapByThread[threadId] ?? DEFAULT_LINE_WRAP,
  toggleLineWrap: (threadId) =>
    set((state) => {
      const current = state.lineWrapByThread[threadId] ?? DEFAULT_LINE_WRAP;
      return {
        lineWrapByThread: {
          ...state.lineWrapByThread,
          [threadId]: !current,
        },
      };
    }),
  setSnapshots: (threadId, snapshots) =>
    set((s) => {
      const nextPending = { ...s.snapshotsPendingByThread };
      delete nextPending[threadId];
      return {
        snapshotsByThread: { ...s.snapshotsByThread, [threadId]: snapshots },
        snapshotsPendingByThread: nextPending,
      };
    }),
  setSnapshotsLoading: (threadId, loading) =>
    set((s) => ({ snapshotsLoadingByThread: { ...s.snapshotsLoadingByThread, [threadId]: loading } })),
  markSnapshotsPending: (threadId, pending) =>
    set((s) => {
      const next = { ...s.snapshotsPendingByThread };
      if (pending) next[threadId] = true;
      else delete next[threadId];
      return { snapshotsPendingByThread: next };
    }),
  setCommits: (threadId, commits) =>
    set((s) => ({ commitsByThread: { ...s.commitsByThread, [threadId]: commits } })),
  setCommitsLoading: (threadId, loading) =>
    set((s) => ({ commitsLoadingByThread: { ...s.commitsLoadingByThread, [threadId]: loading } })),
  selectFile: (file) => set({ selectedFile: file, diffContent: null, diffLoading: false }),
  setDiffContent: (content) => set({ diffContent: content, diffLoading: false }),
  setDiffLoading: (loading) => set({ diffLoading: loading }),
  setSummaryRecord: (record) => set({ summaryRecord: record }),
  setSummaryLoading: (loading) => set({ summaryLoading: loading }),
  cacheInlineDiff: (threadId, source, id, filePath, data) =>
    set((s) => ({
      inlineDiffCache: { ...s.inlineDiffCache, [`${threadId}:${source}:${id}:${filePath}`]: data },
    })),
  getCachedInlineDiff: (threadId, source, id, filePath) =>
    get().inlineDiffCache[`${threadId}:${source}:${id}:${filePath}`],
  setPreviewUrlForThread: (threadId, url) =>
    set((s) => ({
      previewUrlByThread: { ...s.previewUrlByThread, [threadId]: url },
    })),
  clearThread: (threadId) =>
    set((state) => {
      const snapshots = { ...state.snapshotsByThread };
      delete snapshots[threadId];
      const snapshotsLoading = { ...state.snapshotsLoadingByThread };
      delete snapshotsLoading[threadId];
      const snapshotsPending = { ...state.snapshotsPendingByThread };
      delete snapshotsPending[threadId];
      const commits = { ...state.commitsByThread };
      delete commits[threadId];
      const commitsLoading = { ...state.commitsLoadingByThread };
      delete commitsLoading[threadId];
      const previewUrls = { ...state.previewUrlByThread };
      delete previewUrls[threadId];
      const lineWrapByThread = { ...state.lineWrapByThread };
      delete lineWrapByThread[threadId];
      const rightPanelVisibleByThread = { ...state.rightPanelVisibleByThread };
      delete rightPanelVisibleByThread[threadId];

      // Evict inline diff cache entries scoped to this thread.
      const prefix = `${threadId}:`;
      const inlineDiffCache: Record<string, string> = {};
      for (const [key, value] of Object.entries(state.inlineDiffCache)) {
        if (!key.startsWith(prefix)) inlineDiffCache[key] = value;
      }

      // Only clear the global selection when it belongs to the deleted thread.
      const selectionBelongsToThread = state.selectedFile?.threadId === threadId;
      const summaryBelongsToThread = state.summaryRecord?.threadId === threadId;

      return {
        snapshotsByThread: snapshots,
        snapshotsLoadingByThread: snapshotsLoading,
        snapshotsPendingByThread: snapshotsPending,
        commitsByThread: commits,
        commitsLoadingByThread: commitsLoading,
        previewUrlByThread: previewUrls,
        lineWrapByThread,
        rightPanelVisibleByThread,
        inlineDiffCache,
        ...(selectionBelongsToThread
          ? { selectedFile: null, diffContent: null, diffLoading: false }
          : {}),
        ...(summaryBelongsToThread
          ? { summaryRecord: null, summaryLoading: false }
          : {}),
      };
    }),
  clearWorkspace: (workspaceId) =>
    set((state) => {
      if (!(workspaceId in state.rightPanelByWorkspace)) return {};
      const rightPanelByWorkspace = { ...state.rightPanelByWorkspace };
      delete rightPanelByWorkspace[workspaceId];
      return { rightPanelByWorkspace };
    }),
}));
