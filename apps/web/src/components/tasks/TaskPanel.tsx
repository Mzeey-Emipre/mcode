import type { MouseEvent as ReactMouseEvent } from "react";
import { useCallback, useMemo, useRef } from "react";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useTaskStore, MIN_WIDTH, MAX_WIDTH } from "@/stores/taskStore";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TaskPanelHeader } from "./TaskPanelHeader";
import { TaskGroup } from "./TaskGroup";

/** Right-side task panel showing grouped task progress with drag-to-resize. */
export function TaskPanel() {
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const panelVisible = useTaskStore((s) => s.panelVisible);
  const panelWidth = useTaskStore((s) => s.panelWidth);
  const hidePanel = useTaskStore((s) => s.hidePanel);
  const setPanelWidth = useTaskStore((s) => s.setPanelWidth);

  const tasks = useTaskStore(
    (s) => (activeThreadId ? s.tasksByThread[activeThreadId] : undefined),
  );

  const draggingRef = useRef(false);

  // Drag handle for horizontal resizing (left edge)
  const onDragStart = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      const startX = e.clientX;
      const startWidth = panelWidth;

      const onMouseMove = (moveEvent: globalThis.MouseEvent) => {
        if (!draggingRef.current) return;
        // Dragging left edge: moving left increases width
        const delta = startX - moveEvent.clientX;
        setPanelWidth(startWidth + delta);
      };

      const onMouseUp = () => {
        draggingRef.current = false;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [panelWidth, setPanelWidth],
  );

  // Group tasks by their group field, preserving insertion order
  const groups = useMemo(() => {
    if (!tasks) return [];
    const map = new Map<string, (typeof tasks)[number][]>();
    for (const task of tasks) {
      const list = map.get(task.group) ?? [];
      list.push(task);
      map.set(task.group, list);
    }
    return Array.from(map.entries());
  }, [tasks]);

  if (!panelVisible || !activeThreadId) {
    return null;
  }

  const hasTasks = tasks && tasks.length > 0;

  return (
    <div
      style={{ width: panelWidth, minWidth: MIN_WIDTH, maxWidth: MAX_WIDTH }}
      className="relative flex flex-col border-l border-border bg-background/95"
    >
      {/* Drag handle (left edge) */}
      <div
        className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-muted-foreground/20 z-10"
        onMouseDown={onDragStart}
      />

      <TaskPanelHeader tasks={tasks ?? []} onClose={hidePanel} />

      {hasTasks ? (
        <ScrollArea className="flex-1">
          <div className="flex flex-col py-1">
            {groups.map(([name, items]) => (
              <TaskGroup
                key={name}
                name={name}
                tasks={items}
                hideHeader={groups.length === 1 && name === "Tasks"}
              />
            ))}
          </div>
        </ScrollArea>
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-xs text-muted-foreground/40">
            No tasks yet
          </p>
        </div>
      )}
    </div>
  );
}
