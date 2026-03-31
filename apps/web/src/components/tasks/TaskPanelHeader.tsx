import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { TaskItem } from "@/stores/taskStore";

/** Props for TaskPanelHeader. */
interface TaskPanelHeaderProps {
  /** All task items for the active thread, used to compute progress. */
  tasks: readonly TaskItem[];
  /** Called when the user clicks the close button. */
  onClose: () => void;
}

/**
 * Compact header bar for the task panel.
 * Displays a TASKS label, progress counter with state-aware color,
 * a close button, and a thin progress bar rule below the border.
 */
export function TaskPanelHeader({ tasks, onClose }: TaskPanelHeaderProps) {
  const completed = tasks.filter((t) => t.status === "completed").length;
  const total = tasks.length;
  const hasActive = tasks.some((t) => t.status === "in_progress");
  const allDone = total > 0 && completed === total;
  const pct = total > 0 ? (completed / total) * 100 : 0;

  return (
    <div className="flex-none border-b border-border/60">
      {/* Main row — matches chat header h-11 (44px) */}
      <div className="flex h-11 items-center justify-between px-3">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-semibold tracking-[0.1em] uppercase text-foreground/50">
            Tasks
          </span>
          {total > 0 && (
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
          )}
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onClose}
          className="h-5 w-5 text-muted-foreground/30 hover:text-foreground/70 hover:bg-transparent transition-colors duration-150"
          aria-label="Close task panel"
        >
          <X size={11} />
        </Button>
      </div>

      {/* Progress rule — sits on top of the border */}
      <div className="relative -mt-px h-px w-full bg-border/30">
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
