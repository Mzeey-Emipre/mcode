import type { PermissionMode } from "@/transport";
import { PERMISSION_MODES } from "@/transport";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDiffStore } from "@/stores/diffStore";
import { usePlanStore } from "@/stores/planStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { hideRightPanelAdaptive, showRightPanelAdaptive } from "@/lib/right-panel-layout";
import { cn } from "@/lib/utils";
import { ListChecks, Lock, MoreHorizontal, Unlock } from "lucide-react";

/** Props shared by Composer's compact and inline option controls. */
export interface ComposerOptionControlsProps {
  threadId?: string;
  access: PermissionMode;
  /** True when the provider requires Full access and cannot offer the supervised mode. */
  permissionLocked: boolean;
  onAccessChange: (next: PermissionMode) => void;
}

function useComposerPlanPanel(threadId: string | undefined) {
  const hasPlans = usePlanStore(
    (state) =>
      Boolean(
        threadId &&
          ((state.plansByThread[threadId]?.length ?? 0) > 0 ||
            state.generatingThreads.has(threadId)),
      ),
  );
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const panelVisible = useDiffStore((state) =>
    activeWorkspaceId ? state.getRightPanelVisible(activeWorkspaceId, threadId) : false,
  );

  const togglePlanPanel = () => {
    if (!threadId || !activeWorkspaceId) return;
    if (panelVisible) {
      hideRightPanelAdaptive(activeWorkspaceId, threadId);
      return;
    }
    showRightPanelAdaptive(activeWorkspaceId, threadId);
    useDiffStore.getState().setRightPanelTab(activeWorkspaceId, threadId, "tasks");
  };

  return { hasPlans, panelVisible, togglePlanPanel };
}

/** Compact overflow menu for Composer permission and plan-panel controls. */
export function ComposerOptionsMenu({
  threadId,
  access,
  permissionLocked,
  onAccessChange,
}: ComposerOptionControlsProps) {
  const { hasPlans, panelVisible, togglePlanPanel } = useComposerPlanPanel(threadId);

  return (
    <Popover>
      <PopoverTrigger
        aria-label="Composer options"
        title="Composer options"
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground data-[popup-open]:bg-muted/40 data-[popup-open]:text-foreground"
      >
        <MoreHorizontal size={14} />
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={8} className="w-60 p-2">
        <div className="px-1.5 pt-1 pb-1.5 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground/70">
          Permissions
        </div>
        {permissionLocked ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <div
                  className={cn(
                    "flex items-center gap-1.5 rounded-md bg-muted/40 px-2 py-1.5 text-xs font-medium text-muted-foreground",
                    hasPlans && "mb-2",
                  )}
                >
                  <Unlock size={12} />
                  Full access (Cursor on Windows)
                </div>
              }
            />
            <TooltipContent>
              Cursor on Windows runs in full access. Supervised mode is unavailable because cursor-agent's OS sandbox requires macOS or Linux.
            </TooltipContent>
          </Tooltip>
        ) : (
          <div className={cn("flex rounded-md bg-muted/40 p-0.5", hasPlans && "mb-2")}>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => onAccessChange(PERMISSION_MODES.FULL)}
              aria-pressed={access === PERMISSION_MODES.FULL}
              className={cn(
                "h-auto flex-1 gap-1.5 rounded-[5px] px-2 py-1 text-xs font-medium hover:bg-transparent",
                access === PERMISSION_MODES.FULL
                  ? "bg-background text-foreground shadow-sm hover:bg-background"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Unlock size={12} />
              Full
            </Button>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => onAccessChange(PERMISSION_MODES.SUPERVISED)}
              aria-pressed={access === PERMISSION_MODES.SUPERVISED}
              className={cn(
                "h-auto flex-1 gap-1.5 rounded-[5px] px-2 py-1 text-xs font-medium hover:bg-transparent",
                access === PERMISSION_MODES.SUPERVISED
                  ? "bg-background text-foreground shadow-sm hover:bg-background"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Lock size={12} />
              Supervised
            </Button>
          </div>
        )}

        {hasPlans && (
          <Button
            variant="ghost"
            size="xs"
            onClick={togglePlanPanel}
            aria-pressed={panelVisible}
            className="h-auto w-full justify-between rounded-md px-2 py-1.5 text-xs font-normal text-foreground hover:bg-muted/40"
          >
            <span className="flex items-center gap-2">
              <ListChecks size={13} className={panelVisible ? "text-primary" : "text-muted-foreground"} />
              Plan panel
            </span>
            <span className={cn("text-xs font-medium uppercase tracking-[0.1em]", panelVisible ? "text-primary" : "text-muted-foreground/60")}>
              {panelVisible ? "On" : "Off"}
            </span>
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Inline Composer controls for wide layouts. */
export function InlineComposerOptions({
  threadId,
  access,
  permissionLocked,
  onAccessChange,
}: ComposerOptionControlsProps) {
  const { hasPlans, panelVisible, togglePlanPanel } = useComposerPlanPanel(threadId);

  return (
    <>
      {permissionLocked ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-sm text-muted-foreground"
                aria-label="Permission mode locked to Full access"
              >
                <Unlock size={14} />
                <span className="text-sm">Full access</span>
              </span>
            }
          />
          <TooltipContent>
            Cursor on Windows runs in full access — supervised mode is unavailable because cursor-agent's OS sandbox requires macOS or Linux.
          </TooltipContent>
        </Tooltip>
      ) : (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="xs"
                onClick={() =>
                  onAccessChange(
                    access === PERMISSION_MODES.FULL
                      ? PERMISSION_MODES.SUPERVISED
                      : PERMISSION_MODES.FULL,
                  )
                }
                className="gap-1.5 text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
              >
                {access === PERMISSION_MODES.FULL ? <Unlock size={14} /> : <Lock size={14} />}
                <span className="text-sm">
                  {access === PERMISSION_MODES.FULL ? "Full access" : "Supervised"}
                </span>
              </Button>
            }
          />
          <TooltipContent>
            {access === PERMISSION_MODES.FULL ? "Full access mode" : "Supervised mode"}
          </TooltipContent>
        </Tooltip>
      )}

      {hasPlans && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="xs"
                onClick={togglePlanPanel}
                aria-pressed={panelVisible}
                className={cn(
                  "gap-1.5 transition-colors hover:bg-muted/40",
                  panelVisible
                    ? "text-primary hover:text-primary"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <ListChecks size={14} />
                <span className="text-sm">Plan</span>
              </Button>
            }
          />
          <TooltipContent>{panelVisible ? "Hide Plan panel" : "Show Plan panel"}</TooltipContent>
        </Tooltip>
      )}
    </>
  );
}
