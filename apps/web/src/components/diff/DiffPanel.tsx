import { useCallback, useEffect, useRef, useState } from "react";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useDiffStore } from "@/stores/diffStore";
import { getTransport } from "@/transport";
import { DiffToolbar } from "./DiffToolbar";
import { LastTurnView } from "./LastTurnView";
import { CumulativeView } from "./CumulativeView";
import { GitDiffView, type GitView } from "./GitDiffView";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useElementWidth } from "@/hooks/useElementWidth";
import { WorktreeFilesPane } from "./WorktreeFilesPane";

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
  const diffRevision = useDiffStore((s) =>
    diffScopeId ? (s.diffRevisionByScope[diffScopeId] ?? 0) : 0,
  );
  const panelWidth = useElementWidth(panelRootRef, diffScopeId ?? undefined);
  const filesDocked = panelWidth >= DOCKED_FILES_MIN_WIDTH;
  const [filesVisibilityByScope, setFilesVisibilityByScope] = useState<
    Record<string, boolean>
  >({});
  const filesVisible = diffScopeId
    ? (filesVisibilityByScope[diffScopeId] ?? filesDocked)
    : false;
  const [filesPanelWidth, setFilesPanelWidth] = useState(FILES_PANEL_DEFAULT_WIDTH);
  const [worktreeFiles, setWorktreeFiles] = useState<string[]>([]);
  const [worktreeFilesLoading, setWorktreeFilesLoading] = useState(false);
  const [worktreeFilesError, setWorktreeFilesError] = useState<string | null>(null);
  const [activeWorktreePath, setActiveWorktreePath] = useState<string | null>(null);

  const setFilesVisible = useCallback(
    (visible: boolean) => {
      if (!diffScopeId) return;
      setFilesVisibilityByScope((current) => ({ ...current, [diffScopeId]: visible }));
    },
    [diffScopeId],
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

  useEffect(() => {
    setActiveWorktreePath(null);
    if (!filesVisible || !activeWorkspaceId) return;
    let cancelled = false;
    setWorktreeFilesLoading(true);
    setWorktreeFilesError(null);
    void getTransport()
      .listWorkspaceFiles(activeWorkspaceId, activeThreadId ?? undefined)
      .then((files) => {
        if (!cancelled) setWorktreeFiles([...files].sort((a, b) => a.localeCompare(b)));
      })
      .catch(() => {
        if (!cancelled) {
          setWorktreeFiles([]);
          setWorktreeFilesError("Could not load worktree files.");
        }
      })
      .finally(() => {
        if (!cancelled) setWorktreeFilesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeThreadId, activeWorkspaceId, diffRevision, filesVisible]);

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
            <GitDiffView view={viewMode} workspaceId={activeWorkspaceId} threadId={activeThreadId} />
          ) : snapshotsLoading ? (
            <LoadingPulse />
          ) : viewMode === "cumulative" ? (
            <CumulativeView snapshots={snapshots ?? []} threadId={activeThreadId} />
          ) : (
            // Default (and "last-turn") thread view: the most recent turn's diff.
            <LastTurnView snapshots={snapshots ?? []} threadId={activeThreadId} />
          )
        ) : activeWorkspaceId && isGitView(viewMode) ? (
          <GitDiffView view={viewMode} workspaceId={activeWorkspaceId} />
        ) : null}
      </ScrollArea>
      {filesDocked && filesVisible ? (
        <WorktreeFilesPane
          files={worktreeFiles}
          activePath={activeWorktreePath}
          loading={worktreeFilesLoading}
          error={worktreeFilesError}
          width={filesPanelWidth}
          minWidth={FILES_PANEL_MIN_WIDTH}
          maxWidth={`calc(100% - ${DIFF_VIEWPORT_MIN_WIDTH}px)`}
          defaultWidth={FILES_PANEL_DEFAULT_WIDTH}
          wideWidth={FILES_PANEL_WIDE_WIDTH}
          getMaxWidth={getFilesPanelMaxWidth}
          onWidthChange={setFilesPanelWidth}
          onClose={() => setFilesVisible(false)}
          onActivate={(path) => {
            setActiveWorktreePath(path);
            if (diffScopeId) requestReviewFileJump(diffScopeId, path);
          }}
        />
      ) : null}
      {!filesDocked && filesVisible ? (
        <WorktreeFilesPane
          files={worktreeFiles}
          activePath={activeWorktreePath}
          loading={worktreeFilesLoading}
          error={worktreeFilesError}
          width={Math.min(filesPanelWidth, floatingFilesPanelMaxWidth)}
          minWidth={floatingFilesPanelMinWidth}
          maxWidth={`calc(100% - ${FLOATING_FILES_PANEL_EDGE_GAP}px)`}
          defaultWidth={FILES_PANEL_DEFAULT_WIDTH}
          wideWidth={FILES_PANEL_WIDE_WIDTH}
          getMaxWidth={getFloatingFilesPanelMaxWidth}
          onWidthChange={setFilesPanelWidth}
          className="absolute inset-y-0 right-0 z-30 h-full bg-popover ring-1 ring-inset ring-border/60 animate-in slide-in-from-right-2 duration-150 motion-reduce:animate-none"
          onClose={() => setFilesVisible(false)}
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
