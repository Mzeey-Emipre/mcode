import { useState, useCallback } from "react";
import { ChevronRight, FileText, ExternalLink } from "lucide-react";
import { useDiffStore } from "@/stores/diffStore";
import { useThreadStore } from "@/stores/threadStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { getTransport } from "@/transport";

/** Props for TurnChangeSummary. */
interface TurnChangeSummaryProps {
  messageId: string;
  filesChanged: string[];
  isLatestTurn: boolean;
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

/**
 * Inline banner showing files changed in an agent turn.
 * Collapsed: single-line bar with file count and expand chevron.
 * Expanded: file list with per-file "Diff" button and a "View All Diffs" button.
 */
export function TurnChangeSummary({ messageId, filesChanged, isLatestTurn }: TurnChangeSummaryProps) {
  const [expanded, setExpanded] = useState(isLatestTurn);
  const fileCount = filesChanged.length;

  const handleToggle = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  /** Open the diff panel focused on the Changes tab, scrolled to this turn's snapshot. */
  const handleViewAllDiffs = useCallback(() => {
    const threadId = useWorkspaceStore.getState().activeThreadId;
    if (!threadId) return;

    const store = useDiffStore.getState();
    store.showPanel();
    store.setActiveTab("changes");
    store.setViewMode("by-turn");

    // Ensure snapshots are loaded so the panel can display this turn
    if (!store.snapshotsByThread[threadId]) {
      getTransport()
        .listSnapshots(threadId)
        .then((snapshots) => useDiffStore.getState().setSnapshots(threadId, snapshots))
        .catch(() => {});
    }
  }, []);

  /** Open the diff panel focused on a specific file from this turn's snapshot. */
  const handleFileDiff = useCallback(
    (filePath: string) => {
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
        getTransport()
          .listSnapshots(threadId)
          .then((loaded) => {
            useDiffStore.getState().setSnapshots(threadId, loaded);
            const snap = loaded.find((s) => s.message_id === serverMsgId);
            if (snap) {
              useDiffStore.getState().selectFile({ source: "snapshot", id: snap.id, filePath });
            }
          })
          .catch(() => {});
      }
    },
    [messageId],
  );

  return (
    <div className="my-1">
      {expanded ? (
        /* Expanded: full banner with file list inside */
        <div className="rounded-lg border border-border/40 bg-muted/30 overflow-hidden">
          {/* Header row */}
          <button
            type="button"
            onClick={handleToggle}
            className="flex w-full items-center justify-between px-3.5 py-2 text-xs text-muted-foreground hover:bg-muted/50 transition-colors cursor-pointer"
          >
            <div className="flex items-center gap-2">
              <FileText size={13} className="shrink-0 text-muted-foreground/60" />
              <span>
                {fileCount} file{fileCount !== 1 ? "s" : ""} changed
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  handleViewAllDiffs();
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.stopPropagation();
                    handleViewAllDiffs();
                  }
                }}
                className="inline-flex items-center gap-1 rounded-md bg-muted/60 px-2 py-0.5 text-[11px] text-muted-foreground/70 hover:bg-muted hover:text-foreground/80 transition-colors"
              >
                <ExternalLink size={10} />
                View All Diffs
              </span>
              <ChevronRight
                size={12}
                className="shrink-0 text-muted-foreground/40 rotate-90 transition-transform"
              />
            </div>
          </button>

          {/* File list */}
          <div className="border-t border-border/30 px-1 py-1">
            {filesChanged.map((filePath) => (
              <div
                key={filePath}
                className="flex items-center justify-between rounded-md px-2.5 py-1 text-xs hover:bg-muted/40 transition-colors group"
              >
                <div className="flex items-center gap-1.5 min-w-0 overflow-hidden">
                  <span className="font-medium text-foreground/80 truncate">
                    {fileName(filePath)}
                  </span>
                  {parentDir(filePath) && (
                    <span className="text-muted-foreground/40 truncate font-mono text-[11px]">
                      {parentDir(filePath)}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => handleFileDiff(filePath)}
                  className="shrink-0 rounded border border-border/40 bg-transparent px-1.5 py-0.5 text-[11px] text-muted-foreground/60 opacity-0 group-hover:opacity-100 hover:bg-muted/60 hover:text-foreground/80 transition-all cursor-pointer"
                >
                  Diff
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : (
        /* Collapsed: single-line bar */
        <button
          type="button"
          onClick={handleToggle}
          className="flex w-full items-center justify-between rounded-lg border border-border/40 bg-muted/30 px-3.5 py-2 text-xs text-muted-foreground hover:bg-muted/50 transition-colors cursor-pointer"
        >
          <div className="flex items-center gap-2">
            <FileText size={13} className="shrink-0 text-muted-foreground/60" />
            <span>
              {fileCount} file{fileCount !== 1 ? "s" : ""} changed
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                handleViewAllDiffs();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.stopPropagation();
                  handleViewAllDiffs();
                }
              }}
              className="inline-flex items-center gap-1 rounded-md bg-muted/60 px-2 py-0.5 text-[11px] text-muted-foreground/70 hover:bg-muted hover:text-foreground/80 transition-colors"
            >
              <ExternalLink size={10} />
              View All Diffs
            </span>
            <ChevronRight
              size={12}
              className="shrink-0 text-muted-foreground/40 transition-transform"
            />
          </div>
        </button>
      )}
    </div>
  );
}
