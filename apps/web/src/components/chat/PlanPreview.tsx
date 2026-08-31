import { ListChecks, X } from "lucide-react";
import type { PlanRecord } from "@mcode/contracts";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { showRightPanelAdaptive } from "@/lib/right-panel-layout";
import { useDiffStore } from "@/stores/diffStore";
import { usePlanStore } from "@/stores/planStore";

/** Props for {@link PlanPreview}. */
interface PlanPreviewProps {
  /** Active workspace id used to open the right-panel Plan tab. */
  workspaceId: string;
  /** Active thread id that owns the previewed plan. */
  threadId: string;
  /** Session-local preview metadata for one live-generated plan version. */
  preview: Pick<PlanRecord, "id" | "version" | "title">;
}

/** Composer-adjacent preview for a live-generated plan version. */
export function PlanPreview({ workspaceId, threadId, preview }: PlanPreviewProps) {
  const viewPlan = () => {
    usePlanStore.getState().clearLivePreview(threadId);
    usePlanStore.getState().setActiveVersion(threadId, preview.version);
    showRightPanelAdaptive(workspaceId, threadId);
    useDiffStore.getState().setRightPanelTab(workspaceId, threadId, "tasks");
  };

  return (
    <div
      data-testid="plan-preview"
      className="flex min-w-0 items-center gap-3 rounded-lg border border-border bg-card/75 px-3 py-2 shadow-sm"
    >
      <ListChecks size={16} className="shrink-0 text-muted-foreground" aria-hidden />
      <Tooltip>
        <TooltipTrigger
          render={<span className="min-w-0 flex-1 truncate text-sm text-foreground" />}
        >
          {preview.title}
        </TooltipTrigger>
        <TooltipContent>{preview.title}</TooltipContent>
      </Tooltip>
      <Button
        type="button"
        variant="outline"
        size="xs"
        onClick={viewPlan}
        className="shrink-0"
      >
        View plan
      </Button>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Dismiss plan preview"
              onClick={() => usePlanStore.getState().dismissLivePreview(threadId, preview.version)}
              className="shrink-0 text-muted-foreground"
            >
              <X size={14} />
            </Button>
          }
        />
        <TooltipContent>Dismiss plan preview</TooltipContent>
      </Tooltip>
    </div>
  );
}
