import { useState, useCallback, useEffect } from "react";
import { ChevronRight } from "lucide-react";
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
    <div className="my-1 border-l-2 border-border/30 transition-colors hover:border-border/50">
      {/* Header row — mirrors StreamingCard's trigger layout */}
      <div className="flex items-center justify-between pl-3 pr-1 py-1.5">
        <Button
          variant="ghost"
          size="xs"
          onClick={handleToggle}
          aria-expanded={expanded}
          className="h-auto gap-1.5 px-0 py-0 text-xs text-muted-foreground/50 hover:bg-transparent hover:text-foreground/70"
        >
          <ChevronRight
            size={11}
            className={`shrink-0 text-muted-foreground/30 transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
          />
          <span className="tabular-nums">{fileCount}</span>
          <span>file{fileCount !== 1 ? "s" : ""} changed</span>
        </Button>
        <Button
          variant="ghost"
          size="xs"
          onClick={handleViewAllDiffs}
          className="h-auto px-1 py-0 font-mono text-[11px] text-muted-foreground/35 hover:bg-transparent hover:text-muted-foreground/65"
        >
          diff ↗
        </Button>
      </div>

      {/* File list — only rendered when expanded */}
      {expanded && (
        <div className="pb-1.5 pl-3 pr-1">
          {displayedFiles.map((filePath) => {
            const name = fileName(filePath);
            const dir = parentDir(filePath);
            return (
              <div
                key={filePath}
                className="group -mx-1.5 flex items-baseline gap-1.5 rounded-md px-1.5 py-0.5 text-xs transition-colors hover:bg-muted/20"
              >
                <span className="shrink-0 font-medium text-foreground/60">{name}</span>
                {dir && (
                  <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground/30">
                    {dir}
                  </span>
                )}
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => handleFileDiff(filePath)}
                  className="ml-auto h-auto shrink-0 px-1 py-0 font-mono text-[10px] text-muted-foreground/40 opacity-0 hover:bg-transparent hover:text-muted-foreground/70 focus-visible:opacity-100 group-hover:opacity-100"
                >
                  diff
                </Button>
              </div>
            );
          })}
          {hiddenCount > 0 && (
            <Button
              variant="ghost"
              size="xs"
              onClick={handleViewAllDiffs}
              className="mt-0.5 h-auto px-1 py-0.5 font-mono text-[10px] text-muted-foreground/30 hover:bg-transparent hover:text-muted-foreground/60"
            >
              +{hiddenCount} more → view all
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
