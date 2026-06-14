import { create } from "zustand";
import type { TurnSnapshot, GitCommit, BranchComparison } from "@mcode/contracts";

export type { GitCommit, BranchComparison };

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
  | "cumulative";

/** Diff rendering mode. */
export type DiffRenderMode = "unified" | "side-by-side";

/** Minimum right panel width in pixels. */
export const PANEL_MIN_WIDTH = 384;
/**
 * Minimum width reserved for the chat/composer beside an inline right panel.
 * Drag and resize clamping use this (not {@link PANEL_MIN_WIDTH}) so the panel
 * cannot swallow the project tree and still crush the composer to one column.
 */
export const COMPOSER_MIN_WIDTH = 480;
/** Gap between chat main and right panel in App.tsx (`gap-1.5`). */
export const PANEL_SPLIT_GAP_PX = 6;
/**
 * The panel's default width — a fixed value, not a fraction of the viewport, so
 * the panel opens at the same size on every startup, on every view, regardless of
 * monitor width. Half-the-viewport defaults made the empty/startup panel balloon
 * (e.g. 800px on a 1600px screen) and tip into the cramped-chat overlay; a fixed
 * default keeps it consistent and inline.
 */
export const PANEL_DEFAULT_WIDTH = 440;
/** Wide snap target for the right panel (double-click drag handle). */
export const PANEL_WIDE_WIDTH = 680;

function clampWidth(w: number): number {
  return Math.max(PANEL_MIN_WIDTH, w);
}

/**
 * Returns the panel's default width ({@link PANEL_DEFAULT_WIDTH}, clamped to
 * {@link PANEL_MIN_WIDTH}). A fixed default keeps the startup size consistent
 * across views and monitors. Used when a workspace has no stored width yet.
 */
export function getDefaultPanelWidthPx(): number {
  return clampWidth(PANEL_DEFAULT_WIDTH);
}

/**
 * Largest panel width that still leaves {@link COMPOSER_MIN_WIDTH}px for the
 * composer in a split row of the given inner width (chat + gap + panel).
 */
export function maxPanelWidthInSplit(
  splitWidthPx: number,
  gapPx: number = PANEL_SPLIT_GAP_PX,
): number {
  return Math.max(PANEL_MIN_WIDTH, splitWidthPx - COMPOSER_MIN_WIDTH - gapPx);
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
 * Baseline right-panel state for a workspace that has no persisted row (default width).
 */
export function createDefaultRightPanelState(): RightPanelState {
  return {
    visible: false,
    width: getDefaultPanelWidthPx(),
    openTabs: [],
    activeTab: "tasks",
  };
}

/** Stable cache key for one inline diff payload. */
function inlineDiffCacheKey(
  threadId: string,
  source: string,
  id: string,
  filePath: string,
): string {
  return `${threadId}:${source}:${id}:${filePath}`;
}

/** Drop inline diff cache entries matching a stable key prefix. */
function omitInlineDiffCacheByPrefix(
  cache: Record<string, string>,
  prefix: string,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(cache)) {
    if (!key.startsWith(prefix)) next[key] = value;
  }
  return next;
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
   * The Branch view's current→selected comparison for the current scope, or null
   * until the picker resolves it. Drives both the ref picker and the rendered
   * Branch diff. See
   * `docs/adr/0007-branch-comparison-default-and-range.md`.
   */
  branchComparison: BranchComparison | null;
  /**
   * The scope key (`workspaceId:threadId`) {@link branchComparison} was resolved
   * for. Lets the picker re-resolve on a scope change while preserving a user's
   * picked comparison ref when toggling views within the same scope.
   */
  branchComparisonKey: string | null;
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
   * Inline diff cache keyed by `"threadId:source:id:version:filePath"`. Survives
   * component unmounts (panel close/reopen, tab switches) so diffs aren't
   * re-fetched. Scoped by thread to prevent cross-thread collisions.
   */
  inlineDiffCache: Record<string, string>;
  /**
   * Monotonic revision by diff scope (thread id or workspace id). Mutable git
   * views use this to refetch when a turn or filesystem event changes the
   * checkout without changing the visible ref names.
   */
  diffRevisionByScope: Record<string, number>;
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
  /** Store a resolved Branch comparison for a scope, keyed for staleness tracking. */
  setBranchComparison: (comparison: BranchComparison | null, key: string | null) => void;
  /** Override the base ref of the active Branch comparison (no-op if none resolved). */
  setBranchBase: (ref: string) => void;
  /** Override the target ref of the active Branch comparison (no-op if none resolved). */
  setBranchTarget: (ref: string) => void;
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
  /** Bump a mutable diff scope so mounted file rows refetch against the latest checkout. */
  bumpDiffRevision: (scopeId: string) => void;
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
  branchComparison: null,
  branchComparisonKey: null,
  selectedCommitSha: null,
  renderMode: "unified",
  lineWrapByThread: {},
  snapshotsByThread: {},
  snapshotsLoadingByThread: {},
  snapshotsPendingByThread: {},
  commitsByThread: {},
  commitsLoadingByThread: {},
  inlineDiffCache: {},
  diffRevisionByScope: {},
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
  setBranchComparison: (comparison, key) =>
    set({ branchComparison: comparison, branchComparisonKey: key }),
  setBranchBase: (ref) =>
    set((s) =>
      s.branchComparison
        ? {
            branchComparison: { ...s.branchComparison, base: ref },
            // Changing an operand invalidates the selected file's diff.
            selectedFile: null,
            diffContent: null,
          }
        : {},
    ),
  setBranchTarget: (ref) =>
    set((s) =>
      s.branchComparison
        ? {
            branchComparison: { ...s.branchComparison, target: ref },
            selectedFile: null,
            diffContent: null,
          }
        : {},
    ),
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
        inlineDiffCache: omitInlineDiffCacheByPrefix(
          s.inlineDiffCache,
          `${threadId}:cumulative:${threadId}:`,
        ),
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
      inlineDiffCache: { ...s.inlineDiffCache, [inlineDiffCacheKey(threadId, source, id, filePath)]: data },
    })),
  getCachedInlineDiff: (threadId, source, id, filePath) =>
    get().inlineDiffCache[inlineDiffCacheKey(threadId, source, id, filePath)],
  bumpDiffRevision: (scopeId) =>
    set((s) => ({
      diffRevisionByScope: {
        ...s.diffRevisionByScope,
        [scopeId]: (s.diffRevisionByScope[scopeId] ?? 0) + 1,
      },
      inlineDiffCache: omitInlineDiffCacheByPrefix(s.inlineDiffCache, `${scopeId}:`),
    })),
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
      const diffRevisionByScope = { ...state.diffRevisionByScope };
      delete diffRevisionByScope[threadId];

      const inlineDiffCache = omitInlineDiffCacheByPrefix(state.inlineDiffCache, `${threadId}:`);

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
        diffRevisionByScope,
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
      const cachePrefix = `${workspaceId}:`;
      const hasInlineDiffCache = Object.keys(state.inlineDiffCache).some((key) =>
        key.startsWith(cachePrefix),
      );
      if (
        !(workspaceId in state.rightPanelByWorkspace) &&
        !(workspaceId in state.diffRevisionByScope) &&
        !hasInlineDiffCache
      ) {
        return {};
      }
      const rightPanelByWorkspace = { ...state.rightPanelByWorkspace };
      delete rightPanelByWorkspace[workspaceId];
      const diffRevisionByScope = { ...state.diffRevisionByScope };
      delete diffRevisionByScope[workspaceId];
      return {
        rightPanelByWorkspace,
        diffRevisionByScope,
        inlineDiffCache: omitInlineDiffCacheByPrefix(state.inlineDiffCache, cachePrefix),
      };
    }),
}));
