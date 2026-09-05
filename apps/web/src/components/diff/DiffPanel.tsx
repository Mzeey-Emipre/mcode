import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { ReviewComparison, ReviewFileChange } from "@mcode/contracts";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { projectRightPanelForScope, useDiffStore } from "@/stores/diffStore";
import { getTransport } from "@/transport";
import { DiffToolbar } from "./DiffToolbar";
import { LastTurnView } from "./LastTurnView";
import { CumulativeView } from "./CumulativeView";
import { GitDiffView, type GitView, type ResolvedGitComparison } from "./GitDiffView";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useElementWidth } from "@/hooks/useElementWidth";
import { WorktreeFilesPane } from "./WorktreeFilesPane";
import { cumulativeReviewFiles } from "@/lib/review-comparison";

const FILES_PANEL_MIN_WIDTH = 280;
const FILES_PANEL_DEFAULT_WIDTH = 320;
const FILES_PANEL_WIDE_WIDTH = 480;
const DIFF_VIEWPORT_MIN_WIDTH = 520;
const DOCKED_FILES_MIN_WIDTH = FILES_PANEL_MIN_WIDTH + DIFF_VIEWPORT_MIN_WIDTH;
const FLOATING_FILES_PANEL_EDGE_GAP = 48;
const FLOATING_FILES_PANEL_FLOOR = 220;

/** The threadless git working-tree view ids. */
const GIT_VIEWS: readonly GitView[] = ["unstaged", "staged", "commit", "branch"];
type DiffStoreState = ReturnType<typeof useDiffStore.getState>;
type DiffViewMode = DiffStoreState["viewMode"];
type Snapshot = NonNullable<DiffStoreState["snapshotsByThread"][string]>[number];

interface SettledComparison {
  readonly identity: string;
  readonly comparison: ReviewComparison;
  readonly git: ResolvedGitComparison | null;
  readonly cacheVersion: string | number;
  readonly turnCount: number;
  readonly liveRevision?: number;
}

interface ComparisonLoadInput {
  readonly activeThreadId: string | null;
  readonly activeWorkspaceId: string | null;
  readonly branchComparison: DiffStoreState["branchComparison"];
  readonly branchRange: { readonly base: string; readonly target: string } | null;
  readonly mutableComparisonRevision: number;
  readonly selectedCommitSha: string | null;
  readonly snapshotVersion: string;
  readonly snapshots: readonly Snapshot[] | undefined;
  readonly viewMode: DiffViewMode;
}

type LoadedComparison = Omit<SettledComparison, "identity">;

/** Type guard: whether a view mode is one of the threadless git working-tree views. */
function isGitView(mode: string): mode is GitView {
  return (GIT_VIEWS as readonly string[]).includes(mode);
}

function canLoadComparison(input: ComparisonLoadInput, snapshotsLoading: boolean): boolean {
  if (!input.activeWorkspaceId) return false;
  if (!isGitView(input.viewMode) && (!input.activeThreadId || !input.snapshots || snapshotsLoading)) {
    return false;
  }
  return !isUnavailableBranchComparison(input);
}

function isUnavailableBranchComparison(input: ComparisonLoadInput): boolean {
  return input.viewMode === "branch" &&
    !input.branchComparison?.isUnborn &&
    input.branchComparison?.isComparisonAvailable !== false &&
    !input.branchRange;
}

async function loadComparison(input: ComparisonLoadInput): Promise<LoadedComparison> {
  if (isGitView(input.viewMode)) return loadGitComparison({ ...input, viewMode: input.viewMode });
  if (input.viewMode === "cumulative") return loadCumulativeComparison(input);
  return loadLastTurnComparison(input);
}

async function loadGitComparison(
  input: ComparisonLoadInput & { readonly viewMode: GitView },
): Promise<LoadedComparison> {
  const metadata = getGitComparisonMetadata(input);
  const comparison = metadata.empty
    ? emptyComparison()
    : await getTransport().getReviewComparison({
        workspaceId: input.activeWorkspaceId!,
        view: input.viewMode,
        threadId: input.activeThreadId ?? undefined,
        sha: input.viewMode === "commit" ? input.selectedCommitSha ?? undefined : undefined,
        base: input.viewMode === "branch" ? input.branchRange?.base : undefined,
        target: input.viewMode === "branch" ? input.branchRange?.target : undefined,
      });
  return {
    comparison,
    git: {
      comparison,
      source: metadata.source,
      id: metadata.id,
      cacheVersion: input.mutableComparisonRevision,
    },
    cacheVersion: input.mutableComparisonRevision,
    turnCount: 0,
  };
}

function getGitComparisonMetadata(
  input: ComparisonLoadInput & { readonly viewMode: GitView },
): { readonly empty: boolean; readonly id: string; readonly source: ResolvedGitComparison["source"] } {
  if (input.viewMode === "commit" && !input.selectedCommitSha) {
    return { empty: true, source: "commit", id: input.activeWorkspaceId! };
  }
  if (isEmptyBranchComparison(input)) {
    return { empty: true, source: "branch", id: "branch-empty" };
  }
  return {
    empty: false,
    source: input.viewMode,
    id: getGitComparisonId(input),
  };
}

function isEmptyBranchComparison(input: ComparisonLoadInput): boolean {
  return input.viewMode === "branch" &&
    (input.branchComparison?.isUnborn ||
      input.branchComparison?.isComparisonAvailable === false ||
      !input.branchRange);
}

function getGitComparisonId(input: ComparisonLoadInput & { readonly viewMode: GitView }): string {
  if (input.viewMode === "commit") return input.selectedCommitSha!;
  if (input.viewMode === "branch") return `${input.branchRange!.base}...${input.branchRange!.target}`;
  return input.activeWorkspaceId!;
}

async function loadCumulativeComparison(input: ComparisonLoadInput): Promise<LoadedComparison> {
  const stats = await getTransport().getCumulativeDiffStats(input.activeThreadId!);
  return {
    comparison: {
      files: cumulativeReviewFiles(input.snapshots ?? [], stats.map((entry) => entry.filePath)),
      additions: sumReviewFileAdditions(stats),
      deletions: sumReviewFileDeletions(stats),
    },
    git: null,
    cacheVersion: input.snapshotVersion,
    turnCount: input.snapshots?.length ?? 0,
  };
}

async function loadLastTurnComparison(input: ComparisonLoadInput): Promise<LoadedComparison> {
  const comparison = await getTransport().getTurnDiffComparison(input.activeThreadId!);
  return {
    comparison: comparison ?? emptyComparison(),
    git: null,
    cacheVersion: comparison?.turnDiff?.id ?? input.mutableComparisonRevision,
    liveRevision: input.mutableComparisonRevision,
    turnCount: input.snapshots?.length ?? 0,
  };
}

function emptyComparison(): ReviewComparison {
  return { files: [], additions: 0, deletions: 0 };
}

function sumReviewFileAdditions(stats: readonly { readonly additions: number }[]): number {
  return stats.reduce((total, entry) => total + entry.additions, 0);
}

function sumReviewFileDeletions(stats: readonly { readonly deletions: number }[]): number {
  return stats.reduce((total, entry) => total + entry.deletions, 0);
}

interface DiffPanelStore {
  readonly activeThreadId: string | null;
  readonly activeWorkspaceId: string | null;
  readonly branchComparison: DiffStoreState["branchComparison"];
  readonly bumpDiffRevision: DiffStoreState["bumpDiffRevision"];
  readonly diffRevision: number;
  readonly diffScopeId: string | null;
  readonly filesVisible: boolean;
  readonly panelState: ReturnType<typeof projectRightPanelForScope>;
  readonly panelVisible: boolean;
  readonly requestReviewFileJump: DiffStoreState["requestReviewFileJump"];
  readonly selectedCommitSha: DiffStoreState["selectedCommitSha"];
  readonly setReviewDiffStat: DiffStoreState["setReviewDiffStat"];
  readonly setReviewFilesVisible: DiffStoreState["setReviewFilesVisible"];
  readonly setSnapshots: DiffStoreState["setSnapshots"];
  readonly setSnapshotsLoading: DiffStoreState["setSnapshotsLoading"];
  readonly snapshots: DiffStoreState["snapshotsByThread"][string] | undefined;
  readonly snapshotsLoading: boolean;
  readonly snapshotsPending: boolean;
  readonly subagentScope: DiffStoreState["subagentReviewScopeByThread"][string] | undefined;
  readonly viewMode: DiffViewMode;
}

function useDiffPanelStore(): DiffPanelStore {
  const activeThreadId = useWorkspaceStore((state) => state.activeThreadId);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const viewMode = useDiffStore((state) => state.viewMode);
  const subagentScope = useDiffStore((state) =>
    activeThreadId ? state.subagentReviewScopeByThread[activeThreadId] : undefined,
  );
  const snapshots = useDiffStore((state) =>
    activeThreadId ? state.snapshotsByThread[activeThreadId] : undefined,
  );
  const snapshotsLoading = useDiffStore((state) =>
    activeThreadId ? (state.snapshotsLoadingByThread[activeThreadId] ?? false) : false,
  );
  const snapshotsPending = useDiffStore((state) =>
    activeThreadId ? (state.snapshotsPendingByThread[activeThreadId] ?? false) : false,
  );
  const ownedPanel = useDiffStore((state) =>
    activeWorkspaceId && activeThreadId
      ? state.rightPanelByThread[activeThreadId]
      : undefined,
  );
  const fallbackPanel = useDiffStore((state) =>
    activeWorkspaceId ? state.rightPanelFallbackByWorkspace[activeWorkspaceId] : undefined,
  );
  const panelState = useMemo(
    () => projectRightPanelForScope(ownedPanel, fallbackPanel, activeThreadId),
    [activeThreadId, fallbackPanel, ownedPanel],
  );
  const panelVisible = useDiffStore((state) =>
    activeWorkspaceId ? state.getRightPanelVisible(activeWorkspaceId, activeThreadId) : false,
  );
  const diffScopeId = activeThreadId ?? activeWorkspaceId;
  const filesVisible = useDiffStore((state) =>
    diffScopeId ? (state.reviewFilesVisibleByScope[diffScopeId] ?? false) : false,
  );
  const diffRevision = useDiffStore((state) =>
    diffScopeId ? (state.diffRevisionByScope[diffScopeId] ?? 0) : 0,
  );

  return {
    activeThreadId,
    activeWorkspaceId,
    branchComparison: useDiffStore((state) => state.branchComparison),
    bumpDiffRevision: useDiffStore((state) => state.bumpDiffRevision),
    diffRevision,
    diffScopeId,
    filesVisible,
    panelState,
    panelVisible,
    requestReviewFileJump: useDiffStore((state) => state.requestReviewFileJump),
    selectedCommitSha: useDiffStore((state) => state.selectedCommitSha),
    setReviewDiffStat: useDiffStore((state) => state.setReviewDiffStat),
    setReviewFilesVisible: useDiffStore((state) => state.setReviewFilesVisible),
    setSnapshots: useDiffStore((state) => state.setSnapshots),
    setSnapshotsLoading: useDiffStore((state) => state.setSnapshotsLoading),
    snapshots,
    snapshotsLoading,
    snapshotsPending,
    subagentScope,
    viewMode,
  };
}

interface FilesPanelController {
  readonly activeWorktreePath: string | null;
  readonly filesDocked: boolean;
  readonly filesPanelWidth: number;
  readonly floatingFilesPanelMaxWidth: number;
  readonly floatingFilesPanelMinWidth: number;
  readonly getFilesPanelMaxWidth: (panel: HTMLDivElement | null) => number;
  readonly getFloatingFilesPanelMaxWidth: (panel: HTMLDivElement | null) => number;
  readonly setActiveWorktreePath: (path: string | null) => void;
  readonly setFilesPanelWidth: (width: number) => void;
  readonly setFilesVisible: (visible: boolean) => void;
}

function useFilesPanelController({
  diffScopeId,
  panelRootRef,
  setReviewFilesVisible,
  viewMode,
}: {
  readonly diffScopeId: string | null;
  readonly panelRootRef: RefObject<HTMLDivElement | null>;
  readonly setReviewFilesVisible: DiffStoreState["setReviewFilesVisible"];
  readonly viewMode: DiffViewMode;
}): FilesPanelController {
  const panelWidth = useElementWidth(panelRootRef, diffScopeId ?? undefined);
  const [filesPanelWidth, setFilesPanelWidth] = useState(FILES_PANEL_DEFAULT_WIDTH);
  const filesScopeKey = `${viewMode}:${diffScopeId ?? ""}`;
  const [activeWorktreeFile, setActiveWorktreeFile] = useState<{
    readonly path: string | null;
    readonly scopeKey: string;
  } | null>(null);
  const activeWorktreePath = activeWorktreeFile?.scopeKey === filesScopeKey
    ? activeWorktreeFile.path
    : null;
  const floatingFilesPanelMaxWidth = getInitialFloatingFilesPanelMaxWidth(panelWidth);
  const floatingFilesPanelMinWidth = Math.min(FILES_PANEL_MIN_WIDTH, floatingFilesPanelMaxWidth);
  const setFilesVisible = useCallback((visible: boolean) => {
    if (!diffScopeId) return;
    setReviewFilesVisible(diffScopeId, visible);
  }, [diffScopeId, setReviewFilesVisible]);
  const getFilesPanelMaxWidth = useCallback(
    (panel: HTMLDivElement | null): number => Math.max(
      FILES_PANEL_MIN_WIDTH,
      (panel?.parentElement?.clientWidth ?? window.innerWidth) - DIFF_VIEWPORT_MIN_WIDTH,
    ),
    [],
  );
  const getFloatingFilesPanelMaxWidth = useCallback(
    (panel: HTMLDivElement | null): number => Math.max(
      floatingFilesPanelMinWidth,
      (panel?.parentElement?.clientWidth ?? window.innerWidth) - FLOATING_FILES_PANEL_EDGE_GAP,
    ),
    [floatingFilesPanelMinWidth],
  );

  const setActiveWorktreePath = useCallback((path: string | null) => {
    setActiveWorktreeFile({ path, scopeKey: filesScopeKey });
  }, [filesScopeKey]);

  return {
    activeWorktreePath,
    filesDocked: panelWidth >= DOCKED_FILES_MIN_WIDTH,
    filesPanelWidth,
    floatingFilesPanelMaxWidth,
    floatingFilesPanelMinWidth,
    getFilesPanelMaxWidth,
    getFloatingFilesPanelMaxWidth,
    setActiveWorktreePath,
    setFilesPanelWidth,
    setFilesVisible,
  };
}

function getInitialFloatingFilesPanelMaxWidth(panelWidth: number): number {
  if (panelWidth <= 0) return FILES_PANEL_DEFAULT_WIDTH;
  return Math.max(FLOATING_FILES_PANEL_FLOOR, panelWidth - FLOATING_FILES_PANEL_EDGE_GAP);
}

interface ComparisonController {
  readonly comparisonErrorIdentity: string | null;
  readonly comparisonFiles: readonly ReviewFileChange[];
  readonly comparisonIdentity: string;
  readonly comparisonLoading: boolean;
  readonly comparisonPending: boolean;
  readonly onRefreshComparison: () => void;
  readonly scopedCumulative: boolean;
  readonly visibleComparison: ReviewComparison | null;
  readonly visibleSettled: SettledComparison | null;
}

function useComparisonController(store: DiffPanelStore): ComparisonController {
  const [settled, setSettled] = useState<SettledComparison | null>(null);
  const [comparisonLoading, setComparisonLoading] = useState(false);
  const [comparisonErrorIdentity, setComparisonErrorIdentity] = useState<string | null>(null);
  const [snapshotRefreshRevision, setSnapshotRefreshRevision] = useState(0);
  const {
    activeThreadId,
    bumpDiffRevision,
    diffScopeId,
    setReviewDiffStat,
    setSnapshots,
    snapshotsLoading,
    viewMode,
  } = store;
  const comparisonIdentityRef = useRef("");
  const refreshRequestRef = useRef(0);
  const mutableComparisonRevision = getMutableComparisonRevision(store.viewMode, store.diffRevision);
  const branchRange = useMemo(
    () => getBranchRange(store.branchComparison),
    [store.branchComparison],
  );
  const comparisonIdentity = getComparisonIdentity(
    store.diffScopeId,
    store.viewMode,
    store.selectedCommitSha,
    branchRange,
  );
  const snapshotVersion = getSnapshotVersion(store.snapshots);
  const comparisonLoadInput = useMemo<ComparisonLoadInput>(() => ({
    activeThreadId: store.activeThreadId,
    activeWorkspaceId: store.activeWorkspaceId,
    branchComparison: store.branchComparison,
    branchRange,
    mutableComparisonRevision,
    selectedCommitSha: store.selectedCommitSha,
    snapshotVersion,
    snapshots: store.snapshots,
    viewMode: store.viewMode,
  }), [
    branchRange,
    mutableComparisonRevision,
    snapshotVersion,
    store.activeThreadId,
    store.activeWorkspaceId,
    store.branchComparison,
    store.selectedCommitSha,
    store.snapshots,
    store.viewMode,
  ]);
  const currentSettled = settled?.comparison.turnDiff?.phase === "live" && settled.liveRevision !== mutableComparisonRevision ? null : settled;
  const visibleSettled = getVisibleSettledComparison(currentSettled, comparisonIdentity);
  const visibleComparison = useMemo(
    () => projectVisibleComparison(visibleSettled, store.subagentScope, store.viewMode),
    [store.subagentScope, store.viewMode, visibleSettled],
  );
  const comparisonFiles = visibleComparison?.files ?? [];
  const scopedCumulative = isScopedCumulative(store.viewMode, store.subagentScope);

  comparisonIdentityRef.current = comparisonIdentity;

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- The toolbar-owned store must synchronize with the comparison rendered by this panel.
    setReviewDiffStat(toReviewDiffStat(visibleComparison));
  }, [setReviewDiffStat, visibleComparison]);

  useEffect(() => {
    if (!diffScopeId || !canLoadComparison(comparisonLoadInput, snapshotsLoading)) return;

    let cancelled = false;
    // oxlint-disable-next-line react/set-state-in-effect -- A comparison request synchronizes pending UI state with the external transport lifecycle.
    setComparisonLoading(true);
    setComparisonErrorIdentity(null);
    void loadComparison(comparisonLoadInput).then((next) => {
      if (cancelled) return;
      setSettled({ identity: comparisonIdentity, ...next });
      setComparisonLoading(false);
    }).catch(() => {
      if (!cancelled) {
        setComparisonErrorIdentity(comparisonIdentity);
        setComparisonLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [
    comparisonIdentity,
    comparisonLoadInput,
    diffScopeId,
    snapshotRefreshRevision,
    snapshotsLoading,
  ]);

  const onRefreshComparison = useCallback(() => {
    if (cannotRefreshComparison(diffScopeId, comparisonLoading, viewMode)) return;
    if (isGitView(viewMode)) {
      bumpDiffRevision(diffScopeId!);
      return;
    }
    if (!activeThreadId) return;
    refreshSnapshots({
      activeThreadId,
      comparisonIdentity,
      comparisonIdentityRef,
      refreshRequestRef,
      setComparisonLoading,
      setSnapshotRefreshRevision,
      setSnapshots,
    });
  }, [
    activeThreadId,
    bumpDiffRevision,
    comparisonIdentity,
    comparisonLoading,
    diffScopeId,
    setSnapshots,
    viewMode,
  ]);

  useEffect(() => () => {
    refreshRequestRef.current += 1;
  }, []);

  useInitialSnapshots(store.activeThreadId, store.snapshots, store.setSnapshots, store.setSnapshotsLoading);
  usePendingSnapshotRefresh(
    store.activeThreadId,
    store.panelState,
    store.panelVisible,
    store.setSnapshots,
    store.snapshotsPending,
    store.viewMode,
  );

  return {
    comparisonErrorIdentity,
    comparisonFiles,
    comparisonIdentity,
    comparisonLoading,
    comparisonPending: isComparisonPending(
      store.snapshotsLoading,
      comparisonLoading,
      visibleSettled,
      comparisonErrorIdentity,
      comparisonIdentity,
    ),
    onRefreshComparison,
    scopedCumulative,
    visibleComparison,
    visibleSettled,
  };
}

function getMutableComparisonRevision(viewMode: DiffViewMode, diffRevision: number): number {
  return viewMode === "last-turn" || (isGitView(viewMode) && viewMode !== "commit") ? diffRevision : 0;
}

function getBranchRange(
  branchComparison: DiffStoreState["branchComparison"],
): { readonly base: string; readonly target: string } | null {
  if (!branchComparison?.base || !branchComparison.target) return null;
  return { base: branchComparison.target, target: branchComparison.base };
}

function getComparisonIdentity(
  diffScopeId: string | null,
  viewMode: DiffViewMode,
  selectedCommitSha: string | null,
  branchRange: { readonly base: string; readonly target: string } | null,
): string {
  const commitIdentity = viewMode === "commit" ? (selectedCommitSha ?? "") : "";
  const branchIdentity = viewMode === "branch"
    ? `${branchRange?.base ?? ""}...${branchRange?.target ?? ""}`
    : "";
  return `${diffScopeId ?? "none"}:${viewMode}:${commitIdentity}:${branchIdentity}`;
}

function getSnapshotVersion(snapshots: readonly Snapshot[] | undefined): string {
  return (snapshots ?? []).map((snapshot) => `${snapshot.id}:${snapshot.ref_after}`).join("|");
}

function getVisibleSettledComparison(
  settled: SettledComparison | null,
  comparisonIdentity: string,
): SettledComparison | null {
  return settled?.identity === comparisonIdentity ? settled : null;
}

function projectVisibleComparison(
  settled: SettledComparison | null,
  subagentScope: DiffPanelStore["subagentScope"],
  viewMode: DiffViewMode,
): ReviewComparison | null {
  const comparison = settled?.comparison ?? null;
  if (!subagentScope || viewMode !== "cumulative") return comparison;
  const settledFilesByPath = new Map(comparison?.files.map((file) => [file.path, file]));
  return {
    files: subagentScope.paths.map(
      (path): ReviewFileChange => settledFilesByPath.get(path) ?? {
        path,
        previousPath: null,
        changeType: "modified",
        binary: false,
      },
    ),
    additions: subagentScope.additions,
    deletions: subagentScope.deletions,
  };
}

function isScopedCumulative(
  viewMode: DiffViewMode,
  subagentScope: DiffPanelStore["subagentScope"],
): boolean {
  return viewMode === "cumulative" && subagentScope !== undefined;
}

function toReviewDiffStat(comparison: ReviewComparison | null): DiffStoreState["reviewDiffStat"] {
  if (!comparison) return null;
  return { additions: comparison.additions, deletions: comparison.deletions };
}

function isComparisonPending(
  snapshotsLoading: boolean,
  comparisonLoading: boolean,
  visibleSettled: SettledComparison | null,
  comparisonErrorIdentity: string | null,
  comparisonIdentity: string,
): boolean {
  return snapshotsLoading ||
    comparisonLoading ||
    (!visibleSettled && comparisonErrorIdentity !== comparisonIdentity);
}

function cannotRefreshComparison(
  diffScopeId: string | null,
  comparisonLoading: boolean,
  viewMode: DiffViewMode,
): boolean {
  return !diffScopeId || comparisonLoading || viewMode === "commit";
}

function refreshSnapshots({
  activeThreadId,
  comparisonIdentity,
  comparisonIdentityRef,
  refreshRequestRef,
  setComparisonLoading,
  setSnapshotRefreshRevision,
  setSnapshots,
}: {
  readonly activeThreadId: string;
  readonly comparisonIdentity: string;
  readonly comparisonIdentityRef: RefObject<string>;
  readonly refreshRequestRef: RefObject<number>;
  readonly setComparisonLoading: (loading: boolean) => void;
  readonly setSnapshotRefreshRevision: (update: (current: number) => number) => void;
  readonly setSnapshots: DiffStoreState["setSnapshots"];
}): void {
  const requestId = ++refreshRequestRef.current;
  setComparisonLoading(true);
  getTransport().listSnapshots(activeThreadId).then((snapshots) => {
    if (!isCurrentRefreshRequest(refreshRequestRef, comparisonIdentityRef, requestId, comparisonIdentity)) return;
    setSnapshots(activeThreadId, snapshots);
    setSnapshotRefreshRevision((revision) => revision + 1);
  }).catch(() => {
    if (isCurrentRefreshRequest(refreshRequestRef, comparisonIdentityRef, requestId, comparisonIdentity)) {
      setComparisonLoading(false);
    }
  });
}

function isCurrentRefreshRequest(
  refreshRequestRef: RefObject<number>,
  comparisonIdentityRef: RefObject<string>,
  requestId: number,
  comparisonIdentity: string,
): boolean {
  return refreshRequestRef.current === requestId && comparisonIdentityRef.current === comparisonIdentity;
}

function useInitialSnapshots(
  activeThreadId: string | null,
  snapshots: DiffPanelStore["snapshots"],
  setSnapshots: DiffStoreState["setSnapshots"],
  setSnapshotsLoading: DiffStoreState["setSnapshotsLoading"],
): void {
  useEffect(() => {
    if (!activeThreadId || snapshots !== undefined) return;

    let cancelled = false;
    setSnapshotsLoading(activeThreadId, true);
    void getTransport().listSnapshots(activeThreadId).then((result) => {
      if (!cancelled) setSnapshots(activeThreadId, result);
    }).catch(() => {
      if (!cancelled) setSnapshots(activeThreadId, []);
    });
    return () => { cancelled = true; };
  }, [activeThreadId, setSnapshots, setSnapshotsLoading, snapshots]);
}

function usePendingSnapshotRefresh(
  activeThreadId: string | null,
  panelState: DiffPanelStore["panelState"],
  panelVisible: boolean,
  setSnapshots: DiffStoreState["setSnapshots"],
  snapshotsPending: boolean,
  viewMode: DiffViewMode,
): void {
  useEffect(() => {
    if (!shouldRefreshPendingSnapshots(activeThreadId, snapshotsPending, panelVisible, panelState, viewMode)) {
      return;
    }
    let cancelled = false;
    void getTransport().listSnapshots(activeThreadId!).then((result) => {
      if (!cancelled) setSnapshots(activeThreadId!, result);
    }).catch(() => { /* non-critical */ });
    return () => { cancelled = true; };
  }, [activeThreadId, panelState, panelVisible, setSnapshots, snapshotsPending, viewMode]);
}

function shouldRefreshPendingSnapshots(
  activeThreadId: string | null,
  snapshotsPending: boolean,
  panelVisible: boolean,
  panelState: DiffPanelStore["panelState"],
  viewMode: DiffViewMode,
): boolean {
  return Boolean(activeThreadId &&
    snapshotsPending &&
    !(panelVisible && panelState.activeTab === "changes" && viewMode === "cumulative"));
}

/**
 * The Review (Changes) tab body: toolbar + a single scrollable diff. Dual-scope —
 * with no thread it renders the git working-tree views (Unstaged/Staged/Commit/
 * Branch) against the workspace root; with a thread it renders the turn views
 * (Last turn, Cumulative). Each view renders exactly one diff.
 */
export function DiffPanel() {
  const panelRootRef = useRef<HTMLDivElement>(null);
  const store = useDiffPanelStore();
  const {
    activeThreadId,
    activeWorkspaceId,
    diffScopeId,
    filesVisible,
    requestReviewFileJump,
    setReviewFilesVisible,
    subagentScope,
    viewMode,
  } = store;
  const {
    activeWorktreePath,
    filesDocked,
    filesPanelWidth,
    floatingFilesPanelMaxWidth,
    floatingFilesPanelMinWidth,
    getFilesPanelMaxWidth,
    getFloatingFilesPanelMaxWidth,
    setActiveWorktreePath,
    setFilesPanelWidth,
    setFilesVisible,
  } = useFilesPanelController({
    diffScopeId,
    panelRootRef,
    setReviewFilesVisible,
    viewMode,
  });
  const comparison = useComparisonController(store);

  return (
    <DiffPanelLayout
      activeThreadId={activeThreadId}
      activeWorkspaceId={activeWorkspaceId}
      activeWorktreePath={activeWorktreePath}
      comparisonErrorIdentity={comparison.comparisonErrorIdentity}
      comparisonFiles={comparison.comparisonFiles}
      comparisonIdentity={comparison.comparisonIdentity}
      comparisonLoading={comparison.comparisonLoading}
      comparisonPending={comparison.comparisonPending}
      diffScopeId={diffScopeId}
      filesDocked={filesDocked}
      filesPanelWidth={filesPanelWidth}
      filesVisible={filesVisible}
      floatingFilesPanelMaxWidth={floatingFilesPanelMaxWidth}
      floatingFilesPanelMinWidth={floatingFilesPanelMinWidth}
      getFilesPanelMaxWidth={getFilesPanelMaxWidth}
      getFloatingFilesPanelMaxWidth={getFloatingFilesPanelMaxWidth}
      onActiveWorktreePathChange={setActiveWorktreePath}
      onFilesPanelWidthChange={setFilesPanelWidth}
      onFilesVisibleChange={setFilesVisible}
      onRefreshComparison={comparison.onRefreshComparison}
      panelRootRef={panelRootRef}
      requestReviewFileJump={requestReviewFileJump}
      scopedCumulative={comparison.scopedCumulative}
      subagentScopeLabel={subagentScope?.label}
      viewMode={viewMode}
      visibleComparison={comparison.visibleComparison}
      visibleSettled={comparison.visibleSettled}
    />
  );
}

function DiffPanelLayout({
  activeThreadId,
  activeWorkspaceId,
  activeWorktreePath,
  comparisonErrorIdentity,
  comparisonFiles,
  comparisonIdentity,
  comparisonLoading,
  comparisonPending,
  diffScopeId,
  filesDocked,
  filesPanelWidth,
  filesVisible,
  floatingFilesPanelMaxWidth,
  floatingFilesPanelMinWidth,
  getFilesPanelMaxWidth,
  getFloatingFilesPanelMaxWidth,
  onActiveWorktreePathChange,
  onFilesPanelWidthChange,
  onFilesVisibleChange,
  onRefreshComparison,
  panelRootRef,
  requestReviewFileJump,
  scopedCumulative,
  subagentScopeLabel,
  viewMode,
  visibleComparison,
  visibleSettled,
}: {
  readonly activeThreadId: string | null;
  readonly activeWorkspaceId: string | null;
  readonly activeWorktreePath: string | null;
  readonly comparisonErrorIdentity: string | null;
  readonly comparisonFiles: readonly ReviewFileChange[];
  readonly comparisonIdentity: string;
  readonly comparisonLoading: boolean;
  readonly comparisonPending: boolean;
  readonly diffScopeId: string | null;
  readonly filesDocked: boolean;
  readonly filesPanelWidth: number;
  readonly filesVisible: boolean;
  readonly floatingFilesPanelMaxWidth: number;
  readonly floatingFilesPanelMinWidth: number;
  readonly getFilesPanelMaxWidth: (panel: HTMLDivElement | null) => number;
  readonly getFloatingFilesPanelMaxWidth: (panel: HTMLDivElement | null) => number;
  readonly onActiveWorktreePathChange: (path: string | null) => void;
  readonly onFilesPanelWidthChange: (width: number) => void;
  readonly onFilesVisibleChange: (visible: boolean) => void;
  readonly onRefreshComparison: () => void;
  readonly panelRootRef: RefObject<HTMLDivElement | null>;
  readonly requestReviewFileJump: DiffStoreState["requestReviewFileJump"];
  readonly scopedCumulative: boolean;
  readonly subagentScopeLabel: string | undefined;
  readonly viewMode: DiffViewMode;
  readonly visibleComparison: ReviewComparison | null;
  readonly visibleSettled: SettledComparison | null;
}) {
  const filesLoading = !visibleSettled && comparisonErrorIdentity !== comparisonIdentity && !scopedCumulative;
  const handleActivateFile = (path: string) => {
    onActiveWorktreePathChange(path);
    if (diffScopeId) requestReviewFileJump(diffScopeId, path);
  };

  return (
    <div ref={panelRootRef} className="flex flex-1 flex-col overflow-hidden min-h-0">
      <DiffToolbar
        filesVisible={filesVisible}
        onToggleFiles={() => onFilesVisibleChange(!filesVisible)}
      />
      <div className="relative flex min-h-0 flex-1">
        <ScrollArea className="min-h-0 min-w-0 flex-1">
          <DiffPanelView
            activeThreadId={activeThreadId}
            activeWorkspaceId={activeWorkspaceId}
            comparisonLoading={comparisonLoading}
            comparisonPending={comparisonPending}
            onRefreshComparison={onRefreshComparison}
            scopedCumulative={scopedCumulative}
            subagentScopeLabel={subagentScopeLabel}
            viewMode={viewMode}
            visibleComparison={visibleComparison}
            visibleSettled={visibleSettled}
          />
        </ScrollArea>
        <ReviewFilesPane
          activePath={activeWorktreePath}
          comparisonFiles={comparisonFiles}
          comparisonLoading={comparisonLoading}
          docked={filesDocked}
          filesLoading={filesLoading}
          filesPanelWidth={filesPanelWidth}
          filesVisible={filesVisible}
          floatingFilesPanelMaxWidth={floatingFilesPanelMaxWidth}
          floatingFilesPanelMinWidth={floatingFilesPanelMinWidth}
          getFilesPanelMaxWidth={getFilesPanelMaxWidth}
          getFloatingFilesPanelMaxWidth={getFloatingFilesPanelMaxWidth}
          onActivate={handleActivateFile}
          onClose={() => onFilesVisibleChange(false)}
          onRefresh={onRefreshComparison}
          onWidthChange={onFilesPanelWidthChange}
          viewMode={viewMode}
        />
      </div>
    </div>
  );
}

function DiffPanelView({
  activeThreadId,
  activeWorkspaceId,
  comparisonLoading,
  comparisonPending,
  onRefreshComparison,
  scopedCumulative,
  subagentScopeLabel,
  viewMode,
  visibleComparison,
  visibleSettled,
}: {
  readonly activeThreadId: string | null;
  readonly activeWorkspaceId: string | null;
  readonly comparisonLoading: boolean;
  readonly comparisonPending: boolean;
  readonly onRefreshComparison: () => void;
  readonly scopedCumulative: boolean;
  readonly subagentScopeLabel: string | undefined;
  readonly viewMode: DiffViewMode;
  readonly visibleComparison: ReviewComparison | null;
  readonly visibleSettled: SettledComparison | null;
}) {
  if (activeThreadId && isGitView(viewMode) && activeWorkspaceId) {
    return (
      <GitComparisonView
        comparisonPending={comparisonPending}
        onRefreshComparison={onRefreshComparison}
        threadId={activeThreadId}
        viewMode={viewMode}
        visibleSettled={visibleSettled}
      />
    );
  }
  if (activeThreadId) {
    return (
      <ThreadComparisonView
        comparisonLoading={comparisonLoading}
        comparisonPending={comparisonPending}
        onRefreshComparison={onRefreshComparison}
        scopedCumulative={scopedCumulative}
        subagentScopeLabel={subagentScopeLabel}
        threadId={activeThreadId}
        viewMode={viewMode}
        visibleComparison={visibleComparison}
        visibleSettled={visibleSettled}
      />
    );
  }
  if (activeWorkspaceId && isGitView(viewMode)) {
    return (
      <GitComparisonView
        comparisonPending={comparisonPending}
        onRefreshComparison={onRefreshComparison}
        threadId={activeWorkspaceId}
        viewMode={viewMode}
        visibleSettled={visibleSettled}
      />
    );
  }
  return null;
}

function GitComparisonView({
  comparisonPending,
  onRefreshComparison,
  threadId,
  viewMode,
  visibleSettled,
}: {
  readonly comparisonPending: boolean;
  readonly onRefreshComparison: () => void;
  readonly threadId: string;
  readonly viewMode: GitView;
  readonly visibleSettled: SettledComparison | null;
}) {
  const immutable = viewMode === "commit";
  return (
    <GitDiffView
      resolved={visibleSettled?.git ?? null}
      threadId={threadId}
      loading={comparisonPending}
      immutable={immutable}
      onRefresh={onRefreshComparison}
      emptyLabel={immutable ? "No commit yet" : "No changes"}
    />
  );
}

function ThreadComparisonView({
  comparisonLoading,
  comparisonPending,
  onRefreshComparison,
  scopedCumulative,
  subagentScopeLabel,
  threadId,
  viewMode,
  visibleComparison,
  visibleSettled,
}: {
  readonly comparisonLoading: boolean;
  readonly comparisonPending: boolean;
  readonly onRefreshComparison: () => void;
  readonly scopedCumulative: boolean;
  readonly subagentScopeLabel: string | undefined;
  readonly threadId: string;
  readonly viewMode: DiffViewMode;
  readonly visibleComparison: ReviewComparison | null;
  readonly visibleSettled: SettledComparison | null;
}) {
  const state = getThreadComparisonViewState(comparisonPending, visibleSettled, scopedCumulative, viewMode);
  if (state === "loading") return <LoadingPulse />;
  if (state === "cumulative") {
    return (
      <CumulativeComparisonView
        comparisonLoading={comparisonLoading}
        onRefreshComparison={onRefreshComparison}
        scopeLabel={subagentScopeLabel}
        threadId={threadId}
        visibleComparison={visibleComparison}
        visibleSettled={visibleSettled}
      />
    );
  }
  return (
    <LastTurnComparisonView
      comparisonLoading={comparisonLoading}
      onRefreshComparison={onRefreshComparison}
      threadId={threadId}
      visibleComparison={visibleComparison}
      visibleSettled={visibleSettled}
    />
  );
}

function getThreadComparisonViewState(
  comparisonPending: boolean,
  visibleSettled: SettledComparison | null,
  scopedCumulative: boolean,
  viewMode: DiffViewMode,
): "cumulative" | "last-turn" | "loading" {
  if (comparisonPending && !visibleSettled && !scopedCumulative) return "loading";
  return viewMode === "cumulative" ? "cumulative" : "last-turn";
}

function CumulativeComparisonView({
  comparisonLoading,
  onRefreshComparison,
  scopeLabel,
  threadId,
  visibleComparison,
  visibleSettled,
}: {
  readonly comparisonLoading: boolean;
  readonly onRefreshComparison: () => void;
  readonly scopeLabel: string | undefined;
  readonly threadId: string;
  readonly visibleComparison: ReviewComparison | null;
  readonly visibleSettled: SettledComparison | null;
}) {
  return (
    <CumulativeView
      threadId={threadId}
      comparison={visibleComparison}
      cacheVersion={visibleSettled?.cacheVersion ?? ""}
      turnCount={visibleSettled?.turnCount ?? 0}
      refreshing={comparisonLoading}
      onRefresh={onRefreshComparison}
      scopeLabel={scopeLabel}
    />
  );
}

function LastTurnComparisonView({
  comparisonLoading,
  onRefreshComparison,
  threadId,
  visibleComparison,
  visibleSettled,
}: {
  readonly comparisonLoading: boolean;
  readonly onRefreshComparison: () => void;
  readonly threadId: string;
  readonly visibleComparison: ReviewComparison | null;
  readonly visibleSettled: SettledComparison | null;
}) {
  return (
    <LastTurnView
      threadId={threadId}
      comparison={visibleComparison}
      cacheVersion={visibleSettled?.cacheVersion ?? ""}
      refreshing={comparisonLoading}
      onRefresh={onRefreshComparison}
    />
  );
}

function ReviewFilesPane({
  activePath,
  comparisonFiles,
  comparisonLoading,
  docked,
  filesLoading,
  filesPanelWidth,
  filesVisible,
  floatingFilesPanelMaxWidth,
  floatingFilesPanelMinWidth,
  getFilesPanelMaxWidth,
  getFloatingFilesPanelMaxWidth,
  onActivate,
  onClose,
  onRefresh,
  onWidthChange,
  viewMode,
}: {
  readonly activePath: string | null;
  readonly comparisonFiles: readonly ReviewFileChange[];
  readonly comparisonLoading: boolean;
  readonly docked: boolean;
  readonly filesLoading: boolean;
  readonly filesPanelWidth: number;
  readonly filesVisible: boolean;
  readonly floatingFilesPanelMaxWidth: number;
  readonly floatingFilesPanelMinWidth: number;
  readonly getFilesPanelMaxWidth: (panel: HTMLDivElement | null) => number;
  readonly getFloatingFilesPanelMaxWidth: (panel: HTMLDivElement | null) => number;
  readonly onActivate: (path: string) => void;
  readonly onClose: () => void;
  readonly onRefresh: () => void;
  readonly onWidthChange: (width: number) => void;
  readonly viewMode: DiffViewMode;
}) {
  if (!filesVisible) return null;
  const layout = getFilesPaneLayout(
    docked,
    filesPanelWidth,
    floatingFilesPanelMaxWidth,
    floatingFilesPanelMinWidth,
    getFilesPanelMaxWidth,
    getFloatingFilesPanelMaxWidth,
  );
  return (
    <WorktreeFilesPane
      files={comparisonFiles}
      activePath={activePath}
      loading={filesLoading}
      error={null}
      width={layout.width}
      minWidth={layout.minWidth}
      maxWidth={layout.maxWidth}
      defaultWidth={FILES_PANEL_DEFAULT_WIDTH}
      wideWidth={FILES_PANEL_WIDE_WIDTH}
      getMaxWidth={layout.getMaxWidth}
      onWidthChange={onWidthChange}
      className={layout.className}
      onClose={onClose}
      refreshable={viewMode !== "commit"}
      refreshing={comparisonLoading}
      onRefresh={onRefresh}
      onActivate={onActivate}
    />
  );
}

function getFilesPaneLayout(
  docked: boolean,
  filesPanelWidth: number,
  floatingFilesPanelMaxWidth: number,
  floatingFilesPanelMinWidth: number,
  getFilesPanelMaxWidth: (panel: HTMLDivElement | null) => number,
  getFloatingFilesPanelMaxWidth: (panel: HTMLDivElement | null) => number,
) {
  if (docked) {
    return {
      className: undefined,
      getMaxWidth: getFilesPanelMaxWidth,
      maxWidth: `calc(100% - ${DIFF_VIEWPORT_MIN_WIDTH}px)`,
      minWidth: FILES_PANEL_MIN_WIDTH,
      width: filesPanelWidth,
    };
  }
  return {
    className: "absolute inset-y-0 right-0 z-30 h-full bg-popover ring-1 ring-inset ring-border/60 animate-in slide-in-from-right-2 duration-150 motion-reduce:animate-none",
    getMaxWidth: getFloatingFilesPanelMaxWidth,
    maxWidth: `calc(100% - ${FLOATING_FILES_PANEL_EDGE_GAP}px)`,
    minWidth: floatingFilesPanelMinWidth,
    width: Math.min(filesPanelWidth, floatingFilesPanelMaxWidth),
  };
}

/** The three-dot loading pulse shown while snapshots load. */
function LoadingPulse() {
  return (
    <div className="flex items-center justify-center gap-1.5 py-10">
      {[0, 150, 300].map((delay) => (
        <div
          key={delay}
          className="h-1 w-1 rounded-full bg-muted-foreground/25 animate-pulse"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </div>
  );
}
