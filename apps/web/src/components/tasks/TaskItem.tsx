import { memo } from "react";
import { Check } from "lucide-react";
import type { TaskItem as TaskItemType } from "@/stores/taskStore";

/**
 * Single task row. Status is communicated through the leading status mark plus
 * row tint and text weight — no decorative side-stripe accent.
 */
export const TaskItem = memo(function TaskItem({ task }: { task: TaskItemType }) {
  const isActive = task.status === "in_progress";
  const isDone = task.status === "completed";
  const isPending = task.status === "pending";

  return (
    <div
      className={`flex items-start gap-2.5 px-3 py-[7px] text-[11.5px] leading-[1.5] transition-colors duration-150 ${
        isActive
          ? "bg-primary/[0.06]"
          : isDone
            ? "hover:bg-muted/[0.06]"
            : "hover:bg-muted/[0.08]"
      } ${
        isDone
          ? "text-muted-foreground/45"
          : isActive
            ? "text-foreground/95"
            : "text-foreground/60"
      }`}
    >
      {/* Status mark — fixed 14px column */}
      <div className="mt-[2px] shrink-0 flex h-[14px] w-[14px] items-center justify-center">
        {isDone && (
          <Check
            size={11}
            strokeWidth={2.25}
            className="text-[var(--diff-add-strong)]"
            aria-label="Completed"
          />
        )}

        {isActive && (
          /* Active: a quietly pulsing concentric mark */
          <span className="relative inline-flex h-[12px] w-[12px] items-center justify-center" aria-label="In progress">
            <span
              className="absolute inset-0 rounded-full bg-primary/25 animate-ping"
              style={{ animationDuration: "1.8s" }}
            />
            <span className="relative h-[6px] w-[6px] rounded-full bg-primary" />
          </span>
        )}

        {isPending && (
          /* Pending: a quiet open ring */
          <span
            className="h-[10px] w-[10px] rounded-full border border-muted-foreground/30"
            aria-label="Pending"
          />
        )}
      </div>

      {/* Label */}
      <span className={`min-w-0 flex-1 ${isActive ? "font-medium" : "font-normal"}`}>
        {isActive ? (task.activeForm ?? task.content) : task.content}
      </span>
    </div>
  );
});
