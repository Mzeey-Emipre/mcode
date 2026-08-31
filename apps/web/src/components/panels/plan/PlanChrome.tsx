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
        <PopoverContent align="start" className="w-72 p-0">
          <div className="px-3 pt-3 pb-2 font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground/45">
            Revision history
          </div>
          <div className="flex flex-col gap-0.5 px-1.5 pb-1.5">
            {[...allVersions].reverse().map((p) => {
              const isLatest = p.version === maxVersion;
              const isActive = p.version === plan.version;
              return (
                <Button
                  key={p.id}
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setActiveVersion(threadId, isLatest ? null : p.version)}
                  aria-current={isActive ? "true" : undefined}
                  className={cn(
                    "h-auto w-full flex-col items-stretch gap-1 whitespace-normal rounded-md px-2.5 py-2.5 text-left font-normal transition-colors hover:bg-accent/50",
                    isActive && "bg-accent/40",
                  )}
                >
                  <span className="flex items-center gap-2.5">
                    <span
                      className={cn(
                        "font-mono text-[11px] tabular-nums",
                        isActive ? "text-primary" : "text-foreground",
                      )}
                    >
                      v{p.version}
                    </span>
                    <span className="font-mono text-[10px] tabular-nums text-muted-foreground/70">
                      {formatRelative(p.createdAt)}
                    </span>
                    {isLatest ? (
                      <span className="ml-auto rounded-full bg-primary/12 px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-[0.16em] text-primary">
                        latest
                      </span>
                    ) : (
                      <span className="ml-auto font-mono text-[8px] uppercase tracking-[0.16em] text-muted-foreground/45">
                        {p.status}
                      </span>
                    )}
                  </span>
                  {p.changeSummary && (
                    <span className="text-[11px] leading-relaxed text-muted-foreground/80">{p.changeSummary}</span>
                  )}
                </Button>
              );
            })}
          </div>
        </PopoverContent>
      </Popover>

      {plan.changeSummary && (
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="min-w-0 truncate text-[11px] leading-snug text-muted-foreground">
                {plan.changeSummary}
              </span>
            }
          />
          <TooltipContent>{plan.changeSummary}</TooltipContent>
        </Tooltip>
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
                className="font-mono text-[10px] uppercase tracking-[0.16em]"
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
