import { useEffect, useState } from "react";
import { Goal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { GoalState } from "@mcode/contracts";
import { isGoalOpen } from "@mcode/contracts";
import { useActiveGoalActions } from "./useActiveGoalActions";

/** Props for the compact active-goal control above the composer. */
export interface ActiveGoalChipProps {
  threadId: string;
  goal: GoalState | null | undefined;
}

function goalTimestampMs(value: number): number {
  return value < 1_000_000_000_000 ? value * 1000 : value;
}

function formatGoalElapsed(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  if (safe < 60) return `${safe}s`;
  const minutes = Math.floor(safe / 60);
  const remainingSeconds = safe % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

function formatGoalDate(value: number): string {
  return new Date(goalTimestampMs(value)).toLocaleString();
}

function goalStatusLabel(status: GoalState["status"]): string {
  switch (status) {
    case "paused":
      return "Goal paused";
    case "blocked":
      return "Goal blocked";
    case "usageLimited":
      return "Usage limited";
    case "budgetLimited":
      return "Budget limited";
    case "complete":
      return "Goal complete";
    case "active":
    default:
      return "Pursuing goal";
  }
}

function ActiveGoalActionStatus({
  isRefreshingGoal,
  refreshError,
  isClearingGoal,
}: {
  isRefreshingGoal: boolean;
  refreshError: boolean;
  isClearingGoal: boolean;
}) {
  if (!isRefreshingGoal && !refreshError && !isClearingGoal) return null;
  if (isClearingGoal) return <div className="text-muted-foreground">Clearing...</div>;
  if (refreshError) return <div className="text-muted-foreground">Could not refresh goal details.</div>;
  return <div className="text-muted-foreground">Refreshing...</div>;
}

function ActiveGoalChipTrigger({
  goal,
  isClearingGoal,
  onClear,
}: {
  goal: GoalState;
  isClearingGoal: boolean;
  onClear(): void;
}) {
  const goalLabel = (
    <span className="inline-flex items-center gap-1.5 px-2 text-xs font-semibold text-foreground">
      <Goal size={13} className="text-primary" aria-hidden />
      <span>Goal</span>
    </span>
  );

  return (
    <span
      data-testid="active-goal-chip"
      className="inline-flex h-7 shrink-0 items-center rounded-lg bg-accent/70 pr-0.5 ring-1 ring-inset ring-primary/30"
    >
      {goal.controls.canInspect === true ? (
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="h-6 gap-0 rounded-md px-0 hover:bg-accent"
              aria-label={`Show active goal: ${goal.objective}`}
            >
              {goalLabel}
            </Button>
          }
        />
      ) : goalLabel}
      {goal.controls.canClear === true ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="size-6 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Clear active goal"
          title="Clear active goal"
          disabled={isClearingGoal}
          onClick={onClear}
        >
          <X size={12} aria-hidden />
        </Button>
      ) : null}
    </span>
  );
}

function ActiveGoalDetails({
  goal,
  isRefreshingGoal,
  refreshError,
  isClearingGoal,
  lookupSource,
  lookupReason,
  elapsed,
  onClear,
}: {
  goal: GoalState;
  isRefreshingGoal: boolean;
  refreshError: boolean;
  isClearingGoal: boolean;
  lookupSource: string | null;
  lookupReason: string | null;
  elapsed: number;
  onClear(): void;
}) {
  if (goal.controls.canInspect !== true) return null;

  return (
    <PopoverContent align="start" sideOffset={8} className="w-80 space-y-3 p-3 text-xs">
      <div className="space-y-1">
        <div className="font-medium text-foreground">{goal.objective}</div>
        <div className="text-muted-foreground">{goalStatusLabel(goal.status)}</div>
      </div>
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-muted-foreground">
        <span>Elapsed</span>
        <span className="text-foreground">{formatGoalElapsed(elapsed)}</span>
        <span>Tokens used</span>
        <span className="text-foreground tabular-nums">{goal.tokensUsed}</span>
        {goal.tokenBudget != null ? (
          <>
            <span>Token budget</span>
            <span className="text-foreground tabular-nums">{goal.tokenBudget}</span>
          </>
        ) : null}
        <span>Goal source</span>
        <span className="text-foreground">{goal.source}</span>
        <span>Updated</span>
        <span className="text-foreground">{formatGoalDate(goal.updatedAt)}</span>
        <span>Lookup source</span>
        <span className="text-foreground">{lookupSource ?? "Refreshing"}</span>
        {lookupReason ? (
          <>
            <span>Lookup reason</span>
            <span className="text-foreground">{lookupReason}</span>
          </>
        ) : null}
      </div>
      <ActiveGoalActionStatus
        isRefreshingGoal={isRefreshingGoal}
        refreshError={refreshError}
        isClearingGoal={isClearingGoal}
      />
      {goal.controls.canClear === true ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full"
          disabled={isClearingGoal}
          onClick={onClear}
        >
          {isClearingGoal ? "Clearing..." : "Clear goal"}
        </Button>
      ) : null}
    </PopoverContent>
  );
}

/** Shows the active provider goal as a compact composer capability chip. */
export function ActiveGoalChip({ threadId, goal }: ActiveGoalChipProps) {
  const [now, setNow] = useState(() => Date.now());
  const {
    detailsOpen,
    isRefreshingGoal,
    isClearingGoal,
    lookupSource,
    lookupReason,
    refreshError,
    setDetailsOpen,
    clearGoal,
  } = useActiveGoalActions(threadId);

  useEffect(() => {
    if (!isGoalOpen(goal)) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [goal]);

  if (!isGoalOpen(goal)) return null;

  const createdAt = goalTimestampMs(goal.createdAt);
  const elapsed = Math.max(goal.timeUsedSeconds, Math.floor((now - createdAt) / 1000));

  return (
    <Popover open={detailsOpen} onOpenChange={setDetailsOpen}>
      <ActiveGoalChipTrigger goal={goal} isClearingGoal={isClearingGoal} onClear={clearGoal} />
      <ActiveGoalDetails
        goal={goal}
        isRefreshingGoal={isRefreshingGoal}
        refreshError={refreshError}
        isClearingGoal={isClearingGoal}
        lookupSource={lookupSource}
        lookupReason={lookupReason}
        elapsed={elapsed}
        onClear={clearGoal}
      />
    </Popover>
  );
}
