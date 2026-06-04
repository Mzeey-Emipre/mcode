import { useCallback, useRef, useState } from "react";
import type { PlanRecord } from "@mcode/contracts";
import type { TaskItem } from "@/stores/taskStore";
import { usePlanStore } from "@/stores/planStore";
import { PlanPanel } from "./plan";
import { TaskPanelHeader } from "@/components/tasks/TaskPanelHeader";
import { TaskPanel } from "@/components/tasks/TaskPanel";

interface ScopeSplitPaneProps {
  threadId: string;
  parentTasks: readonly TaskItem[];
}

/** Minimum height for the task section in pixels. */
const TASKS_MIN_H = 80;
/** Minimum height for the plan section in pixels. */
const PLAN_MIN_H = 120;
/** Stable empty array so the planStore selector keeps a stable reference. */
const EMPTY_PLANS: readonly PlanRecord[] = [];

/**
 * Adaptive vertical dock for the Scope tab. The layout reflows so the top is
 * never left empty:
 *  - plan + tasks: resizable split (plan top, tasks bottom, draggable divider).
 *  - plan, no tasks: the plan fills the pane (no divider).
 *  - no plan (incl. empty): the tasks docket — or its empty state — fills the
 *    pane (no plan region, no divider).
 * "Generating" counts as having a plan so the skeleton owns the top.
 */
export function ScopeSplitPane({ threadId, parentTasks }: ScopeSplitPaneProps) {
  const plans = usePlanStore((s) => s.plansByThread[threadId] ?? EMPTY_PLANS);
  const isGenerating = usePlanStore((s) => s.generatingThreads.has(threadId));
  const hasPlan = plans.length > 0 || isGenerating;
  const hasTasks = parentTasks.length > 0;

  const containerRef = useRef<HTMLDivElement>(null);
  const [taskPct, setTaskPct] = useState(35);
  const draggingRef = useRef(false);

  const onDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      const container = containerRef.current;
      if (!container) return;

      const startY = e.clientY;
      const containerRect = container.getBoundingClientRect();
      const containerH = containerRect.height;
      const startTaskH = containerH * (taskPct / 100);

      const onMove = (ev: MouseEvent) => {
        if (!draggingRef.current) return;
        const deltaY = ev.clientY - startY;
        const newTaskH = Math.max(
          TASKS_MIN_H,
          Math.min(containerH - PLAN_MIN_H, startTaskH - deltaY),
        );
        setTaskPct((newTaskH / containerH) * 100);
      };

      const onUp = () => {
        draggingRef.current = false;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
    },
    [taskPct],
  );

  const onDoubleClick = useCallback(() => {
    setTaskPct(35);
  }, []);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    const step = 5;
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setTaskPct((p) => Math.min(90, p + step));
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setTaskPct((p) => Math.max(10, p - step));
    }
  }, []);

  // No plan: the docket (or its empty state) fills the pane. The header only
  // shows when there are tasks so the empty state reads as a single centered
  // glyph rather than "0 tasks" chrome over a void.
  if (!hasPlan) {
    return (
      <div className="flex flex-1 flex-col min-h-0">
        {hasTasks && <TaskPanelHeader tasks={parentTasks} />}
        <TaskPanel />
      </div>
    );
  }

  // Plan but no tasks: the plan fills the pane, no divider.
  if (!hasTasks) {
    return (
      <div className="flex flex-1 flex-col min-h-0">
        <div className="flex min-h-0 flex-1 basis-0 flex-col overflow-hidden">
          <PlanPanel threadId={threadId} />
        </div>
      </div>
    );
  }

  // Plan + tasks: the resizable split.
  return (
    <div ref={containerRef} className="flex flex-1 flex-col min-h-0">
      <div className="flex min-h-0 flex-1 basis-0 flex-col overflow-hidden">
        <PlanPanel threadId={threadId} />
      </div>

      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize plan and tasks sections"
        tabIndex={0}
        onMouseDown={onDragStart}
        onDoubleClick={onDoubleClick}
        onKeyDown={onKeyDown}
        className="group flex h-[9px] flex-shrink-0 cursor-row-resize items-center justify-center border-y border-border/50 bg-background transition-colors hover:bg-accent/50"
      >
        <div className="h-[2px] w-8 rounded-full bg-muted-foreground/20 transition-colors group-hover:bg-muted-foreground/40" />
      </div>

      <div
        className="flex flex-col flex-shrink-0 overflow-hidden"
        style={{ height: `${taskPct}%`, minHeight: TASKS_MIN_H }}
      >
        <TaskPanelHeader tasks={parentTasks} />
        <TaskPanel />
      </div>
    </div>
  );
}
