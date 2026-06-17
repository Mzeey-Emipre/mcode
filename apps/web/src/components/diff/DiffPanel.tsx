import { useEffect } from "react";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useDiffStore } from "@/stores/diffStore";
import { getTransport } from "@/transport";
import { DiffToolbar } from "./DiffToolbar";
import { LastTurnView } from "./LastTurnView";
import { CumulativeView } from "./CumulativeView";
import { GitDiffView, type GitView } from "./GitDiffView";
import { ScrollArea } from "@/components/ui/scroll-area";

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
    <div className="flex flex-1 flex-col overflow-hidden min-h-0">
      <DiffToolbar />

      <ScrollArea className="flex-1 min-h-0">
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
