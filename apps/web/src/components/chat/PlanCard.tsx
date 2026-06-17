import { useMemo } from "react";
import { usePlanStore } from "@/stores/planStore";
import { useDiffStore } from "@/stores/diffStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { showRightPanelAdaptive } from "@/lib/right-panel-layout";
import { ScrollText, ArrowUpRight } from "lucide-react";

interface PlanCardProps {
  messageId: string;
}

/**
 * Compact plan artifact card in the chat message stream. Clicking
 * opens the Scope panel to the associated plan version. Renders only
 * when a persisted plan record exists for this message.
 */
export function PlanCard({ messageId }: PlanCardProps) {
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const allPlans = usePlanStore((s) =>
    activeThreadId ? s.plansByThread[activeThreadId] : undefined,
  );

  const plan = useMemo(
    () => allPlans?.find((p) => p.messageId === messageId),
    [allPlans, messageId],
  );

  if (!plan || !activeThreadId || !activeWorkspaceId) return null;

  const sectionCount = plan.sectionsJson?.length ?? 0;

  const handleClick = () => {
    showRightPanelAdaptive(activeWorkspaceId, activeThreadId);
    useDiffStore.getState().setRightPanelTab(activeWorkspaceId, activeThreadId, "tasks");
    usePlanStore.getState().setActiveVersion(activeThreadId, plan.version);
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className="group/plan mt-3 flex w-full items-center gap-3 rounded-md bg-primary/[0.04] px-4 py-3 text-left transition-all duration-150 hover:bg-primary/[0.08]"
    >
      {/* Icon with subtle primary tint background */}
      <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md bg-primary/[0.08]">
        <ScrollText className="h-4 w-4 text-primary/80" />
      </div>

      {/* Title + metadata */}
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium text-foreground truncate leading-tight">
          {plan.title}
        </div>
        <div className="mt-0.5 flex items-center gap-2 font-mono text-[10px] tracking-[0.06em] text-muted-foreground/55">
          <span className="uppercase text-primary/60">v{plan.version}</span>
          {sectionCount > 0 && (
            <>
              <span className="text-muted-foreground/25">·</span>
              <span>{sectionCount} {sectionCount === 1 ? "section" : "sections"}</span>
            </>
          )}
        </div>
      </div>

      {/* Open affordance - appears on hover */}
      <ArrowUpRight className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/30 transition-all duration-150 group-hover/plan:text-primary/60 group-hover/plan:translate-x-0.5 group-hover/plan:-translate-y-0.5" />
    </button>
  );
}
