import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from "react";
import { createPortal } from "react-dom";
import {
  CircleCheck,
  CircleX,
  MinusCircle,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CI_ICON_STROKE } from "@/lib/ci-status";
import type { ChecksStatus, CheckRun } from "@mcode/contracts";

/** Props for {@link ChecksPopover}. */
interface ChecksPopoverProps {
  /** Latest CI check status to display. */
  checks: ChecksStatus;
  /** Trigger element rendered as the CI summary row. */
  children: ReactElement;
  /** Controlled open state. */
  open?: boolean;
  /** Called when the local flyout open state should change. */
  onOpenChange?: (open: boolean) => void;
}

interface CheckRunVisual {
  icon?: LucideIcon;
  iconClassName: string;
  label: string;
  labelClassName: string;
  spinning?: boolean;
}

interface FlyoutPosition {
  left: number;
  top: number;
}

const FLYOUT_WIDTH = 356;
const FLYOUT_MAX_HEIGHT = 320;
const FLYOUT_GAP = 8;
const VIEWPORT_PADDING = 8;

function getRunVisual(run: CheckRun): CheckRunVisual {
  if (run.status !== "completed") {
    return {
      iconClassName: "text-primary",
      label: "Running",
      labelClassName: "text-muted-foreground",
      spinning: true,
    };
  }

  switch (run.conclusion) {
    case "success":
      return {
        icon: CircleCheck,
        iconClassName: "text-[var(--diff-add-strong)]",
        label: "Succeeded",
        labelClassName: "text-muted-foreground",
      };
    case "failure":
    case "timed_out":
      return {
        icon: CircleX,
        iconClassName: "text-[var(--diff-remove-strong)]",
        label: "Failed",
        labelClassName: "text-muted-foreground",
      };
    default:
      return {
        icon: MinusCircle,
        iconClassName: "text-muted-foreground/80",
        label: run.conclusion ? run.conclusion.replace(/_/g, " ") : "Completed",
        labelClassName: "text-muted-foreground",
      };
  }
}

/** Format a duration in milliseconds to a compact human-readable string. */
function formatDuration(ms: number): string {
  if (ms < 1000) return "<1s";
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  return remainSecs > 0 ? `${mins}m ${remainSecs}s` : `${mins}m`;
}

function getMeasuredTrigger(trigger: HTMLElement): HTMLElement {
  return trigger.firstElementChild instanceof HTMLElement
    ? trigger.firstElementChild
    : trigger;
}

function calculateFlyoutPosition(trigger: HTMLElement): FlyoutPosition {
  const rect = getMeasuredTrigger(trigger).getBoundingClientRect();
  const canOpenRight =
    rect.right + FLYOUT_GAP + FLYOUT_WIDTH + VIEWPORT_PADDING <= window.innerWidth;
  const preferredLeft = canOpenRight
    ? rect.right + FLYOUT_GAP
    : rect.left - FLYOUT_GAP - FLYOUT_WIDTH;
  const left = Math.max(
    VIEWPORT_PADDING,
    Math.min(preferredLeft, window.innerWidth - FLYOUT_WIDTH - VIEWPORT_PADDING),
  );
  const top = Math.max(
    VIEWPORT_PADDING,
    Math.min(rect.top, window.innerHeight - FLYOUT_MAX_HEIGHT - VIEWPORT_PADDING),
  );
  return { left, top };
}

/**
 * Flat CI job flyout anchored to the Overview CI summary row.
 */
export function ChecksPopover({
  checks,
  children,
  open,
  onOpenChange,
}: ChecksPopoverProps) {
  const triggerRef = useRef<HTMLDivElement | null>(null);
  const flyoutRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<FlyoutPosition | null>(null);

  const sortedRuns = useMemo(() => {
    const priority = (run: CheckRun): number => {
      if (run.status !== "completed") return 0;
      if (run.conclusion === "success") return 1;
      if (run.conclusion === "failure" || run.conclusion === "timed_out") return -1;
      return 2;
    };
    return [...checks.runs].sort((a, b) => priority(a) - priority(b));
  }, [checks.runs]);

  const updatePosition = useCallback(() => {
    if (!triggerRef.current) return;
    setPosition(calculateFlyoutPosition(triggerRef.current));
  }, []);

  useEffect(() => {
    if (!open) return;
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;

    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (triggerRef.current?.contains(target) || flyoutRef.current?.contains(target)) return;
      onOpenChange?.(false);
    };

    document.addEventListener("pointerdown", closeOnOutsidePointerDown);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointerDown);
    };
  }, [onOpenChange, open]);

  const flyoutStyle: CSSProperties | undefined = position
    ? { left: position.left, top: position.top, width: FLYOUT_WIDTH }
    : undefined;
  const flyout =
    open && position ? (
      <div
        role="dialog"
        data-testid="thread-overview-ci-popover"
        ref={flyoutRef}
        style={flyoutStyle}
        className="fixed z-50 overflow-hidden rounded-lg border border-border bg-popover p-0 text-popover-foreground shadow-xl"
      >
        <div className="max-h-[320px] overflow-y-auto py-1 scrollbar-on-hover">
          {sortedRuns.length > 0 ? (
            sortedRuns.map((run, index) => (
              <RunRow key={`${run.name}-${index}`} run={run} />
            ))
          ) : (
            <div className="px-4 py-3 text-xs text-muted-foreground">No checks configured</div>
          )}
        </div>
      </div>
    ) : null;

  return (
    <>
      <div ref={triggerRef} className="w-full">
        {children}
      </div>

      {flyout ? createPortal(flyout, document.body) : null}
    </>
  );
}

/** Single CI run row in the flat Codex-style job list. */
function RunRow({ run }: { run: CheckRun }) {
  const visual = getRunVisual(run);
  const Icon = visual.icon;
  const title =
    run.durationMs != null && run.status === "completed"
      ? `${visual.label} in ${formatDuration(run.durationMs)}`
      : visual.label;

  return (
    <Tooltip>
      <TooltipTrigger
        render={<div className="flex h-[30px] min-h-[30px] items-center gap-2 px-3.5 text-sm" />}
      >
        {visual.spinning ? (
          <Spinner size={16} className={visual.iconClassName} />
        ) : Icon ? (
          <Icon
            size={16}
            strokeWidth={CI_ICON_STROKE}
            className={cn("shrink-0", visual.iconClassName)}
          />
        ) : null}
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">
          {run.name}
        </span>
        <span className={cn("shrink-0 text-xs", visual.labelClassName)}>
          {visual.label}
        </span>
      </TooltipTrigger>
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  );
}
