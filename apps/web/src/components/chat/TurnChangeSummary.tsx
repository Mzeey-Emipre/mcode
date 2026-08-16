import { useState, useCallback, useEffect, useId } from "react";
import { ChevronRight, FileText, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDiffStore } from "@/stores/diffStore";
import { readThreadRecord } from "@/stores/thread-selectors";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { showRightPanelAdaptive } from "@/lib/right-panel-layout";
import { getTransport } from "@/transport";
import { diffCardSurfaceClass } from "@/components/diff/diff-surface";
import { DiffStat } from "@/components/diff/DiffStat";

/** Props for TurnChangeSummary. */
interface TurnChangeSummaryProps {
  messageId: string;
  filesChanged: string[];
  isLatestTurn: boolean;
  /** Ref-stable map of messageId -> manual expanded override, survives virtualizer remounts. */
  manualExpandRef?: React.RefObject<Map<string, boolean>>;
}

/** Extract just the filename from a path for display. */
function fileName(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 1] ?? filePath;
}

/** Extract the parent directory from a path for display. */
function parentDir(filePath: string): string {
  const parts = filePath.split("/");
  if (parts.length <= 1) return "";
  return parts.slice(0, -1).join("/");
}

/** Cap displayed files to avoid DOM bloat on massive turns. */
const MAX_DISPLAYED_FILES = 50;

/**
 * Inline banner showing files changed in an agent turn.
 * Collapsed: single-line bar with file count and expand chevron.
 * Expanded: file list with per-file "Diff" button and a "View all diffs" button.
 */
export function TurnChangeSummary({ messageId, filesChanged, isLatestTurn, manualExpandRef }: TurnChangeSummaryProps) {
  // Restore manual override from ref if the virtualizer remounted this component
  const manualOverride = manualExpandRef?.current?.get(messageId);
  const contentId = useId();
  const [expanded, setExpanded] = useState(manualOverride ?? isLatestTurn);
  const [diffStats, setDiffStats] = useState<Map<string, { additions: number; deletions: number }> | null>(null);
  const fileCount = filesChanged.length;
  const displayedFiles = filesChanged.slice(0, MAX_DISPLAYED_FILES);
  const hiddenCount = fileCount - displayedFiles.length;

  // Sync expanded state when isLatestTurn changes (auto-collapse older turns).
  // Prefer any stored manual override; only fall back to isLatestTurn when the
  // user hasn't explicitly toggled this banner.
  useEffect(() => {
    const override = manualExpandRef?.current?.get(messageId);
    setExpanded(override ?? isLatestTurn);
  }, [isLatestTurn, messageId, manualExpandRef]);

  const handleToggle = useCallback(() => {
    setExpanded((prev) => {
      const next = !prev;
      manualExpandRef?.current?.set(messageId, next);
      return next;
    });
  }, [messageId, manualExpandRef]);

  // Fetch per-file diff stats when the banner is expanded
  useEffect(() => {
    if (!expanded || diffStats !== null) return;

    void (async () => {
      try {
        const threadId = useWorkspaceStore.getState().activeThreadId;
        if (!threadId) return;

        const serverMsgId = readThreadRecord(threadId).serverMessageIds[messageId] ?? messageId;

        // Resolve snapshot — load from server if not cached in diffStore
        let snapshots = useDiffStore.getState().snapshotsByThread[threadId];
        if (!snapshots) {
          snapshots = await getTransport().listSnapshots(threadId);
          useDiffStore.getState().setSnapshots(threadId, snapshots);
        }
        const snapshot = snapshots.find((s) => s.message_id === serverMsgId);
        if (!snapshot) return;

        const stats = await getTransport().getSnapshotDiffStats(snapshot.id);
        const statsMap = new Map(
          stats.map((s) => [s.filePath, { additions: s.additions, deletions: s.deletions }]),
        );
        setDiffStats(statsMap);
      } catch {
        // Best-effort: stats are decorative, don't block the file list
      }
    })();
  }, [expanded, diffStats, messageId]);

  /** Open the diff panel focused on the Changes tab, scrolled to this turn's snapshot. */
  const handleViewAllDiffs = useCallback(async () => {
    const { activeThreadId: threadId, activeWorkspaceId: workspaceId } =
      useWorkspaceStore.getState();
    if (!threadId || !workspaceId) return;

    const store = useDiffStore.getState();
    showRightPanelAdaptive(workspaceId, threadId);
    store.setRightPanelTab(workspaceId, threadId, "changes");
    // Pin cumulative as the per-thread override so the live default cannot revert
    // this deliberate pick (ADR-0011).
    store.setReviewViewForThread(threadId, "cumulative");

    // Ensure snapshots are loaded so the panel can display this turn
    if (!store.snapshotsByThread[threadId]) {
      try {
        const snapshots = await getTransport().listSnapshots(threadId);
        useDiffStore.getState().setSnapshots(threadId, snapshots);
      } catch (err) {
        console.warn("[TurnChangeSummary] Failed to load snapshots:", err);
      }
    }
  }, []);

  return (
    <div className="my-1">
      <div className={diffCardSurfaceClass()}>
        {/* Header row: toggle and "View All Diffs" are siblings to avoid nested buttons */}
        <div className="flex w-full items-center justify-between px-2.5 py-1 text-xs text-muted-foreground">
          <Button
            variant="ghost"
            size="xs"
            onClick={handleToggle}
            aria-expanded={expanded}
            aria-controls={expanded ? contentId : undefined}
            className="gap-2 px-1.5 hover:bg-transparent text-muted-foreground hover:text-foreground/80"
          >
            <FileText size={13} className="shrink-0 text-muted-foreground/60" />
            <span>
              {fileCount} file{fileCount !== 1 ? "s" : ""} changed
            </span>
            <ChevronRight
              aria-hidden="true"
              size={12}
              className={`shrink-0 text-muted-foreground/55 transition-transform ${expanded ? "rotate-90" : ""}`}
            />
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onClick={handleViewAllDiffs}
            className="gap-1 text-muted-foreground/70"
          >
            <ExternalLink size={10} />
            View all diffs
          </Button>
        </div>

        {/* File list — only rendered when expanded */}
        {expanded && (
          <div id={contentId} className="px-1 pb-1 pt-0.5">
            {displayedFiles.map((filePath) => {
              const name = fileName(filePath);
              const dir = parentDir(filePath);
              const stat = diffStats?.get(filePath);
              return (
                <div
                  key={filePath}
                  className="flex items-center justify-between rounded-md px-2 py-0.5 text-xs hover:bg-muted/40 transition-colors"
                >
                  <div className="flex items-center gap-1.5 min-w-0 overflow-hidden">
                    <span className="font-medium text-foreground/80 truncate">{name}</span>
                    {dir && (
                      <span className="text-muted-foreground/60 truncate font-mono text-xs">
                        {dir}
                      </span>
                    )}
                  </div>
                  {stat && <DiffStat additions={stat.additions} deletions={stat.deletions} />}
                </div>
              );
            })}
            {hiddenCount > 0 && (
              <Button
                variant="ghost"
                size="xs"
                onClick={handleViewAllDiffs}
                className="w-full justify-center text-muted-foreground/60 hover:text-foreground/80 mt-0.5"
              >
                +{hiddenCount} more file{hiddenCount !== 1 ? "s" : ""} — View all diffs
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
