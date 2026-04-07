import { useState, useCallback, useEffect } from "react";
import { ChevronRight, FileText, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDiffStore } from "@/stores/diffStore";
import { useThreadStore } from "@/stores/threadStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { getTransport } from "@/transport";

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
 * Expanded: file list with per-file "Diff" button and a "View All Diffs" button.
 */
export function TurnChangeSummary({ messageId, filesChanged, isLatestTurn, manualExpandRef }: TurnChangeSummaryProps) {
  // Restore manual override from ref if the virtualizer remounted this component
  const manualOverride = manualExpandRef?.current?.get(messageId);
  const [expanded, setExpanded] = useState(manualOverride ?? isLatestTurn);
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

  /** Open the diff panel focused on the Changes tab, scrolled to this turn's snapshot. */
  const handleViewAllDiffs = useCallback(async () => {
    const threadId = useWorkspaceStore.getState().activeThreadId;
    if (!threadId) return;

    const store = useDiffStore.getState();
    store.showPanel();
    store.setActiveTab("changes");
    store.setViewMode("by-turn");

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

  /** Open the diff panel focused on a specific file from this turn's snapshot. */
  const handleFileDiff = useCallback(
    async (filePath: string) => {
      const threadId = useWorkspaceStore.getState().activeThreadId;
      if (!threadId) return;

      const store = useDiffStore.getState();
      store.showPanel();
      store.setActiveTab("changes");
      store.setViewMode("by-turn");

      // Find the snapshot for this message to select the file
      const snapshots = store.snapshotsByThread[threadId];
      const serverMsgId = useThreadStore.getState().serverMessageIds[messageId] ?? messageId;
      const snapshot = snapshots?.find((s) => s.message_id === serverMsgId);

      if (snapshot) {
        store.selectFile({ source: "snapshot", id: snapshot.id, filePath });
      } else {
        // Snapshots not loaded yet; load them, then select
        try {
          const loaded = await getTransport().listSnapshots(threadId);
          useDiffStore.getState().setSnapshots(threadId, loaded);
          const snap = loaded.find((s) => s.message_id === serverMsgId);
          if (snap) {
            useDiffStore.getState().selectFile({ source: "snapshot", id: snap.id, filePath });
          }
        } catch (err) {
          console.warn("[TurnChangeSummary] Failed to load snapshots for file diff:", err);
        }
      }
    },
    [messageId],
  );

  return (
    <div className="my-1">
      <div className="rounded-lg border border-border/40 bg-muted/30 overflow-hidden">
        {/* Header row: toggle and "View All Diffs" are siblings to avoid nested buttons */}
        <div className="flex w-full items-center justify-between px-3 py-1.5 text-xs text-muted-foreground">
          <Button
            variant="ghost"
            size="xs"
            onClick={handleToggle}
            aria-expanded={expanded}
            className="gap-2 px-1.5 hover:bg-transparent text-muted-foreground hover:text-foreground/80"
          >
            <FileText size={13} className="shrink-0 text-muted-foreground/60" />
            <span>
              {fileCount} file{fileCount !== 1 ? "s" : ""} changed
            </span>
            <ChevronRight
              size={12}
              className={`shrink-0 text-muted-foreground/40 transition-transform ${expanded ? "rotate-90" : ""}`}
            />
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onClick={handleViewAllDiffs}
            className="gap-1 text-muted-foreground/70"
          >
            <ExternalLink size={10} />
            View All Diffs
          </Button>
        </div>

        {/* File list — only rendered when expanded */}
        {expanded && (
          <div className="border-t border-border/30 px-1 py-1">
            {displayedFiles.map((filePath) => {
              const name = fileName(filePath);
              const dir = parentDir(filePath);
              return (
                <div
                  key={filePath}
                  className="flex items-center justify-between rounded-md px-2.5 py-1 text-xs hover:bg-muted/40 transition-colors group"
                >
                  <div className="flex items-center gap-1.5 min-w-0 overflow-hidden">
                    <span className="font-medium text-foreground/80 truncate">{name}</span>
                    {dir && (
                      <span className="text-muted-foreground/40 truncate font-mono text-xs">
                        {dir}
                      </span>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => handleFileDiff(filePath)}
                    className="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-muted-foreground/60 hover:text-foreground/80"
                  >
                    Diff
                  </Button>
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
                +{hiddenCount} more file{hiddenCount !== 1 ? "s" : ""} — View All Diffs
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
