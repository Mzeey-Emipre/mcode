import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface PlanSkeletonProps {
  title?: string | null;
}

/**
 * Skeleton loading state shown while the agent generates a plan revision.
 * Thin progress bar, dimmed title, and staggered shimmer blocks.
 */
export function PlanSkeleton({ title }: PlanSkeletonProps) {
  return (
    <div data-testid="plan-skeleton" className="h-full overflow-hidden bg-background">
      <div className="h-0.5 overflow-hidden bg-accent">
        <div className="h-full w-[30%] animate-[plan-slide_1.6s_cubic-bezier(0.4,0,0.2,1)_infinite] rounded-sm bg-primary/60" />
      </div>

      {title && (
        <Tooltip>
          <TooltipTrigger
            render={
              <h1 className="truncate px-4 pt-4 text-[15px] font-semibold leading-snug opacity-35">
                {title}
              </h1>
            }
          />
          <TooltipContent>{title}</TooltipContent>
        </Tooltip>
      )}

      <div className="flex items-center gap-2 px-4 pb-2 pt-4">
        <span className="h-[5px] w-[5px] animate-pulse rounded-full bg-primary" aria-hidden />
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground/60">
          Generating plan revision
        </span>
      </div>

      <div className="flex flex-col gap-6 px-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex flex-col gap-2">
            <div
              className="h-3.5 rounded bg-accent animate-[plan-fade_2s_ease-in-out_infinite]"
              style={{ width: `${35 + i * 5}%`, animationDelay: `${i * 0.3}s` }}
            />
            <div
              className="h-2.5 w-full rounded bg-accent animate-[plan-fade_2s_ease-in-out_infinite]"
              style={{ opacity: 0.3, animationDelay: `${i * 0.3}s` }}
            />
            <div
              className="h-2.5 rounded bg-accent animate-[plan-fade_2s_ease-in-out_infinite]"
              style={{ width: `${75 + i * 5}%`, opacity: 0.3, animationDelay: `${i * 0.3}s` }}
            />
            <div
              className="h-2.5 rounded bg-accent animate-[plan-fade_2s_ease-in-out_infinite]"
              style={{ width: `${55 + i * 3}%`, opacity: 0.3, animationDelay: `${i * 0.3}s` }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
