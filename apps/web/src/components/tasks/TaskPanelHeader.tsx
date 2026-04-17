import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
    <div className="flex-none border-b border-border/20 px-3 py-2.5">
      <div className="flex items-center gap-3">
        {/* Task status visualization — slim ticks (vertical bars) read as a typographic ledger */}
        <div className="flex flex-1 min-w-0 items-center">
          {useDots ? (
            <div className="flex items-center gap-[3px]">
              {tasks.map((task, i) => (
                <span
                  key={i}
                  className={`h-[10px] w-[2px] rounded-[1px] transition-colors duration-300 ${
                    task.status === "completed"
                      ? "bg-[var(--diff-add-strong)]/65"
                      : task.status === "in_progress"
                        ? "bg-primary animate-pulse"
                        : "bg-muted-foreground/20"
                  }`}
                />
              ))}
            </div>
          ) : (
            <div className="relative h-[3px] flex-1 rounded-full bg-border/30">
              <div
                className={`absolute inset-y-0 left-0 rounded-full transition-all duration-700 ease-out ${
                  hasActive ? "bg-primary/65" : "bg-[var(--diff-add-strong)]/55"
                }`}
                style={{ width: `${pct}%` }}
              />
            </div>
          )}
        </div>

        {/* Fraction counter — typographic ratio with a soft slash */}
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                className={`shrink-0 font-mono tabular-nums text-[10.5px] leading-none transition-colors duration-300 cursor-help ${
                  hasActive
                    ? "text-primary/85"
                    : allDone
                      ? "text-[var(--diff-add-strong)]/75"
                      : "text-muted-foreground/55"
                }`}
              >
                <span className="font-medium">{completed}</span>
                <span className="text-muted-foreground/30">/</span>
                {total}
              </span>
            }
          />
          <TooltipContent side="top" className="text-xs">
            {allDone ? "All tasks completed" : `${completed} of ${total} tasks completed`}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
