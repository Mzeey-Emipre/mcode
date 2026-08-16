import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReviewComparison, ReviewFileChange } from "@mcode/contracts";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useDiffStore } from "@/stores/diffStore";
import { getTransport } from "@/transport";
import { DiffToolbar } from "./DiffToolbar";
import { LastTurnView } from "./LastTurnView";
import { CumulativeView } from "./CumulativeView";
import { GitDiffView, type GitView, type ResolvedGitComparison } from "./GitDiffView";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useElementWidth } from "@/hooks/useElementWidth";
import { WorktreeFilesPane } from "./WorktreeFilesPane";
import { cumulativeReviewFiles, reviewFilesForSnapshot } from "@/lib/review-comparison";

const FILES_PANEL_MIN_WIDTH = 280;
const FILES_PANEL_DEFAULT_WIDTH = 320;
const FILES_PANEL_WIDE_WIDTH = 480;
const DIFF_VIEWPORT_MIN_WIDTH = 520;
const DOCKED_FILES_MIN_WIDTH = FILES_PANEL_MIN_WIDTH + DIFF_VIEWPORT_MIN_WIDTH;
const FLOATING_FILES_PANEL_EDGE_GAP = 48;
const FLOATING_FILES_PANEL_FLOOR = 220;

/** The threadless git working-tree view ids. */
const GIT_VIEWS: readonly GitView[] = ["unstaged", "staged", "commit", "branch"];

/** Type guard: whether a view mode is one of the threadless git working-tree views. */
function isGitView(mode: string): mode is GitView {
  return (GIT_VIEWS as readonly string[]).includes(mode);
}

/**
 * The Review (Changes) tab body: toolbar + a single scrollable diff. Dual-scope —
 * with no thread it renders the git working-tree views (Unstaged/Staged/Commit/
 * Branch) against the workspace root; with a thread it renders the turn views
 * (Last turn, Cumulative). Each view renders exactly one diff.
 */
export function DiffPanel() {
  const panelRootRef = useRef<HTMLDivElement>(null);
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const viewMode = useDiffStore((s) => s.viewMode);
  const subagentScope = useDiffStore((s) =>
    activeThreadId ? s.subagentReviewScopeByThread[activeThreadId] : undefined,
  );
  const snapshots = useDiffStore((s) =>
    activeThreadId ? s.snapshotsByThread[activeThreadId] : undefined,
  );
  const snapshotsLoading = useDiffStore((s) =>
    activeThreadId ? (s.snapshotsLoadingByThread[activeThreadId] ?? false) : false,
  );
  const snapshotsPending = useDiffStore((s) =>
    activeThreadId ? (s.snapshotsPendingByThread[activeThreadId] ?? false) : false,
  );
  // The whole panel record is per-thread, falling back to the workspace record
  // for uncustomized threads (ADR-0012).
  const panelState = useDiffStore((s) =>
    activeWorkspaceId
      ? (activeThreadId ? s.rightPanelByThread[activeThreadId] : undefined) ??
        s.rightPanelFallbackByWorkspace[activeWorkspaceId]
      : undefined,
  );
  const panelVisible = useDiffStore((s) =>
    activeWorkspaceId ? s.getRightPanelVisible(activeWorkspaceId, activeThreadId) : false,
  );
  const setSnapshots = useDiffStore((s) => s.setSnapshots);
  const setSnapshotsLoading = useDiffStore((s) => s.setSnapshotsLoading);
  const requestReviewFileJump = useDiffStore((s) => s.requestReviewFileJump);
  const diffScopeId = activeThreadId ?? activeWorkspaceId;
  const filesVisible = useDiffStore((s) =>
    diffScopeId ? (s.reviewFilesVisibleByScope[diffScopeId] ?? false) : false,
  );
  const setReviewFilesVisible = useDiffStore((s) => s.setReviewFilesVisible);
  const selectedCommitSha = useDiffStore((s) => s.selectedCommitSha);
  const branchComparison = useDiffStore((s) => s.branchComparison);
  const diffRevision = useDiffStore((s) =>
    diffScopeId ? (s.diffRevisionByScope[diffScopeId] ?? 0) : 0,
  );
  const bumpDiffRevision = useDiffStore((s) => s.bumpDiffRevision);
  const setReviewDiffStat = useDiffStore((s) => s.setReviewDiffStat);
  const panelWidth = useElementWidth(panelRootRef, diffScopeId ?? undefined);
  const filesDocked = panelWidth >= DOCKED_FILES_MIN_WIDTH;
  const [filesPanelWidth, setFilesPanelWidth] = useState(FILES_PANEL_DEFAULT_WIDTH);
  const [settled, setSettled] = useState<{
    identity: string;
    comparison: ReviewComparison;
    git: ResolvedGitComparison | null;
    snapshotId: string | null;
    cacheVersion: string | number;
    turnCount: number;
  } | null>(null);
  const [comparisonLoading, setComparisonLoading] = useState(false);
  const [comparisonErrorIdentity, setComparisonErrorIdentity] = useState<string | null>(null);
  const [snapshotRefreshRevision, setSnapshotRefreshRevision] = useState(0);
  const comparisonIdentityRef = useRef("");
  const refreshRequestRef = useRef(0);
  const [activeWorktreePath, setActiveWorktreePath] = useState<string | null>(null);
  const mutableComparisonRevision = isGitView(viewMode) && viewMode !== "commit" ? diffRevision : 0;

  const setFilesVisible = useCallback(
    (visible: boolean) => {
      if (!diffScopeId) return;
      setReviewFilesVisible(diffScopeId, visible);
    },
    [diffScopeId, setReviewFilesVisible],
  );

  const getFilesPanelMaxWidth = useCallback(
    (panel: HTMLDivElement | null): number =>
      Math.max(
        FILES_PANEL_MIN_WIDTH,
        (panel?.parentElement?.clientWidth ?? window.innerWidth) - DIFF_VIEWPORT_MIN_WIDTH,
      ),
    [],
  );
  const floatingFilesPanelMaxWidth =
    panelWidth > 0
      ? Math.max(FLOATING_FILES_PANEL_FLOOR, panelWidth - FLOATING_FILES_PANEL_EDGE_GAP)
      : FILES_PANEL_DEFAULT_WIDTH;
  const floatingFilesPanelMinWidth = Math.min(
    FILES_PANEL_MIN_WIDTH,
    floatingFilesPanelMaxWidth,
  );
  const getFloatingFilesPanelMaxWidth = useCallback(
    (panel: HTMLDivElement | null): number =>
      Math.max(
        floatingFilesPanelMinWidth,
        (panel?.parentElement?.clientWidth ?? window.innerWidth) -
          FLOATING_FILES_PANEL_EDGE_GAP,
      ),
    [floatingFilesPanelMinWidth],
  );

  useEffect(() => setActiveWorktreePath(null), [viewMode, diffScopeId]);

  const latestSnapshot = useMemo(
    () => [...(snapshots ?? [])].reverse().find((snapshot) => snapshot.files_changed.length > 0),
    [snapshots],
  );
  const branchRange = useMemo(() => {
    if (!branchComparison?.base || !branchComparison.target) return null;
    return { base: branchComparison.target, target: branchComparison.base };
  }, [branchComparison]);
  const comparisonIdentity = `${diffScopeId ?? "none"}:${viewMode}:${
    viewMode === "commit" ? (selectedCommitSha ?? "") : ""
  }:${viewMode === "branch" ? `${branchRange?.base ?? ""}...${branchRange?.target ?? ""}` : ""}`;
  const snapshotVersion = (snapshots ?? []).map((snapshot) => `${snapshot.id}:${snapshot.ref_after}`).join("|");
  comparisonIdentityRef.current = comparisonIdentity;
  const visibleSettled = settled?.identity === comparisonIdentity ? settled : null;
  const visibleComparison = useMemo<ReviewComparison | null>(() => {
    const comparison = visibleSettled?.comparison;
    if (!subagentScope || viewMode !== "cumulative") return comparison ?? null;
    const settledFilesByPath = new Map(
      comparison?.files.map((file) => [file.path, file]),
    );
    return {
      files: subagentScope.paths.map(
        (path): ReviewFileChange => settledFilesByPath.get(path) ?? ({
          path,
          previousPath: null,
          changeType: "modified",
          binary: false,
        }),
      ),
      additions: subagentScope.additions,
      deletions: subagentScope.deletions,
    };
  }, [subagentScope, viewMode, visibleSettled]);
  const comparisonFiles: ReviewFileChange[] = visibleComparison?.files ?? [];

  useEffect(() => {
    setReviewDiffStat(visibleComparison
      ? { additions: visibleComparison.additions, deletions: visibleComparison.deletions }
      : null);
  }, [setReviewDiffStat, visibleComparison]);

  useEffect(() => {
    if (!activeWorkspaceId || !diffScopeId) return;
    if (!isGitView(viewMode) && (!activeThreadId || snapshots === undefined || snapshotsLoading)) return;
    if (viewMode === "branch" && !branchComparison?.isUnborn && branchComparison?.isComparisonAvailable !== false && !branchRange) return;

    let cancelled = false;
    setComparisonLoading(true);
    setComparisonErrorIdentity(null);
    const load = async (): Promise<{
      comparison: ReviewComparison;
      git: ResolvedGitComparison | null;
      snapshotId: string | null;
      cacheVersion: string | number;
      turnCount: number;
    }> => {
      const transport = getTransport();
      if (isGitView(viewMode)) {
        let comparison: ReviewComparison;
        let source: ResolvedGitComparison["source"] = viewMode;
        let id = activeWorkspaceId;
        if (viewMode === "commit" && !selectedCommitSha) {
          comparison = { files: [], additions: 0, deletions: 0 };
        } else if (viewMode === "branch" && (branchComparison?.isUnborn || branchComparison?.isComparisonAvailable === false || !branchRange)) {
          comparison = { files: [], additions: 0, deletions: 0 };
          source = "branch";
          id = "branch-empty";
        } else {
          comparison = await transport.getReviewComparison({
            workspaceId: activeWorkspaceId,
            view: viewMode,
            threadId: activeThreadId ?? undefined,
            sha: viewMode === "commit" ? selectedCommitSha ?? undefined : undefined,
            base: viewMode === "branch" ? branchRange?.base : undefined,
            target: viewMode === "branch" ? branchRange?.target : undefined,
          });
          if (viewMode === "commit") id = selectedCommitSha!;
          if (viewMode === "branch") id = `${branchRange!.base}...${branchRange!.target}`;
        }
        return {
          comparison,
          git: { comparison, source, id, cacheVersion: mutableComparisonRevision },
          snapshotId: null,
          cacheVersion: mutableComparisonRevision,
          turnCount: 0,
        };
      }
      if (viewMode === "cumulative") {
        const stats = await transport.getCumulativeDiffStats(activeThreadId!);
        const comparison = {
          files: cumulativeReviewFiles(snapshots ?? [], stats.map((entry) => entry.filePath)),
          additions: stats.reduce((total, entry) => total + entry.additions, 0),
          deletions: stats.reduce((total, entry) => total + entry.deletions, 0),
        };
        return {
          comparison,
          git: null,
          snapshotId: null,
          cacheVersion: snapshotVersion,
          turnCount: snapshots?.length ?? 0,
        };
      }
      if (!latestSnapshot) {
        return {
          comparison: { files: [], additions: 0, deletions: 0 },
          git: null,
          snapshotId: null,
          cacheVersion: snapshotVersion,
          turnCount: snapshots?.length ?? 0,
        };
      }
      const stats = await transport.getSnapshotDiffStats(latestSnapshot.id);
      return {
        comparison: {
          files: reviewFilesForSnapshot(latestSnapshot),
          additions: stats.reduce((total, entry) => total + entry.additions, 0),
          deletions: stats.reduce((total, entry) => total + entry.deletions, 0),
        },
        git: null,
        snapshotId: latestSnapshot.id,
        cacheVersion: `${latestSnapshot.id}:${latestSnapshot.ref_after}`,
        turnCount: snapshots?.length ?? 0,
      };
    };

    void load().then((next) => {
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
  }, [activeWorkspaceId, activeThreadId, diffScopeId, viewMode, selectedCommitSha, branchComparison, branchRange, mutableComparisonRevision, snapshots, snapshotsLoading, snapshotVersion, snapshotRefreshRevision, latestSnapshot, comparisonIdentity]);

  const refreshComparison = useCallback(() => {
    if (!diffScopeId || comparisonLoading || viewMode === "commit") return;
    if (isGitView(viewMode)) {
      bumpDiffRevision(diffScopeId);
      return;
    }
    if (!activeThreadId) return;
    const requestId = ++refreshRequestRef.current;
    const requestedIdentity = comparisonIdentity;
    setComparisonLoading(true);
    getTransport().listSnapshots(activeThreadId).then((next) => {
      if (
        refreshRequestRef.current !== requestId ||
        comparisonIdentityRef.current !== requestedIdentity
      ) return;
      setSnapshots(activeThreadId, next);
      setSnapshotRefreshRevision((revision) => revision + 1);
    }).catch(() => {
      if (
        refreshRequestRef.current === requestId &&
        comparisonIdentityRef.current === requestedIdentity
      ) setComparisonLoading(false);
    });
  }, [activeThreadId, comparisonIdentity, comparisonLoading, diffScopeId, viewMode, bumpDiffRevision, setSnapshots]);

  useEffect(() => () => {
    refreshRequestRef.current += 1;
  }, []);

  useEffect(() => {
    if (!activeThreadId) return;
    if (snapshots !== undefined) return;

    let cancelled = false;
    setSnapshotsLoading(activeThreadId, true);

    const load = async () => {
      try {
        const result = await getTransport().listSnapshots(activeThreadId);
        if (!cancelled) setSnapshots(activeThreadId, result);
      } catch {
        if (!cancelled) setSnapshots(activeThreadId, []);
      } finally {
        if (!cancelled) setSnapshotsLoading(activeThreadId, false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [activeThreadId, snapshots, setSnapshots, setSnapshotsLoading]);

  // When a snapshot refresh is pending and the user is no longer viewing the
  // Cumulative view, silently refetch so a return to Cumulative shows fresh data.
  useEffect(() => {
    if (!activeThreadId || !snapshotsPending) return;
    const isViewingCumulative =
      panelVisible &&
      panelState?.activeTab === "changes" &&
      viewMode === "cumulative";
    if (isViewingCumulative) return;

    let cancelled = false;
    getTransport()
      .listSnapshots(activeThreadId)
      .then((result) => {
        if (!cancelled) setSnapshots(activeThreadId, result);
      })
      .catch(() => { /* non-critical */ });
    return () => {
      cancelled = true;
    };
  }, [activeThreadId, snapshotsPending, panelVisible, panelState, viewMode, setSnapshots]);

  const comparisonPending =
    snapshotsLoading ||
    comparisonLoading ||
    (!visibleSettled && comparisonErrorIdentity !== comparisonIdentity);
  const scopedCumulative = viewMode === "cumulative" && subagentScope !== undefined;

  return (
    <div ref={panelRootRef} className="flex flex-1 flex-col overflow-hidden min-h-0">
      <DiffToolbar
        filesVisible={filesVisible}
        onToggleFiles={() => setFilesVisible(!filesVisible)}
      />

      <div className="relative flex min-h-0 flex-1">
      <ScrollArea className="min-h-0 min-w-0 flex-1">
        {activeThreadId ? (
          // The git working-tree views are additive in a thread: they read the
          // thread's checkout (passed via threadId), alongside the turn views.
          isGitView(viewMode) && activeWorkspaceId ? (
            <GitDiffView resolved={visibleSettled?.git ?? null} threadId={activeThreadId} loading={comparisonPending} immutable={viewMode === "commit"} onRefresh={refreshComparison} emptyLabel={viewMode === "commit" ? "No commit yet" : "No changes"} />
          ) : comparisonPending && !visibleSettled && !scopedCumulative ? (
            <LoadingPulse />
          ) : viewMode === "cumulative" ? (
            <CumulativeView
              threadId={activeThreadId}
              comparison={visibleComparison}
              cacheVersion={visibleSettled?.cacheVersion ?? ""}
              turnCount={visibleSettled?.turnCount ?? 0}
              refreshing={comparisonLoading}
              onRefresh={refreshComparison}
              scopeLabel={subagentScope?.label}
            />
          ) : (
            // Default (and "last-turn") thread view: the most recent turn's diff.
            <LastTurnView threadId={activeThreadId} comparison={visibleComparison} snapshotId={visibleSettled?.snapshotId ?? null} cacheVersion={visibleSettled?.cacheVersion ?? ""} refreshing={comparisonLoading} onRefresh={refreshComparison} />
          )
        ) : activeWorkspaceId && isGitView(viewMode) ? (
          <GitDiffView resolved={visibleSettled?.git ?? null} threadId={activeWorkspaceId} loading={comparisonPending} immutable={viewMode === "commit"} onRefresh={refreshComparison} emptyLabel={viewMode === "commit" ? "No commit yet" : "No changes"} />
        ) : null}
      </ScrollArea>
      {filesDocked && filesVisible ? (
        <WorktreeFilesPane
          files={comparisonFiles}
          activePath={activeWorktreePath}
          loading={!visibleSettled && comparisonErrorIdentity !== comparisonIdentity && !scopedCumulative}
          error={null}
          width={filesPanelWidth}
          minWidth={FILES_PANEL_MIN_WIDTH}
          maxWidth={`calc(100% - ${DIFF_VIEWPORT_MIN_WIDTH}px)`}
          defaultWidth={FILES_PANEL_DEFAULT_WIDTH}
          wideWidth={FILES_PANEL_WIDE_WIDTH}
          getMaxWidth={getFilesPanelMaxWidth}
          onWidthChange={setFilesPanelWidth}
          onClose={() => setFilesVisible(false)}
          refreshable={viewMode !== "commit"}
          refreshing={comparisonLoading}
          onRefresh={refreshComparison}
          onActivate={(path) => {
            setActiveWorktreePath(path);
            if (diffScopeId) requestReviewFileJump(diffScopeId, path);
          }}
        />
      ) : null}
      {!filesDocked && filesVisible ? (
        <WorktreeFilesPane
          files={comparisonFiles}
          activePath={activeWorktreePath}
          loading={!visibleSettled && comparisonErrorIdentity !== comparisonIdentity && !scopedCumulative}
          error={null}
          width={Math.min(filesPanelWidth, floatingFilesPanelMaxWidth)}
          minWidth={floatingFilesPanelMinWidth}
          maxWidth={`calc(100% - ${FLOATING_FILES_PANEL_EDGE_GAP}px)`}
          defaultWidth={FILES_PANEL_DEFAULT_WIDTH}
          wideWidth={FILES_PANEL_WIDE_WIDTH}
          getMaxWidth={getFloatingFilesPanelMaxWidth}
          onWidthChange={setFilesPanelWidth}
          className="absolute inset-y-0 right-0 z-30 h-full bg-popover ring-1 ring-inset ring-border/60 animate-in slide-in-from-right-2 duration-150 motion-reduce:animate-none"
          onClose={() => setFilesVisible(false)}
          refreshable={viewMode !== "commit"}
          refreshing={comparisonLoading}
          onRefresh={refreshComparison}
          onActivate={(path) => {
            setActiveWorktreePath(path);
            if (diffScopeId) requestReviewFileJump(diffScopeId, path);
          }}
        />
      ) : null}
      </div>
    </div>
  );
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
