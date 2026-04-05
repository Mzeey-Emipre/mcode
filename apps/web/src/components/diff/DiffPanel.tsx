import { useEffect } from "react";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useDiffStore } from "@/stores/diffStore";
import { getTransport } from "@/transport";
import { DiffToolbar } from "./DiffToolbar";
import { TurnTimeline } from "./TurnTimeline";
import { CumulativeView } from "./CumulativeView";
import { CommitsView } from "./CommitsView";
import { ScrollArea } from "@/components/ui/scroll-area";

/**
 * Main diff panel: toolbar + single scrollable stream.
 * Files expand inline — no bottom split pane.
 */
export function DiffPanel() {
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const viewMode = useDiffStore((s) => s.viewMode);
  const snapshots = useDiffStore((s) =>
    activeThreadId ? s.snapshotsByThread[activeThreadId] : undefined,
  );
  const snapshotsLoading = useDiffStore((s) =>
    activeThreadId ? (s.snapshotsLoadingByThread[activeThreadId] ?? false) : false,
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

  return (
    <div className="flex flex-1 flex-col overflow-hidden min-h-0">
      <DiffToolbar />

      <ScrollArea className="flex-1 min-h-0">
        {snapshotsLoading ? (
          <div className="flex items-center justify-center gap-1.5 py-10">
            {[0, 150, 300].map((delay) => (
              <div
                key={delay}
                className="h-1 w-1 rounded-full bg-muted-foreground/25 animate-pulse"
                style={{ animationDelay: `${delay}ms` }}
              />
            ))}
          </div>
        ) : (
          <>
            {viewMode === "by-turn" && <TurnTimeline snapshots={snapshots ?? []} />}
            {viewMode === "all" && activeThreadId && (
              <CumulativeView snapshots={snapshots ?? []} threadId={activeThreadId} />
            )}
            {viewMode === "commits" && <CommitsView />}
          </>
        )}
      </ScrollArea>
    </div>
  );
}
