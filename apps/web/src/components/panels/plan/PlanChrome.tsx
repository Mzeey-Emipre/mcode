import type { PlanRecord } from "@mcode/contracts";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePlanStore } from "@/stores/planStore";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatRelative } from "@/lib/format-relative";

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
  const hasFeedback = commentCount > 0;

  return (
    <div className="flex min-w-0 flex-shrink-0 items-center gap-2 border-b border-border bg-background px-3 py-2">
      {/* Revision history */}
      <Popover>
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="shrink-0 gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em]"
              aria-label={`Revision history: v${plan.version} of ${maxVersion}`}
            >
              v{plan.version}
              <span className="tracking-normal text-muted-foreground/70 normal-case">
                {formatRelative(plan.createdAt)}
              </span>
              <ChevronDown size={12} aria-hidden />
            </Button>
          }
        />
        <PopoverContent align="start" className="w-72 p-1">
          <div className="px-2 py-1.5 font-mono text-[9px] uppercase tracking-[0.16em] text-muted-foreground/60">
            Revision history
          </div>
          {[...allVersions].reverse().map((p) => {
            const isLatest = p.version === maxVersion;
            const isActive = p.version === plan.version;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setActiveVersion(threadId, isLatest ? null : p.version)}
                className={cn(
                  "flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/50",
                  isActive && "bg-accent/40",
                )}
              >
                <span className="flex items-center gap-2">
                  <span className={cn("font-mono text-[11px]", isActive ? "text-primary" : "text-foreground")}>
                    v{p.version}
                  </span>
                  <span className="font-mono text-[10px] text-muted-foreground/70">
                    {formatRelative(p.createdAt)}
                  </span>
                  <span
                    className={cn(
                      "ml-auto rounded-full px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-[0.1em]",
                      isLatest ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
                    )}
                  >
                    {isLatest ? "latest" : p.status}
                  </span>
                </span>
                {p.changeSummary && (
                  <span className="text-[11px] leading-snug text-muted-foreground">{p.changeSummary}</span>
                )}
              </button>
            );
          })}
        </PopoverContent>
      </Popover>

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
