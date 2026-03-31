import { memo } from "react";
import { Check } from "lucide-react";
import type { TaskItem as TaskItemType } from "@/stores/taskStore";

/**
 * Single task row. Status is communicated through icon shape, color, and
 * background — never through strikethrough or spinners alone.
 */
export const TaskItem = memo(function TaskItem({ task }: { task: TaskItemType }) {
  const isActive = task.status === "in_progress";
  const isDone = task.status === "completed";
  const isPending = task.status === "pending";

  return (
    <div
      className={`relative flex items-start gap-2.5 px-3 py-[7px] text-[11px] leading-[1.5] transition-colors duration-150 ${
        isActive
          ? "bg-primary/[0.05]"
          : isDone
            ? "hover:bg-muted/[0.06]"
            : "hover:bg-muted/[0.08]"
      } ${
        isDone
          ? "text-muted-foreground/40"
          : isActive
            ? "text-foreground/95"
            : "text-foreground/55"
      }`}
    >
      {/* Active left accent — a crisp vertical rule */}
      {isActive && (
        <div className="absolute left-0 top-1.5 bottom-1.5 w-[2px] bg-primary rounded-r-full" />
      )}

      {/* Status icon column — fixed 14px wide */}
      <div className="mt-[1px] shrink-0 flex h-[14px] w-[14px] items-center justify-center">
        {isDone && (
          /* Completed: filled square badge with checkmark */
          <div className="flex h-[13px] w-[13px] items-center justify-center rounded-[3px] bg-emerald-500/[0.15]">
            <Check
              size={8}
              strokeWidth={2.5}
              className="text-emerald-500/70"
            />
          </div>
        )}

        {isActive && (
          /* Active: pulsing ring + solid core dot */
          <div className="relative flex h-[14px] w-[14px] items-center justify-center">
            <div className="absolute h-[10px] w-[10px] animate-ping rounded-full bg-primary/20" style={{ animationDuration: "1.8s" }} />
            <div className="h-[6px] w-[6px] rounded-full bg-primary" />
          </div>
        )}

        {isPending && (
          /* Pending: hollow square — clearly "queued", not "absent" */
          <div className="h-[10px] w-[10px] rounded-[2.5px] border border-muted-foreground/[0.22]" />
        )}
      </div>

      {/* Label */}
      <span
        className={`min-w-0 flex-1 ${
          isActive ? "font-[500]" : isDone ? "font-[400]" : "font-[400]"
        }`}
      >
        {isActive ? (task.activeForm ?? task.content) : task.content}
      </span>
    </div>
  );
});
