import { create } from "zustand";
import type { TurnSnapshot, GitCommit, BranchComparison } from "@mcode/contracts";
import { defaultReviewView, type ReviewChangeState } from "@/lib/review-views";

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

/**
 * Right panel container state (visibility, width, open tabs, active tab). Stored
 * per thread, with one workspace-level fallback for the threadless and
 * not-yet-customized cases (ADR-0012).
 */
export type RightPanelState = {
  readonly visible: boolean;
  readonly width: number;
  /** Whether width came from adaptive auto-open sizing or an explicit user resize. */
  readonly widthSource?: "auto" | "user";
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
 * Baseline right-panel state used when neither the thread nor its workspace
 * fallback has a stored record yet (default width, closed, no open tabs).
 */
export function createDefaultRightPanelState(): RightPanelState {
  return {
    visible: false,
    width: getDefaultPanelWidthPx(),
    widthSource: "auto",
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

/** Copy a record, dropping entries whose key ends with `suffix`. */
function omitByKeySuffix<V>(record: Record<string, V>, suffix: string): Record<string, V> {
  const next: Record<string, V> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!key.endsWith(suffix)) next[key] = value;
  }
  return next;
}

/** Copy a record, dropping entries whose key starts with `prefix`. */
function omitByKeyPrefix<V>(record: Record<string, V>, prefix: string): Record<string, V> {
  const next: Record<string, V> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!key.startsWith(prefix)) next[key] = value;
  }
  return next;
}

/**
 * Resolves the effective panel record for a scope (ADR-0012 copy-on-write read).
 * A thread with its own record uses it; otherwise it falls through to the
 * workspace fallback, which also serves the threadless shell. Defaults when
 * neither exists yet.
 */
function effectiveRightPanel(
  state: DiffState,
  workspaceId: string,
  threadId: string | null | undefined,
): RightPanelState {
  if (threadId) {
    const own = state.rightPanelByThread[threadId];
    if (own) return own;
  }
  return state.rightPanelFallbackByWorkspace[workspaceId] ?? createDefaultRightPanelState();
}

/**
 * Computes the next state slice that writes `next` to a scope's panel record. A
 * thread writes (and so diverges into) its own per-thread record; without a
 * thread, the write lands on the workspace fallback. This is the copy-on-write
 * write path that pairs with {@link effectiveRightPanel}.
 */
function writeRightPanel(
  state: DiffState,
  workspaceId: string,
  threadId: string | null | undefined,
  next: RightPanelState,
): Partial<DiffState> {
  if (threadId) {
    return {
      rightPanelByThread: { ...state.rightPanelByThread, [threadId]: next },
    };
  }
  return {
    rightPanelFallbackByWorkspace: {
      ...state.rightPanelFallbackByWorkspace,
      [workspaceId]: next,
    },
  };
}

/**
 * Computes the next state slice for a panel visibility change. Reads the scope's
 * effective record and writes it back through copy-on-write. Pass `next` to set
 * an explicit value, or `undefined` to toggle the current effective value.
 */
function setPanelVisible(
  state: DiffState,
  workspaceId: string,
  threadId: string | null | undefined,
  next: boolean | undefined,
): Partial<DiffState> {
  const current = effectiveRightPanel(state, workspaceId, threadId);
  return writeRightPanel(state, workspaceId, threadId, {
    ...current,
    visible: next ?? !current.visible,
  });
}

/**
 * Static defaults for workspaces with no panel store row; live width uses
 * {@link getDefaultPanelWidthPx} through {@link createDefaultRightPanelState}.
 */
export const RIGHT_PANEL_DEFAULTS: RightPanelState = {
  visible: false,
  width: PANEL_DEFAULT_WIDTH,
  widthSource: "auto",
  openTabs: [],
  activeTab: "tasks",
} as const;

/** Zustand state shape for the diff panel. */
interface DiffState {
  /** Last preview URL typed or loaded per thread (in-memory only). */
  readonly previewUrlByThread: Record<string, string>;
  /**
   * Per-thread right panel container state keyed by thread ID — the full record
   * (visibility, width, open tabs, active tab). A thread has no entry until it
   * writes one (copy-on-write divergence from the workspace fallback), after
   * which its own record is authoritative. Dropped by {@link clearThread}. Tab
   * *contents* keep their own (thread or workspace-root) scope; see ADR-0012.
   */
  readonly rightPanelByThread: Record<string, RightPanelState>;
  /**
   * One workspace-level fallback panel record keyed by workspace ID. Serves the
   * threadless Browser/Terminal shell and seeds a not-yet-customized thread's
   * first read, until that thread diverges into its own
   * {@link rightPanelByThread} entry. See ADR-0012.
   */
  readonly rightPanelFallbackByWorkspace: Record<string, RightPanelState>;
  /** View mode within the Changes tab (the single rendered view). */
  viewMode: DiffViewMode;
  /**
   * Per-thread remembered Review view, keyed by thread ID. Written when the user
   * picks a view for a thread; read back to restore that pick when returning to
   * the thread. In-memory only; dropped by {@link clearThread}. See ADR-0011.
   */
  readonly reviewViewByThread: Record<string, DiffViewMode>;
  /**
   * Per-thread "the user picked a view" override flag, keyed by thread ID. While
   * unset, the Review default re-evaluates live from the thread's change state;
   * once set, the pick sticks and auto-defaulting stops for that thread. Mirrors
   * the `branchManuallySelected` guard in workspaceStore. See ADR-0011.
   */
  readonly reviewViewManuallySelectedByThread: Record<string, boolean>;
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
   * Per-scope "the user manually picked a Branch comparison operand" flag, keyed
   * by the same `workspaceId:threadId` scope as {@link branchComparisonKey}. While
   * set, re-resolution preserves the user's picked ref (when it still exists)
   * instead of reverting to the server default - so a turn-driven `diffRevision`
   * bump or a picker remount no longer clobbers the selection. Mirrors
   * `reviewViewManuallySelectedByThread` (ADR-0011).
   */
  branchManuallySelectedByScope: Record<string, boolean>;
  /**
   * The `diffRevision` each scope's {@link branchComparison} was last resolved at,
   * keyed by scope. Store-backed (not a component ref) so the "already resolved for
   * this scope+revision" guard survives a picker remount and skips a redundant
   * re-fetch.
   */
  branchResolvedRevisionByScope: Record<string, number>;
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
  /** Changed-file count for the active Review view, shown as a toolbar badge. Null when unknown. */
  reviewFileCount: number | null;
  /** Total added/removed lines for the active Review view. Null while loading or unknown. */
  reviewDiffStat: { additions: number; deletions: number } | null;
  /** Bulk expand/collapse command for the Review view's file cards; each FileEntry applies it on nonce change. */
  bulkDiffExpand: { expand: boolean; nonce: number } | null;
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
  /**
   * Effective panel record for a scope: the thread's own record when it has
   * diverged, otherwise the workspace fallback (ADR-0012 copy-on-write read).
   */
  getRightPanel: (workspaceId: string, threadId?: string | null) => RightPanelState;
  /** Effective open/closed state for the panel scope ({@link getRightPanel}). */
  getRightPanelVisible: (workspaceId: string, threadId?: string | null) => boolean;
  /** Toggle the panel for a thread (per-thread) or the threadless shell (workspace). */
  toggleRightPanel: (workspaceId: string, threadId?: string | null) => void;
  /** Open the panel for a thread (per-thread) or the threadless shell (workspace). */
  showRightPanel: (workspaceId: string, threadId?: string | null) => void;
  /** Close the panel for a thread (per-thread) or the threadless shell (workspace). */
  hideRightPanel: (workspaceId: string, threadId?: string | null) => void;
  setRightPanelWidth: (
    workspaceId: string,
    threadId: string | null | undefined,
    width: number,
    source?: "auto" | "user" | "preserve",
  ) => void;
  setRightPanelTab: (workspaceId: string, threadId: string | null | undefined, tab: RightPanelTab) => void;
  /**
   * Close (remove) a singleton tab from the open set. When the closed tab was
   * active, focus falls back to the most-recently-opened remaining tab; with
   * none left the panel returns to the card-grid empty state. No-op when the tab
   * is not open. See ADR-0004.
   */
  closeRightPanelTab: (workspaceId: string, threadId: string | null | undefined, tab: RightPanelTab) => void;
  setViewMode: (mode: DiffViewMode) => void;
  /**
   * Resolve the Review view a thread should show: the user's sticky pick when
   * they have chosen one, otherwise the change-state default (re-evaluated live
   * from `changeState`). See ADR-0011.
   */
  getReviewView: (threadId: string, changeState: ReviewChangeState) => DiffViewMode;
  /**
   * Record a manual Review view pick for a thread: stores the view, sets the
   * sticky per-thread override, and makes it the rendered view. Stops live
   * auto-defaulting for that thread. See ADR-0011.
   */
  setReviewViewForThread: (threadId: string, mode: DiffViewMode) => void;
  /**
   * Apply a freshly resolved Branch comparison for a scope, recording the revision
   * it was resolved at and preserving the user's manually picked target when that
   * scope is flagged and the picked ref still exists.
   */
  resolveBranchComparison: (
    comparison: BranchComparison,
    key: string,
    revision: number,
  ) => void;
  /** Override the base ref of the active Branch comparison (no-op if none resolved). */
  setBranchBase: (ref: string) => void;
  /** Override the target ref of the active Branch comparison (no-op if none resolved). */
  setBranchTarget: (ref: string) => void;
  /** Set the Commit view's picked operand by SHA, or `null` to fall back to the latest commit. */
  setSelectedCommitSha: (sha: string | null) => void;
  setRenderMode: (mode: DiffRenderMode) => void;
  /** Report the active Review view's changed-file count (set by FileList). */
  setReviewFileCount: (count: number | null) => void;
  /** Report the active Review view's total added/removed lines (set by the view). */
  setReviewDiffStat: (stat: { additions: number; deletions: number } | null) => void;
  /** Expand or collapse every file card in the active Review view. */
  setBulkDiffExpand: (expand: boolean) => void;
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
  rightPanelByThread: {},
  rightPanelFallbackByWorkspace: {},
  viewMode: "last-turn",
  reviewViewByThread: {},
  reviewViewManuallySelectedByThread: {},
  branchComparison: null,
  branchComparisonKey: null,
  branchManuallySelectedByScope: {},
  branchResolvedRevisionByScope: {},
  selectedCommitSha: null,
  renderMode: "unified",
  reviewFileCount: null,
  reviewDiffStat: null,
  bulkDiffExpand: null,
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

  getRightPanel: (workspaceId, threadId) =>
    effectiveRightPanel(get(), workspaceId, threadId),

  getRightPanelVisible: (workspaceId, threadId) =>
    effectiveRightPanel(get(), workspaceId, threadId).visible,

  toggleRightPanel: (workspaceId, threadId) =>
    set((state) => setPanelVisible(state, workspaceId, threadId, undefined)),

  showRightPanel: (workspaceId, threadId) =>
    set((state) => setPanelVisible(state, workspaceId, threadId, true)),

  hideRightPanel: (workspaceId, threadId) =>
    set((state) => setPanelVisible(state, workspaceId, threadId, false)),

  setRightPanelWidth: (workspaceId, threadId, width, source = "user") =>
    set((state) => {
      const current = effectiveRightPanel(state, workspaceId, threadId);
      return writeRightPanel(state, workspaceId, threadId, {
        ...current,
        width: clampWidth(width),
        widthSource: source === "preserve" ? current.widthSource : source,
      });
    }),

  setRightPanelTab: (workspaceId, threadId, tab) =>
    set((state) => {
      const current = effectiveRightPanel(state, workspaceId, threadId);
      // Activating a tab opens it: tabs are singletons created on demand, so
      // focusing one that is not yet open adds it to the open set (the card grid
      // is the create surface). Already-open tabs are just refocused.
      const openTabs = current.openTabs.includes(tab)
        ? current.openTabs
        : [...current.openTabs, tab];
      return writeRightPanel(state, workspaceId, threadId, {
        ...current,
        openTabs,
        activeTab: tab,
      });
    }),

  closeRightPanelTab: (workspaceId, threadId, tab) =>
    set((state) => {
      const current = effectiveRightPanel(state, workspaceId, threadId);
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
      return writeRightPanel(state, workspaceId, threadId, {
        ...current,
        openTabs,
        activeTab,
      });
    }),

  setViewMode: (mode) =>
    set({ viewMode: mode, selectedFile: null, diffContent: null, selectedCommitSha: null }),
  getReviewView: (threadId, changeState) => {
    const state = get();
    if (state.reviewViewManuallySelectedByThread[threadId]) {
      return state.reviewViewByThread[threadId] ?? defaultReviewView("thread", changeState);
    }
    return defaultReviewView("thread", changeState);
  },
  setReviewViewForThread: (threadId, mode) =>
    set((s) => ({
      viewMode: mode,
      reviewViewByThread: { ...s.reviewViewByThread, [threadId]: mode },
      reviewViewManuallySelectedByThread: {
        ...s.reviewViewManuallySelectedByThread,
        [threadId]: true,
      },
      // Match setViewMode's resets so a fresh pick clears stale selection/operand.
      selectedFile: null,
      diffContent: null,
      selectedCommitSha: null,
    })),
  resolveBranchComparison: (comparison, key, revision) =>
    set((s) => {
      const sameScope = s.branchComparisonKey === key;
      const priorTarget = sameScope ? s.branchComparison?.target ?? null : null;
      // Preserve a manual pick across re-resolution, but only when the chosen ref
      // still exists in the freshly resolved set (a deleted branch must fall back).
      const keepTarget =
        s.branchManuallySelectedByScope[key] === true &&
        priorTarget !== null &&
        comparison.refs.some((ref) => ref.name === priorTarget);
      return {
        branchComparison: keepTarget
          ? { ...comparison, target: priorTarget }
          : comparison,
        branchComparisonKey: key,
        branchResolvedRevisionByScope: {
          ...s.branchResolvedRevisionByScope,
          [key]: revision,
        },
      };
    }),
  setBranchBase: (ref) =>
    set((s) =>
      s.branchComparison && s.branchComparisonKey
        ? {
            branchComparison: { ...s.branchComparison, base: ref },
            branchManuallySelectedByScope: {
              ...s.branchManuallySelectedByScope,
              [s.branchComparisonKey]: true,
            },
            // Changing an operand invalidates the selected file's diff.
            selectedFile: null,
            diffContent: null,
          }
        : {},
    ),
  setBranchTarget: (ref) =>
    set((s) =>
      s.branchComparison && s.branchComparisonKey
        ? {
            branchComparison: { ...s.branchComparison, target: ref },
            branchManuallySelectedByScope: {
              ...s.branchManuallySelectedByScope,
              [s.branchComparisonKey]: true,
            },
            selectedFile: null,
            diffContent: null,
          }
        : {},
    ),
  setSelectedCommitSha: (sha) => set({ selectedCommitSha: sha }),
  setRenderMode: (mode) => set({ renderMode: mode }),
  setReviewFileCount: (count) => set({ reviewFileCount: count }),
  setReviewDiffStat: (stat) => set({ reviewDiffStat: stat }),
  setBulkDiffExpand: (expand) =>
    set((s) => ({ bulkDiffExpand: { expand, nonce: (s.bulkDiffExpand?.nonce ?? 0) + 1 } })),
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
      const rightPanelByThread = { ...state.rightPanelByThread };
      delete rightPanelByThread[threadId];
      const reviewViewByThread = { ...state.reviewViewByThread };
      delete reviewViewByThread[threadId];
      const reviewViewManuallySelectedByThread = { ...state.reviewViewManuallySelectedByThread };
      delete reviewViewManuallySelectedByThread[threadId];
      const diffRevisionByScope = { ...state.diffRevisionByScope };
      delete diffRevisionByScope[threadId];
      const branchManuallySelectedByScope = omitByKeySuffix(
        state.branchManuallySelectedByScope,
        `:${threadId}`,
      );
      const branchResolvedRevisionByScope = omitByKeySuffix(
        state.branchResolvedRevisionByScope,
        `:${threadId}`,
      );

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
        rightPanelByThread,
        reviewViewByThread,
        reviewViewManuallySelectedByThread,
        diffRevisionByScope,
        branchManuallySelectedByScope,
        branchResolvedRevisionByScope,
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
      const hasBranchScope =
        Object.keys(state.branchManuallySelectedByScope).some((key) =>
          key.startsWith(cachePrefix),
        ) ||
        Object.keys(state.branchResolvedRevisionByScope).some((key) =>
          key.startsWith(cachePrefix),
        );
      if (
        !(workspaceId in state.rightPanelFallbackByWorkspace) &&
        !(workspaceId in state.diffRevisionByScope) &&
        !hasInlineDiffCache &&
        !hasBranchScope
      ) {
        return {};
      }
      const rightPanelFallbackByWorkspace = { ...state.rightPanelFallbackByWorkspace };
      delete rightPanelFallbackByWorkspace[workspaceId];
      const diffRevisionByScope = { ...state.diffRevisionByScope };
      delete diffRevisionByScope[workspaceId];
      return {
        rightPanelFallbackByWorkspace,
        diffRevisionByScope,
        branchManuallySelectedByScope: omitByKeyPrefix(
          state.branchManuallySelectedByScope,
          cachePrefix,
        ),
        branchResolvedRevisionByScope: omitByKeyPrefix(
          state.branchResolvedRevisionByScope,
          cachePrefix,
        ),
        inlineDiffCache: omitInlineDiffCacheByPrefix(state.inlineDiffCache, cachePrefix),
      };
    }),
}));
