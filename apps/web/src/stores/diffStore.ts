import { create } from "zustand";
import type { TurnSnapshot, GitCommit } from "@mcode/contracts";

export type { GitCommit };

/** Active tab in the right panel. */
export type RightPanelTab = "tasks" | "changes";

/** View mode within the Changes tab. */
export type DiffViewMode = "by-turn" | "all" | "commits";

/** Diff rendering mode. */
export type DiffRenderMode = "unified" | "side-by-side";

/** Minimum right panel width in pixels. */
export const PANEL_MIN_WIDTH = 300;
/** Default right panel width in pixels. */
export const PANEL_DEFAULT_WIDTH = 380;
/** Wide snap target for the right panel (double-click drag handle). */
export const PANEL_WIDE_WIDTH = 680;

function clampWidth(w: number): number {
  return Math.max(PANEL_MIN_WIDTH, w);
}

/** Currently selected file for diff viewing. */
export interface SelectedFile {
  source: "snapshot" | "cumulative" | "commit";
  /** Snapshot ID or commit SHA depending on source. */
  id: string;
  filePath: string;
  /** Thread that owns this selection, used to clear on thread deletion. */
  threadId: string;
}

/** Per-thread right panel state (visibility, width, active tab). */
export type RightPanelState = {
  readonly visible: boolean;
  readonly width: number;
  readonly activeTab: RightPanelTab;
};

/** Default state for threads with no panel record. Panels start closed. */
export const RIGHT_PANEL_DEFAULTS: RightPanelState = {
  visible: false,
  width: PANEL_DEFAULT_WIDTH,
  activeTab: "tasks",
} as const;

/** Zustand state shape for the diff panel. */
interface DiffState {
  /** Per-thread right panel state keyed by thread ID. */
  readonly rightPanelByThread: Record<string, RightPanelState>;
  /** View mode within the Changes tab. */
  viewMode: DiffViewMode;
  /** Diff rendering mode. */
  renderMode: DiffRenderMode;
  /** Whether long lines wrap instead of scrolling horizontally. */
  lineWrap: boolean;
  /** Turn snapshots keyed by thread ID. */
  snapshotsByThread: Record<string, TurnSnapshot[]>;
  /** Whether snapshots are currently loading, keyed by thread ID. */
  snapshotsLoadingByThread: Record<string, boolean>;
  /** Git commits keyed by thread ID. */
  commitsByThread: Record<string, GitCommit[]>;
  /** Whether commits are currently loading, keyed by thread ID. */
  commitsLoadingByThread: Record<string, boolean>;
  /** Currently selected file for diff viewing. */
  selectedFile: SelectedFile | null;
  /** Raw unified diff text for the selected file. */
  diffContent: string | null;
  /** Whether diff content is currently loading. */
  diffLoading: boolean;
  getRightPanel: (threadId: string) => RightPanelState;
  toggleRightPanel: (threadId: string) => void;
  showRightPanel: (threadId: string) => void;
  hideRightPanel: (threadId: string) => void;
  setRightPanelWidth: (threadId: string, width: number) => void;
  setRightPanelTab: (threadId: string, tab: RightPanelTab) => void;
  setViewMode: (mode: DiffViewMode) => void;
  setRenderMode: (mode: DiffRenderMode) => void;
  toggleLineWrap: () => void;
  setSnapshots: (threadId: string, snapshots: TurnSnapshot[]) => void;
  setSnapshotsLoading: (threadId: string, loading: boolean) => void;
  setCommits: (threadId: string, commits: GitCommit[]) => void;
  setCommitsLoading: (threadId: string, loading: boolean) => void;
  selectFile: (file: SelectedFile | null) => void;
  setDiffContent: (content: string | null) => void;
  setDiffLoading: (loading: boolean) => void;
  clearThread: (threadId: string) => void;
}

/** Zustand store for diff panel and right panel tab state. */
export const useDiffStore = create<DiffState>((set, get) => ({
  rightPanelByThread: {},
  viewMode: "by-turn",
  renderMode: "unified",
  lineWrap: false,
  snapshotsByThread: {},
  snapshotsLoadingByThread: {},
  commitsByThread: {},
  commitsLoadingByThread: {},
  selectedFile: null,
  diffContent: null,
  diffLoading: false,

  getRightPanel: (threadId) =>
    get().rightPanelByThread[threadId] ?? RIGHT_PANEL_DEFAULTS,

  toggleRightPanel: (threadId) =>
    set((state) => {
      const current = state.rightPanelByThread[threadId] ?? RIGHT_PANEL_DEFAULTS;
      return {
        rightPanelByThread: {
          ...state.rightPanelByThread,
          [threadId]: { ...current, visible: !current.visible },
        },
      };
    }),

  showRightPanel: (threadId) =>
    set((state) => {
      const current = state.rightPanelByThread[threadId] ?? RIGHT_PANEL_DEFAULTS;
      return {
        rightPanelByThread: {
          ...state.rightPanelByThread,
          [threadId]: { ...current, visible: true },
        },
      };
    }),

  hideRightPanel: (threadId) =>
    set((state) => {
      const current = state.rightPanelByThread[threadId] ?? RIGHT_PANEL_DEFAULTS;
      return {
        rightPanelByThread: {
          ...state.rightPanelByThread,
          [threadId]: { ...current, visible: false },
        },
      };
    }),

  setRightPanelWidth: (threadId, width) =>
    set((state) => {
      const current = state.rightPanelByThread[threadId] ?? RIGHT_PANEL_DEFAULTS;
      return {
        rightPanelByThread: {
          ...state.rightPanelByThread,
          [threadId]: { ...current, width: clampWidth(width) },
        },
      };
    }),

  setRightPanelTab: (threadId, tab) =>
    set((state) => {
      const current = state.rightPanelByThread[threadId] ?? RIGHT_PANEL_DEFAULTS;
      return {
        rightPanelByThread: {
          ...state.rightPanelByThread,
          [threadId]: { ...current, activeTab: tab },
        },
      };
    }),

  setViewMode: (mode) => set({ viewMode: mode, selectedFile: null, diffContent: null }),
  setRenderMode: (mode) => set({ renderMode: mode }),
  toggleLineWrap: () => set((s) => ({ lineWrap: !s.lineWrap })),
  setSnapshots: (threadId, snapshots) =>
    set((s) => ({ snapshotsByThread: { ...s.snapshotsByThread, [threadId]: snapshots } })),
  setSnapshotsLoading: (threadId, loading) =>
    set((s) => ({ snapshotsLoadingByThread: { ...s.snapshotsLoadingByThread, [threadId]: loading } })),
  setCommits: (threadId, commits) =>
    set((s) => ({ commitsByThread: { ...s.commitsByThread, [threadId]: commits } })),
  setCommitsLoading: (threadId, loading) =>
    set((s) => ({ commitsLoadingByThread: { ...s.commitsLoadingByThread, [threadId]: loading } })),
  selectFile: (file) => set({ selectedFile: file, diffContent: null, diffLoading: false }),
  setDiffContent: (content) => set({ diffContent: content, diffLoading: false }),
  setDiffLoading: (loading) => set({ diffLoading: loading }),
  clearThread: (threadId) =>
    set((state) => {
      const snapshots = { ...state.snapshotsByThread };
      delete snapshots[threadId];
      const snapshotsLoading = { ...state.snapshotsLoadingByThread };
      delete snapshotsLoading[threadId];
      const commits = { ...state.commitsByThread };
      delete commits[threadId];
      const commitsLoading = { ...state.commitsLoadingByThread };
      delete commitsLoading[threadId];
      const rightPanels = { ...state.rightPanelByThread };
      delete rightPanels[threadId];

      // Only clear the global selection when it belongs to the deleted thread.
      const selectionBelongsToThread = state.selectedFile?.threadId === threadId;

      return {
        snapshotsByThread: snapshots,
        snapshotsLoadingByThread: snapshotsLoading,
        commitsByThread: commits,
        commitsLoadingByThread: commitsLoading,
        rightPanelByThread: rightPanels,
        ...(selectionBelongsToThread
          ? { selectedFile: null, diffContent: null, diffLoading: false }
          : {}),
      };
    }),
}));
