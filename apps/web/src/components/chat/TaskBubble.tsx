import { useState } from "react";
import type { TaskItem } from "@/stores/taskStore";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TaskItem as TaskRow } from "@/components/tasks/TaskItem";
import { TaskPanelHeader } from "@/components/tasks/TaskPanelHeader";

/** Aggregate status displayed by the composer Task bubble. */
export type TaskAggregateStatus = "active" | "completed" | "pending" | "mixed";

/** Return the aggregate status for a non-empty parent-agent task list. */
export function getTaskAggregateStatus(tasks: readonly Pick<TaskItem, "status">[]): TaskAggregateStatus | null {
  if (tasks.length === 0) return null;
  if (tasks.some((task) => task.status === "in_progress")) return "active";
  if (tasks.every((task) => task.status === "completed" || task.status === "cancelled")) {
    return "completed";
  }
  if (tasks.every((task) => task.status === "pending")) return "pending";
  return "mixed";
}

function settledCount(tasks: readonly Pick<TaskItem, "status">[]): number {
  return tasks.filter((task) => task.status === "completed" || task.status === "cancelled").length;
}

function ProgressCircle({
  settled,
  total,
  status,
}: {
  settled: number;
  total: number;
  status: TaskAggregateStatus;
}) {
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  const progress = total > 0 ? Math.min(1, Math.max(0, settled / total)) : 0;
  const dashOffset = circumference * (1 - progress);
  const progressClass =
    status === "completed"
      ? "stroke-[var(--diff-add-strong)]"
      : status === "pending"
        ? "stroke-muted-foreground/30"
        : "stroke-primary";

  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      className="shrink-0 -rotate-90"
      aria-hidden
      data-testid="task-progress-circle"
    >
      <circle
        cx="8"
        cy="8"
        r={radius}
        fill="none"
        strokeWidth="2"
        className="stroke-muted-foreground/20"
      />
      <circle
        cx="8"
        cy="8"
        r={radius}
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={dashOffset}
        className={progressClass}
      />
    </svg>
  );
}

/** Composer-adjacent parent-agent task bubble. */
export function TaskBubble({ tasks }: { tasks: readonly TaskItem[] }) {
  const [expanded, setExpanded] = useState(false);
  const aggregate = getTaskAggregateStatus(tasks);
  if (!aggregate) return null;

  const settled = settledCount(tasks);
  const total = tasks.length;

  return (
    <div className="relative w-fit max-w-full">
      {expanded && (
        <div
          data-testid="task-bubble-expanded"
          className="absolute bottom-full left-1/2 z-30 mb-2 flex w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-border/70 bg-popover shadow-xl shadow-black/25"
        >
          <TaskPanelHeader tasks={tasks} />
          <ScrollArea
            className="max-h-[min(18rem,calc(100vh-14rem))] min-h-0 overflow-hidden"
            viewportClassName="max-h-[min(18rem,calc(100vh-14rem))] overflow-x-hidden overflow-y-auto scroll-py-2"
          >
            <div className="py-2 pb-3 pr-2">
              {tasks.map((task) => (
                <TaskRow key={task.id} task={task} />
              ))}
            </div>
          </ScrollArea>
        </div>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid="task-bubble"
        aria-expanded={expanded}
        aria-label={`${settled} of ${total} tasks settled`}
        onClick={() => setExpanded((value) => !value)}
        className="h-8 gap-2 rounded-full bg-card/75 px-3"
      >
        <ProgressCircle settled={settled} total={total} status={aggregate} />
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {settled}/{total} steps
        </span>
      </Button>
    </div>
  );
}
