import type { MouseEvent as ReactMouseEvent } from "react";
import { useCallback, useEffect, useRef } from "react";
import { ListChecks, Diff, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useTaskStore } from "@/stores/taskStore";
import { useDiffStore, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH } from "@/stores/diffStore";
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

  const onDragStart = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      const startX = e.clientX;
      const startWidth = panelWidth;

      const onMouseMove = (moveEvent: globalThis.MouseEvent) => {
        if (!draggingRef.current) return;
        const delta = startX - moveEvent.clientX;
        setPanelWidth(startWidth + delta);
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
      style={{ width: panelWidth, minWidth: PANEL_MIN_WIDTH, maxWidth: PANEL_MAX_WIDTH }}
      className="relative flex flex-col border-l border-border bg-background/95"
    >
      {/* Drag handle (left edge) */}
      <div
        className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-muted-foreground/20 z-10"
        onMouseDown={onDragStart}
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
                  ? "text-foreground/70 bg-muted/50"
                  : "text-foreground/30 hover:text-foreground/50"
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
                  ? "text-foreground/70 bg-muted/50"
                  : "text-foreground/30 hover:text-foreground/50"
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
            className="h-5 w-5 text-muted-foreground/30 hover:text-foreground/70 hover:bg-transparent transition-colors duration-150"
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
