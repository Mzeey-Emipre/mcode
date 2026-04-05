import { create } from "zustand";
import type { TurnSnapshot } from "@mcode/contracts";

/** Git commit metadata returned by the git.log RPC. */
export interface GitCommit {
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  date: string;
  filesChanged: number;
}

/** Active tab in the right panel. */
export type RightPanelTab = "tasks" | "changes";

/** View mode within the Changes tab. */
export type DiffViewMode = "by-turn" | "all" | "commits";

/** Diff rendering mode. */
export type DiffRenderMode = "unified" | "side-by-side";

/** Currently selected file for diff viewing. */
export interface SelectedFile {
  source: "snapshot" | "cumulative" | "commit";
  /** Snapshot ID or commit SHA depending on source. */
  id: string;
  filePath: string;
}

/** Zustand state shape for the diff panel. */
interface DiffState {
  /** Whether the right panel is visible. */
  panelVisible: boolean;
  /** Active tab in the right panel. */
  activeTab: RightPanelTab;
  /** Width of the right panel in pixels. */
  panelWidth: number;
  /** View mode within the Changes tab. */
  viewMode: DiffViewMode;
  /** Diff rendering mode. */
  renderMode: DiffRenderMode;
  /** Turn snapshots keyed by thread ID. */
  snapshotsByThread: Record<string, TurnSnapshot[]>;
  /** Whether snapshots are currently loading. */
  snapshotsLoading: boolean;
  /** Git commits keyed by thread ID. */
  commitsByThread: Record<string, GitCommit[]>;
  /** Whether commits are currently loading. */
  commitsLoading: boolean;
  /** Currently selected file for diff viewing. */
  selectedFile: SelectedFile | null;
  /** Raw unified diff text for the selected file. */
  diffContent: string | null;
  /** Whether diff content is currently loading. */
  diffLoading: boolean;

  togglePanel: () => void;
  showPanel: () => void;
  hidePanel: () => void;
  setPanelWidth: (width: number) => void;
  setActiveTab: (tab: RightPanelTab) => void;
  setViewMode: (mode: DiffViewMode) => void;
  setRenderMode: (mode: DiffRenderMode) => void;
  setSnapshots: (threadId: string, snapshots: TurnSnapshot[]) => void;
  appendSnapshot: (threadId: string, snapshot: TurnSnapshot) => void;
  setSnapshotsLoading: (loading: boolean) => void;
  setCommits: (threadId: string, commits: GitCommit[]) => void;
  setCommitsLoading: (loading: boolean) => void;
  selectFile: (file: SelectedFile | null) => void;
  setDiffContent: (content: string | null) => void;
  setDiffLoading: (loading: boolean) => void;
  clearThread: (threadId: string) => void;
}

/** Minimum right panel width in pixels. */
export const PANEL_MIN_WIDTH = 280;
/** Maximum right panel width in pixels. */
export const PANEL_MAX_WIDTH = 600;
const DEFAULT_WIDTH = 320;

function clampWidth(w: number): number {
  return Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, w));
}

/** Zustand store for diff panel and right panel tab state. */
export const useDiffStore = create<DiffState>((set) => ({
  panelVisible: false,
  activeTab: "tasks",
  panelWidth: DEFAULT_WIDTH,
  viewMode: "by-turn",
  renderMode: "unified",
  snapshotsByThread: {},
  snapshotsLoading: false,
  commitsByThread: {},
  commitsLoading: false,
  selectedFile: null,
  diffContent: null,
  diffLoading: false,

  togglePanel: () => set((s) => ({ panelVisible: !s.panelVisible })),
  showPanel: () => set({ panelVisible: true }),
  hidePanel: () => set({ panelVisible: false }),
  setPanelWidth: (width) => set({ panelWidth: clampWidth(width) }),
  setActiveTab: (tab) => set({ activeTab: tab }),
  setViewMode: (mode) => set({ viewMode: mode, selectedFile: null, diffContent: null }),
  setRenderMode: (mode) => set({ renderMode: mode }),
  setSnapshots: (threadId, snapshots) =>
    set((s) => ({ snapshotsByThread: { ...s.snapshotsByThread, [threadId]: snapshots } })),
  appendSnapshot: (threadId, snapshot) =>
    set((s) => {
      const existing = s.snapshotsByThread[threadId] ?? [];
      return { snapshotsByThread: { ...s.snapshotsByThread, [threadId]: [...existing, snapshot] } };
    }),
  setSnapshotsLoading: (loading) => set({ snapshotsLoading: loading }),
  setCommits: (threadId, commits) =>
    set((s) => ({ commitsByThread: { ...s.commitsByThread, [threadId]: commits } })),
  setCommitsLoading: (loading) => set({ commitsLoading: loading }),
  selectFile: (file) => set({ selectedFile: file, diffContent: null, diffLoading: false }),
  setDiffContent: (content) => set({ diffContent: content, diffLoading: false }),
  setDiffLoading: (loading) => set({ diffLoading: loading }),
  clearThread: (threadId) =>
    set((s) => {
      const nextSnapshots = { ...s.snapshotsByThread };
      delete nextSnapshots[threadId];
      const nextCommits = { ...s.commitsByThread };
      delete nextCommits[threadId];
      return { snapshotsByThread: nextSnapshots, commitsByThread: nextCommits, selectedFile: null, diffContent: null };
    }),
}));
