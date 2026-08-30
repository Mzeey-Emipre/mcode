import type { TaskItem } from "@/stores/taskStore";

/** Props for TaskPanelHeader. */
interface TaskPanelHeaderProps {
  /** All task items for the active thread, used to compute progress. */
  tasks: readonly TaskItem[];
}

function progressLabel(completed: number, cancelled: number, total: number): string {
  const settled = completed + cancelled;
  if (settled === total) {
    return cancelled > 0
      ? `All tasks settled: ${completed} completed, ${cancelled} cancelled`
      : "All tasks completed";
  }
  return cancelled > 0
    ? `${completed} completed, ${cancelled} cancelled, ${total - settled} remaining`
    : `${completed} of ${total} tasks completed`;
}

function TaskStatusVisualization({
  tasks,
  hasActive,
  percent,
}: {
  tasks: readonly TaskItem[];
  hasActive: boolean;
  percent: number;
}) {
  if (tasks.length > 24) {
    return (
      <div className="relative h-[3px] flex-1 rounded-full bg-border/30">
        <div
          className={`absolute inset-y-0 left-0 rounded-full transition-all duration-700 ease-out ${
            hasActive ? "bg-primary/65" : "bg-[var(--diff-add-strong)]/55"
          }`}
          style={{ width: `${percent}%` }}
        />
      </div>
    );
  }
  return (
    <div className="flex items-center gap-[3px]">
      {tasks.map((task, index) => (
        <span
          key={index}
          className={`h-[10px] w-[2px] rounded-[1px] transition-colors duration-300 ${
            task.status === "completed"
              ? "bg-[var(--diff-add-strong)]/65"
              : task.status === "in_progress"
                ? "bg-primary animate-pulse"
                : task.status === "cancelled"
                  ? "bg-muted-foreground/35"
                  : "bg-muted-foreground/20"
          }`}
        />
      ))}
    </div>
  );
}

/**
 * Compact progress header for the task panel.
 * Shows per-task status dots (completed/active/cancelled/pending) with a fraction counter.
 * Falls back to a progress bar when there are more than 24 tasks.
 *
 * Cancelled tasks count as "settled" alongside completed for the all-done /
 * progress calculation (a dropped task is no longer pending work), but render
 * with a distinct dimmed tick so the visual ledger still distinguishes them.
 */
export function TaskPanelHeader({ tasks }: TaskPanelHeaderProps) {
  const completed = tasks.filter((t) => t.status === "completed").length;
  const cancelled = tasks.filter((t) => t.status === "cancelled").length;
  const settled = completed + cancelled;
  const total = tasks.length;
  const hasActive = tasks.some((t) => t.status === "in_progress");
  const allDone = total > 0 && settled === total;
  const pct = total > 0 ? (settled / total) * 100 : 0;

  if (total === 0) return null;

  const label = progressLabel(completed, cancelled, total);

  return (
    <div className="flex-none border-b border-border/20 px-3 py-2.5">
      <div className="flex items-center gap-3">
        <span className="shrink-0 text-xs font-medium text-foreground/80">Tasks</span>
        {/* Task status visualization — slim ticks (vertical bars) read as a typographic ledger */}
        <div className="flex min-w-0 flex-1 items-center" aria-hidden>
          <TaskStatusVisualization tasks={tasks} hasActive={hasActive} percent={pct} />
        </div>

        {/* Fraction counter — typographic ratio with a soft slash */}
        <span
          className={`shrink-0 font-mono tabular-nums text-[10.5px] leading-none transition-colors duration-300 ${
            hasActive
              ? "text-primary/85"
              : allDone
                ? "text-[var(--diff-add-strong)]/75"
                : "text-muted-foreground/55"
          }`}
        >
          <span className="sr-only">{label}</span>
          <span aria-hidden="true">
            <span className="font-medium">{settled}</span>
            <span className="text-muted-foreground/30">/</span>
            {total}
          </span>
        </span>
      </div>
    </div>
  );
}
