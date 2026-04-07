import { useState, useCallback, useEffect } from "react";
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
    <div className="my-2 select-none">
      {/* Horizontal-rule separator with inline count — no card wrapper */}
      <div className="flex items-center gap-2">
        <div className="h-px w-3 shrink-0 bg-border/25" />

        <Button
          variant="ghost"
          size="xs"
          onClick={handleToggle}
          aria-expanded={expanded}
          className="h-auto gap-1 px-0 py-0 font-mono text-[11px] font-normal tracking-tight text-muted-foreground/40 hover:bg-transparent hover:text-muted-foreground/70"
        >
          {/* Unicode triangle: no icon dependency, pure terminal aesthetic */}
          <span className="text-[9px]">{expanded ? "▾" : "▸"}</span>
          <span className="tabular-nums">{fileCount}</span>
          <span>changed</span>
        </Button>

        <div className="h-px flex-1 bg-border/25" />

        <Button
          variant="ghost"
          size="xs"
          onClick={handleViewAllDiffs}
          className="h-auto px-0 py-0 font-mono text-[10px] font-normal text-muted-foreground/25 hover:bg-transparent hover:text-muted-foreground/55"
        >
          diff ↗
        </Button>
      </div>

      {/* File list — rendered below the rule when expanded */}
      {expanded && (
        <div className="ml-5 mt-0.5">
          {displayedFiles.map((filePath) => {
            const name = fileName(filePath);
            const dir = parentDir(filePath);
            return (
              <div
                key={filePath}
                className="group flex items-baseline gap-2 border-l border-border/20 py-[3px] pl-2.5 text-[11px] transition-colors hover:border-border/50"
              >
                <span className="shrink-0 font-mono font-medium text-foreground/60">{name}</span>
                {dir && (
                  <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground/25">
                    {dir}
                  </span>
                )}
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => handleFileDiff(filePath)}
                  className="ml-auto h-auto shrink-0 px-0 py-0 font-mono text-[10px] font-normal text-muted-foreground/20 opacity-0 hover:bg-transparent hover:text-muted-foreground/60 focus-visible:opacity-100 group-hover:opacity-100"
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
              className="mt-0.5 h-auto border-l border-border/20 px-0 py-[3px] pl-2.5 font-mono text-[10px] font-normal text-muted-foreground/25 hover:bg-transparent hover:text-muted-foreground/55"
            >
              +{hiddenCount} more → view all
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
