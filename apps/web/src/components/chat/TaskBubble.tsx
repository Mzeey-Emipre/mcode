import { useEffect, useRef, useState } from "react";
import type { TaskItem } from "@/stores/taskStore";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TaskItem as TaskRow } from "@/components/tasks/TaskItem";
import { TaskPanelHeader } from "@/components/tasks/TaskPanelHeader";
import type { TurnFileEffectSummary } from "@mcode/contracts";
import { FileEffectFacts } from "./FileEffectFacts";

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
export function TaskBubble({
  tasks,
  fileEffects,
}: {
  tasks: readonly TaskItem[];
  fileEffects?: TurnFileEffectSummary;
}) {
  const [hoverOpen, setHoverOpen] = useState(false);
  const [focusOpen, setFocusOpen] = useState(false);
  const [pinnedOpen, setPinnedOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerDownRef = useRef(false);
  const suppressFocusOpenRef = useRef(false);
  const expanded = hoverOpen || focusOpen || pinnedOpen;
  useEffect(() => () => {
    if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current);
  }, []);
  useEffect(() => {
    if (!expanded) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (closeTimerRef.current !== null) {
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
      setHoverOpen(false);
      setFocusOpen(false);
      setPinnedOpen(false);
      suppressFocusOpenRef.current = document.activeElement != null
        && Boolean(triggerRef.current?.contains(document.activeElement)
          || panelRef.current?.contains(document.activeElement));
    };
    document.addEventListener("keydown", handleEscape, true);
    return () => document.removeEventListener("keydown", handleEscape, true);
  }, [expanded]);
  const aggregate = getTaskAggregateStatus(tasks);
  if (!aggregate) return null;

  const settled = settledCount(tasks);
  const total = tasks.length;
  const cancelScheduledClose = () => {
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  const openFromPointer = () => {
    cancelScheduledClose();
    setHoverOpen(true);
  };

  const closeAfterPointerLeaves = () => {
    cancelScheduledClose();
    closeTimerRef.current = setTimeout(() => {
      setHoverOpen(false);
      closeTimerRef.current = null;
    }, 100);
  };

  const handleBlur = (event: React.FocusEvent<HTMLElement>) => {
    const next = event.relatedTarget as Node | null;
    if (next && (triggerRef.current?.contains(next) || panelRef.current?.contains(next))) return;
    suppressFocusOpenRef.current = false;
    setFocusOpen(false);
  };

  const closePreview = () => {
    cancelScheduledClose();
    setHoverOpen(false);
    setFocusOpen(false);
    setPinnedOpen(false);
    suppressFocusOpenRef.current = document.activeElement != null
      && Boolean(triggerRef.current?.contains(document.activeElement)
        || panelRef.current?.contains(document.activeElement));
  };

  return (
    <Popover
      open={expanded}
      onOpenChange={(open, eventDetails) => {
        if (open || (
          eventDetails.reason === "trigger-press"
          && hoverOpen
          && !pinnedOpen
        )) {
          setPinnedOpen(true);
        } else {
          closePreview();
        }
      }}
    >
      <div className="w-fit max-w-full">
        <PopoverTrigger
          render={
            <Button
              ref={triggerRef}
              type="button"
              variant="outline"
              size="sm"
              data-testid="task-bubble"
              aria-label={`${settled} of ${total} tasks settled${fileEffects?.fileCount ? `, ${fileEffects.fileCount} ${fileEffects.fileCount === 1 ? "file" : "files"} changed, ${fileEffects.additions} lines added, ${fileEffects.deletions} lines removed` : ""}`}
              onPointerDown={() => {
                pointerDownRef.current = true;
                suppressFocusOpenRef.current = false;
                queueMicrotask(() => { pointerDownRef.current = false; });
              }}
              onPointerEnter={(event) => {
                if (event.pointerType !== "touch") openFromPointer();
              }}
              onPointerLeave={(event) => {
                if (event.pointerType !== "touch") closeAfterPointerLeaves();
              }}
              onFocus={() => {
                if (!pointerDownRef.current && !suppressFocusOpenRef.current) setFocusOpen(true);
              }}
              onBlur={handleBlur}
              onKeyDown={(event) => {
                if (event.key === "Escape") closePreview();
              }}
              className="h-8 gap-2 rounded-full bg-card/75 px-3 focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <ProgressCircle settled={settled} total={total} status={aggregate} />
              <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap font-mono text-xs tabular-nums text-muted-foreground">
                {settled}/{total} steps
                {fileEffects && <FileEffectFacts summary={fileEffects} />}
              </span>
            </Button>
          }
        />
        <PopoverContent
          ref={panelRef}
          data-testid="task-bubble-expanded"
          align="center"
          side="top"
          sideOffset={8}
          collisionPadding={16}
          collisionAvoidance={{ side: "flip", align: "shift", fallbackAxisSide: "none" }}
          onPointerEnter={(event) => {
            if (event.pointerType !== "touch") openFromPointer();
          }}
          onPointerLeave={(event) => {
            if (event.pointerType !== "touch") closeAfterPointerLeaves();
          }}
          onFocusCapture={() => setFocusOpen(true)}
          onBlurCapture={handleBlur}
          onKeyDown={(event) => {
            if (event.key === "Escape") closePreview();
          }}
          className="flex max-h-(--available-height) w-[min(40rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border-border/70 p-0 shadow-lg shadow-black/20"
        >
          <TaskPanelHeader tasks={tasks} />
          <ScrollArea
            className="min-h-0 max-h-[calc(var(--available-height)-3.25rem)] flex-1 overflow-hidden"
            viewportClassName="max-h-[calc(var(--available-height)-3.25rem)] overflow-x-hidden overflow-y-auto scroll-py-2"
            viewportProps={{ tabIndex: 0, "aria-label": "Task list" }}
          >
            <ul className="m-0 list-none py-2 pb-3 pr-2" aria-label="Tasks">
              {tasks.map((task) => (
                <TaskRow key={task.id} task={task} />
              ))}
            </ul>
          </ScrollArea>
        </PopoverContent>
      </div>
    </Popover>
  );
}
