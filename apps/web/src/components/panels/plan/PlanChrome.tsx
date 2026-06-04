import type { PlanRecord } from "@mcode/contracts";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePlanStore } from "@/stores/planStore";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface PlanChromeProps {
  plan: PlanRecord;
  allVersions: readonly PlanRecord[];
  threadId: string;
  onRevise: () => void;
  onImplement: () => void;
  commentCount: number;
}

/**
 * Sticky chrome bar pinned above the scrollable plan body.
 * Version navigation uses prev/next arrows; Revise and Implement stay visible.
 */
export function PlanChrome({
  plan,
  allVersions,
  threadId,
  onRevise,
  onImplement,
  commentCount,
}: PlanChromeProps) {
  const setActiveVersion = usePlanStore((s) => s.setActiveVersion);
  const maxVersion = allVersions.length > 0 ? allVersions[allVersions.length - 1].version : 1;
  const canPrev = plan.version > 1;
  const canNext = plan.version < maxVersion;
  const hasFeedback = commentCount > 0;

  return (
    <div className="flex min-w-0 flex-shrink-0 items-center gap-2 border-b border-border bg-background px-3 py-2">
      {/* Version nav */}
      <div
        className="flex shrink-0 items-center gap-0.5 rounded-md border border-border/60 bg-muted/20 px-0.5 py-0.5"
        aria-label={`Plan version ${plan.version} of ${maxVersion}`}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="shrink-0"
                disabled={!canPrev}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setActiveVersion(threadId, plan.version - 1)}
                aria-label="Previous version"
              >
                <ChevronLeft size={14} aria-hidden />
              </Button>
            }
          />
          <TooltipContent side="bottom" sideOffset={6} className="text-xs">
            {canPrev ? "Previous version" : "On first version"}
          </TooltipContent>
        </Tooltip>

        <span
          className="min-w-[2.25rem] px-1 text-center font-mono text-[10px] tabular-nums uppercase tracking-[0.16em] text-primary"
          aria-hidden
        >
          v{plan.version}
        </span>

        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="shrink-0"
                disabled={!canNext}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setActiveVersion(threadId, plan.version + 1)}
                aria-label="Next version"
              >
                <ChevronRight size={14} aria-hidden />
              </Button>
            }
          />
          <TooltipContent side="bottom" sideOffset={6} className="text-xs">
            {canNext ? "Next version" : "On latest version"}
          </TooltipContent>
        </Tooltip>
      </div>

      {plan.changeSummary && (
        <span
          className="min-w-0 truncate text-[11px] leading-snug text-muted-foreground"
          title={plan.changeSummary}
        >
          {plan.changeSummary}
        </span>
      )}

      <span className="min-w-0 flex-1" aria-hidden />

      {/* Actions */}
      <div className="flex shrink-0 items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={onRevise}
                className={cn(
                  "font-mono text-[10px] uppercase tracking-[0.16em]",
                  hasFeedback && "text-foreground",
                )}
              >
                {hasFeedback ? `Feedback (${commentCount})` : "Revise"}
              </Button>
            }
          />
          <TooltipContent side="bottom" sideOffset={6} className="max-w-[16rem] text-xs">
            {hasFeedback
              ? "Send annotated feedback and generate a new version"
              : "Request a new plan version without section notes"}
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="default"
                size="xs"
                onClick={onImplement}
                className="animate-plan-implement-glow font-mono text-[10px] uppercase tracking-[0.16em]"
              >
                Implement
              </Button>
            }
          />
          <TooltipContent side="bottom" sideOffset={6} className="max-w-[16rem] text-xs">
            Start implementation in chat mode using this plan
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
