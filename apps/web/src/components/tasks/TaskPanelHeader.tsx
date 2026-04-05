import type { TaskItem } from "@/stores/taskStore";

/** Props for TaskPanelHeader. */
interface TaskPanelHeaderProps {
  /** All task items for the active thread, used to compute progress. */
  tasks: readonly TaskItem[];
}

/**
 * Compact progress header for the task panel.
 * Shows per-task status dots (completed/active/pending) with a fraction counter.
 * Falls back to a progress bar when there are more than 24 tasks.
 */
export function TaskPanelHeader({ tasks }: TaskPanelHeaderProps) {
  const completed = tasks.filter((t) => t.status === "completed").length;
  const total = tasks.length;
  const hasActive = tasks.some((t) => t.status === "in_progress");
  const allDone = total > 0 && completed === total;
  const pct = total > 0 ? (completed / total) * 100 : 0;

  if (total === 0) return null;

  const useDots = total <= 24;

  return (
    <div className="flex-none border-b border-border/20 px-3 py-2">
      <div className="flex items-center gap-2">
        {/* Task status visualization */}
        <div className="flex flex-1 min-w-0 items-center">
          {useDots ? (
            <div className="flex flex-wrap gap-[3px]">
              {tasks.map((task, i) => (
                <div
                  key={i}
                  className={`h-[5px] w-[5px] rounded-sm transition-colors duration-300 ${
                    task.status === "completed"
                      ? "bg-emerald-500/55"
                      : task.status === "in_progress"
                        ? "bg-primary/70 animate-pulse"
                        : "bg-muted-foreground/15"
                  }`}
                />
              ))}
            </div>
          ) : (
            <div className="relative h-1 flex-1 rounded-full bg-border/30">
              <div
                className={`absolute inset-y-0 left-0 rounded-full transition-all duration-700 ease-out ${
                  hasActive ? "bg-primary/60" : "bg-emerald-500/50"
                }`}
                style={{ width: `${pct}%` }}
              />
            </div>
          )}
        </div>

        {/* Fraction counter */}
        <span
          className={`shrink-0 font-mono tabular-nums text-[10px] font-medium leading-none transition-colors duration-300 ${
            hasActive
              ? "text-primary/80"
              : allDone
                ? "text-emerald-500/70"
                : "text-muted-foreground/40"
          }`}
        >
          {completed}/{total}
        </span>
      </div>
    </div>
  );
}
