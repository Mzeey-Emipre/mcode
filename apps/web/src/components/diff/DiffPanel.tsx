import { useEffect, useState, useRef, useCallback } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useDiffStore } from "@/stores/diffStore";
import { getTransport } from "@/transport";
import { DiffToolbar } from "./DiffToolbar";
import { TurnTimeline } from "./TurnTimeline";
import { DiffContent } from "./DiffContent";
import { CumulativeView } from "./CumulativeView";
import { CommitsView } from "./CommitsView";
import { ScrollArea } from "@/components/ui/scroll-area";

const DEFAULT_BROWSER_PCT = 38;
const MIN_BROWSER_PCT = 15;
const MAX_BROWSER_PCT = 70;

/** Main diff panel with toolbar, resizable file browser, and diff viewer. */
export function DiffPanel() {
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const viewMode = useDiffStore((s) => s.viewMode);
  const snapshots = useDiffStore((s) =>
    activeThreadId ? s.snapshotsByThread[activeThreadId] : undefined,
  );
  const snapshotsLoading = useDiffStore((s) => s.snapshotsLoading);
  const setSnapshots = useDiffStore((s) => s.setSnapshots);
  const setSnapshotsLoading = useDiffStore((s) => s.setSnapshotsLoading);

  const [browserPct, setBrowserPct] = useState(DEFAULT_BROWSER_PCT);
  const containerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

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

  const onDividerMouseDown = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    const startY = e.clientY;
    const startPct = browserPct;

    const onMove = (moveEvent: MouseEvent) => {
      if (!draggingRef.current || !containerRef.current) return;
      const totalH = containerRef.current.getBoundingClientRect().height;
      if (totalH === 0) return;
      const deltaPct = ((moveEvent.clientY - startY) / totalH) * 100;
      setBrowserPct(
        Math.max(MIN_BROWSER_PCT, Math.min(MAX_BROWSER_PCT, startPct + deltaPct)),
      );
    };

    const onUp = () => {
      draggingRef.current = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [browserPct]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden min-h-0">
      <DiffToolbar />

      <div ref={containerRef} className="flex flex-1 flex-col overflow-hidden min-h-0">
        {/* File browser */}
        <div
          className="flex-none overflow-hidden"
          style={{ height: `${browserPct}%` }}
        >
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

        {/* Drag divider */}
        <div
          className="group relative flex-none cursor-row-resize select-none"
          onMouseDown={onDividerMouseDown}
        >
          <div className="h-px w-full bg-border/20" />
          {/* Grab affordance — widens hit area and shows drag hint */}
          <div className="absolute inset-x-0 -top-1 -bottom-1 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
            <div className="h-px w-8 rounded-full bg-muted-foreground/30" />
          </div>
        </div>

        {/* Diff viewer */}
        <DiffContent />
      </div>
    </div>
  );
}
