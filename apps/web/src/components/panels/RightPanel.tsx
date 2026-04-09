import type { MouseEvent as ReactMouseEvent } from "react";
import { useCallback, useEffect, useRef } from "react";
import { ListChecks, Diff, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useTaskStore } from "@/stores/taskStore";
import { useDiffStore, PANEL_MIN_WIDTH, PANEL_DEFAULT_WIDTH, PANEL_WIDE_WIDTH } from "@/stores/diffStore";
import { TaskPanel } from "@/components/tasks/TaskPanel";
import { TaskPanelHeader } from "@/components/tasks/TaskPanelHeader";
import { DiffPanel } from "@/components/diff";

/** Right-side panel with tabs for Tasks and Changes. */
export function RightPanel() {
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const panelVisible = useDiffStore((s) => s.panelVisible);
  const activeTab = useDiffStore((s) => s.activeTab);
  const panelWidth = useDiffStore((s) => s.panelWidth);
  const setPanelWidth = useDiffStore((s) => s.setPanelWidth);
  const setActiveTab = useDiffStore((s) => s.setActiveTab);
  const hidePanel = useDiffStore((s) => s.hidePanel);
  const tasks = useTaskStore(
    (s) => (activeThreadId ? s.tasksByThread[activeThreadId] : undefined),
  );

  const draggingRef = useRef(false);
  const dragListenersRef = useRef<{ move: (e: globalThis.MouseEvent) => void; up: () => void } | null>(null);
  // Ref keeps the latest panelWidth readable inside the resize handler without
  // the handler needing to be re-registered on every width change.
  const panelWidthRef = useRef(panelWidth);
  useEffect(() => { panelWidthRef.current = panelWidth; }, [panelWidth]);

  // Re-clamp stored width when the window is resized so the panel never
  // exceeds the available space after the user shrinks the browser.
  // Registered once on mount; reads panelWidthRef to avoid a stale closure.
  // Throttled with rAF so rapid resize events only trigger one recalculation per frame.
  useEffect(() => {
    // Clamp immediately on mount in case the stored width already exceeds the viewport.
    const maxAllowed = window.innerWidth - PANEL_MIN_WIDTH;
    if (panelWidthRef.current > maxAllowed) setPanelWidth(maxAllowed);

    let rafId: number | null = null;
    const onResize = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        const max = window.innerWidth - PANEL_MIN_WIDTH;
        if (panelWidthRef.current > max) setPanelWidth(max);
      });
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [setPanelWidth]);

  const onDragStart = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      const startX = e.clientX;
      const startWidth = panelWidth;

      const onMouseMove = (moveEvent: globalThis.MouseEvent) => {
        if (!draggingRef.current) return;
        const delta = startX - moveEvent.clientX;
        // Always leave at least PANEL_MIN_WIDTH px for the chat area
        const viewportCap = window.innerWidth - PANEL_MIN_WIDTH;
        setPanelWidth(Math.min(startWidth + delta, viewportCap));
      };

      const onMouseUp = () => {
        draggingRef.current = false;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        dragListenersRef.current = null;
      };

      dragListenersRef.current = { move: onMouseMove, up: onMouseUp };
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [panelWidth, setPanelWidth],
  );

  useEffect(() => {
    return () => {
      if (dragListenersRef.current) {
        document.removeEventListener("mousemove", dragListenersRef.current.move);
        document.removeEventListener("mouseup", dragListenersRef.current.up);
        dragListenersRef.current = null;
      }
      draggingRef.current = false;
    };
  }, []);

  if (!panelVisible || !activeThreadId) return null;

  return (
    <div
      style={{ width: panelWidth, minWidth: PANEL_MIN_WIDTH, maxWidth: `calc(100vw - ${PANEL_MIN_WIDTH}px)` }}
      className="relative flex flex-col border-l border-border bg-background/95"
    >
      {/* Drag handle (left edge) — double-click snaps between default and wide */}
      <div
        role="separator"
        aria-orientation="vertical"
        tabIndex={0}
        className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize z-10
                   hover:bg-primary/25 active:bg-primary/40 focus-visible:bg-primary/25 transition-colors duration-150"
        onMouseDown={onDragStart}
        onDoubleClick={() => {
          const viewportCap = window.innerWidth - PANEL_MIN_WIDTH;
          const target = panelWidth >= PANEL_WIDE_WIDTH
            ? PANEL_DEFAULT_WIDTH
            : Math.min(PANEL_WIDE_WIDTH, viewportCap);
          setPanelWidth(Math.max(PANEL_MIN_WIDTH, target));
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            const viewportCap = window.innerWidth - PANEL_MIN_WIDTH;
            const target = panelWidth >= PANEL_WIDE_WIDTH
              ? PANEL_DEFAULT_WIDTH
              : Math.min(PANEL_WIDE_WIDTH, viewportCap);
            setPanelWidth(Math.max(PANEL_MIN_WIDTH, target));
          }
        }}
      />

      {/* Tab header */}
      <div className="flex-none border-b border-border/60">
        <div className="flex h-11 items-center justify-between px-3">
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => setActiveTab("tasks")}
              className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px] font-semibold tracking-[0.1em] uppercase transition-colors ${
                activeTab === "tasks"
                  ? "text-foreground bg-muted/50"
                  : "text-foreground/70 hover:text-foreground"
              }`}
            >
              <ListChecks size={12} />
              Tasks
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("changes")}
              className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px] font-semibold tracking-[0.1em] uppercase transition-colors ${
                activeTab === "changes"
                  ? "text-foreground bg-muted/50"
                  : "text-foreground/70 hover:text-foreground"
              }`}
            >
              <Diff size={12} />
              Changes
            </button>
          </div>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={hidePanel}
            className="h-5 w-5 text-muted-foreground/70 hover:text-foreground hover:bg-transparent transition-colors duration-150"
            aria-label="Close panel"
          >
            <X size={11} />
          </Button>
        </div>
      </div>

      {/* Tab content */}
      {activeTab === "tasks" && (
        <>
          <TaskPanelHeader tasks={tasks ?? []} />
          <TaskPanel />
        </>
      )}
      {activeTab === "changes" && <DiffPanel />}
    </div>
  );
}
