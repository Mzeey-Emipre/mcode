import { useEffect } from "react";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useDiffStore } from "@/stores/diffStore";
import { getTransport } from "@/transport";
import { DiffToolbar } from "./DiffToolbar";
import { TurnTimeline } from "./TurnTimeline";
import { DiffContent } from "./DiffContent";
import { CumulativeView } from "./CumulativeView";
import { CommitsView } from "./CommitsView";
import { ScrollArea } from "@/components/ui/scroll-area";

/** Main diff panel with toolbar, file browser, and diff viewer. */
export function DiffPanel() {
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const viewMode = useDiffStore((s) => s.viewMode);
  const snapshots = useDiffStore((s) =>
    activeThreadId ? s.snapshotsByThread[activeThreadId] : undefined,
  );
  const snapshotsLoading = useDiffStore((s) => s.snapshotsLoading);
  const setSnapshots = useDiffStore((s) => s.setSnapshots);
  const setSnapshotsLoading = useDiffStore((s) => s.setSnapshotsLoading);

  useEffect(() => {
    if (!activeThreadId) return;
    if (snapshots !== undefined) return;

    let cancelled = false;
    setSnapshotsLoading(true);

    getTransport()
      .listSnapshots(activeThreadId)
      .then((result) => {
        if (!cancelled) {
          setSnapshots(activeThreadId, result);
          setSnapshotsLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSnapshots(activeThreadId, []);
          setSnapshotsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeThreadId, snapshots, setSnapshots, setSnapshotsLoading]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden min-h-0">
      <DiffToolbar />

      <div className="flex flex-1 flex-col overflow-hidden min-h-0">
        {/* File browser: fixed 45% height */}
        <div className="flex-none overflow-hidden" style={{ height: "45%" }}>
          {snapshotsLoading ? (
            <div className="flex h-full items-center justify-center gap-1.5">
              {[0, 150, 300].map((delay) => (
                <div
                  key={delay}
                  className="h-1 w-1 rounded-full bg-muted-foreground/25 animate-pulse"
                  style={{ animationDelay: `${delay}ms` }}
                />
              ))}
            </div>
          ) : (
            <ScrollArea className="h-full">
              {viewMode === "by-turn" && <TurnTimeline snapshots={snapshots ?? []} />}
              {viewMode === "all" && (
                <CumulativeView snapshots={snapshots ?? []} threadId={activeThreadId ?? ""} />
              )}
              {viewMode === "commits" && <CommitsView />}
            </ScrollArea>
          )}
        </div>

        {/* Diff viewer: takes remaining space */}
        <DiffContent />
      </div>
    </div>
  );
}
