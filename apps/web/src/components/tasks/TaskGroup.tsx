import { useEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { TaskItem as TaskItemType } from "@/stores/taskStore";
import { TaskItem } from "./TaskItem";

/** Props for TaskGroup. */
interface TaskGroupProps {
  /** Display name for the group (shown in the collapsible header). */
  name: string;
  /** Task items belonging to this group. */
  tasks: readonly TaskItemType[];
  /** When true, suppress the group header (single-group / ungrouped list). */
  hideHeader?: boolean;
}

/**
 * Collapsible group of tasks.
 * Fully-completed groups start collapsed; groups with active or pending tasks
 * start expanded. When hideHeader is set, renders a flat item list.
 */
export function TaskGroup({ name, tasks, hideHeader }: TaskGroupProps) {
  const completedCount = tasks.filter((t) => t.status === "completed").length;
  const hasActive = tasks.some((t) => t.status === "in_progress");
  const allDone = completedCount === tasks.length && tasks.length > 0;

  const [expanded, setExpanded] = useState(!allDone);
  // Track whether the user has manually toggled this group so we don't override their intent.
  const userToggledRef = useRef(false);
  const prevAllDoneRef = useRef(allDone);

  // Auto-collapse when a group transitions to fully-completed (unless user toggled it).
  useEffect(() => {
    if (allDone && !prevAllDoneRef.current && !userToggledRef.current) {
      setExpanded(false);
    }
    prevAllDoneRef.current = allDone;
  }, [allDone]);

  if (hideHeader) {
    return (
      <div className="py-0.5">
        {tasks.map((task) => (
          <TaskItem key={task.id} task={task} />
        ))}
      </div>
    );
  }

  return (
    <div>
      {/* Group header */}
      <button
        type="button"
        onClick={() => { userToggledRef.current = true; setExpanded((p) => !p); }}
        className="group flex w-full items-center gap-1.5 px-3 py-[5px] cursor-pointer hover:bg-muted/[0.06] transition-colors duration-100"
      >
        <ChevronRight
          size={9}
          className={`shrink-0 transition-transform duration-150 ${
            expanded ? "rotate-90" : ""
          } ${
            hasActive
              ? "text-primary/40"
              : allDone
                ? "text-muted-foreground/15"
                : "text-muted-foreground/25"
          }`}
        />
        <span
          className={`text-[10px] font-semibold tracking-[0.08em] uppercase transition-colors duration-150 ${
            hasActive
              ? "text-primary/60"
              : allDone
                ? "text-muted-foreground/25"
                : "text-muted-foreground/40"
          }`}
        >
          {name}
        </span>
        <span
          className={`ml-auto tabular-nums text-[10px] transition-colors duration-150 ${
            hasActive
              ? "text-primary/40"
              : allDone
                ? "text-muted-foreground/20"
                : "text-muted-foreground/30"
          }`}
        >
          {completedCount}/{tasks.length}
        </span>
      </button>

      {/* Smooth height collapse via CSS grid */}
      <div
        className="overflow-hidden transition-all duration-200 ease-out"
        style={{
          display: "grid",
          gridTemplateRows: expanded ? "1fr" : "0fr",
        }}
      >
        <div className="overflow-hidden min-h-0">
          {tasks.map((task) => (
            <TaskItem key={task.id} task={task} />
          ))}
        </div>
      </div>
    </div>
  );
}
