import type { TaskItem } from "@/stores/taskStore";

/** Props for TaskPanelHeader. */
interface TaskPanelHeaderProps {
  /** All task items for the active thread, used to compute progress. */
  tasks: readonly TaskItem[];
}

/**
 * Compact progress bar for the task panel.
 * Displays a progress counter with state-aware color and a thin progress bar.
 */
export function TaskPanelHeader({ tasks }: TaskPanelHeaderProps) {
  const completed = tasks.filter((t) => t.status === "completed").length;
  const total = tasks.length;
  const hasActive = tasks.some((t) => t.status === "in_progress");
  const allDone = total > 0 && completed === total;
  const pct = total > 0 ? (completed / total) * 100 : 0;

  if (total === 0) return null;

  return (
    <div className="flex-none">
      <div className="flex items-center gap-1.5 px-3 pb-1">
        <span
          className={`tabular-nums text-[11px] font-medium leading-none transition-colors duration-300 ${
            hasActive
              ? "text-primary/80"
              : allDone
                ? "text-emerald-500/60"
                : "text-muted-foreground/40"
          }`}
        >
          {completed}/{total}
        </span>
      </div>
      <div className="relative h-px w-full bg-border/30">
        {total > 0 && (
          <div
            className={`absolute inset-y-0 left-0 h-full transition-all duration-700 ease-out ${
              hasActive ? "bg-primary/50" : "bg-emerald-500/40"
            }`}
            style={{ width: `${pct}%` }}
          />
        )}
      </div>
    </div>
  );
}
