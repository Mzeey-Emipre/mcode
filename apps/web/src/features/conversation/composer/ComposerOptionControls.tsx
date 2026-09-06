import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useDiffStore } from "@/stores/diffStore";
import { usePlanStore } from "@/stores/planStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { hideRightPanelAdaptive, showRightPanelAdaptive } from "@/lib/right-panel-layout";
import { cn } from "@/lib/utils";
import { Check, Eye, KeyRound, ListChecks, ShieldCheck } from "lucide-react";
import { useState } from "react";

export type ComposerAccessMode = "supervised" | "automatic" | "full";

/** Props shared by Composer's compact and inline option controls. */
export interface ComposerOptionControlsProps {
  threadId?: string;
  accessMode: ComposerAccessMode;
  /** True when the provider requires Full access and cannot offer the supervised mode. */
  permissionLocked: boolean;
  approvalReviewSupported: boolean;
  onAccessModeChange: (next: ComposerAccessMode) => void;
}

const ACCESS_MODES: ReadonlyArray<{
  id: ComposerAccessMode;
  label: "Manual" | "Auto" | "Full access";
  description: string;
}> = [
  { id: "supervised", label: "Manual", description: "Ask you to approve actions" },
  { id: "automatic", label: "Auto", description: "Review actions automatically" },
  { id: "full", label: "Full access", description: "Run without approval prompts" },
];

const ACCESS_MODE_LABELS: Record<ComposerAccessMode, (typeof ACCESS_MODES)[number]["label"]> = {
  supervised: "Manual",
  automatic: "Auto",
  full: "Full access",
};

function accessIcon(accessMode: ComposerAccessMode) {
  if (accessMode === "automatic") return ShieldCheck;
  return accessMode === "full" ? KeyRound : Eye;
}

function isAccessModeDisabled(accessMode: ComposerAccessMode, permissionLocked: boolean): boolean {
  return permissionLocked && accessMode !== "full";
}

function AccessModeSelector({
  accessMode,
  permissionLocked,
  approvalReviewSupported,
  onAccessModeChange,
}: Omit<ComposerOptionControlsProps, "threadId">) {
  const [open, setOpen] = useState(false);
  const Icon = accessIcon(accessMode);
  const selectedLabel = ACCESS_MODE_LABELS[accessMode];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            aria-label={`Access mode: ${selectedLabel}`}
            className="gap-1.5 text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
          >
            <Icon size={14} />
            <span className="text-sm">{selectedLabel}</span>
          </Button>
        }
      />
      <PopoverContent align="start" sideOffset={8} className="w-60 p-2">
        <div className="px-1.5 pt-1 pb-1.5 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground/70">
          Access mode
        </div>
        <div className="space-y-0.5">
          {ACCESS_MODES.filter((mode) => approvalReviewSupported || mode.id !== "automatic").map((mode) => {
            const ModeIcon = accessIcon(mode.id);
            const disabled = isAccessModeDisabled(mode.id, permissionLocked);
            return (
              <Button
                key={mode.id}
                variant="ghost"
                size="xs"
                disabled={disabled}
                aria-pressed={accessMode === mode.id}
                onClick={() => {
                  onAccessModeChange(mode.id);
                  setOpen(false);
                }}
                className="h-auto w-full justify-start gap-2 rounded-md px-2 py-1.5 text-xs font-normal whitespace-normal"
              >
                <ModeIcon size={13} className="text-muted-foreground" />
                <span className="min-w-0 flex-1 text-left">
                  <span className="block text-foreground">{mode.label}</span>
                  <span className="block text-muted-foreground">{mode.description}</span>
                </span>
                {accessMode === mode.id && <Check size={13} className="text-primary" />}
              </Button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
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

/** Renders the shared access selector and optional plan-panel control. */
export function ComposerOptionsMenu({
  threadId,
  accessMode,
  permissionLocked,
  approvalReviewSupported,
  onAccessModeChange,
}: ComposerOptionControlsProps) {
  const { hasPlans, panelVisible, togglePlanPanel } = useComposerPlanPanel(threadId);

  return (
    <>
      <AccessModeSelector
        accessMode={accessMode}
        permissionLocked={permissionLocked}
        approvalReviewSupported={approvalReviewSupported}
        onAccessModeChange={onAccessModeChange}
      />
      {hasPlans && (
        <Button
          variant="ghost"
          size="xs"
          onClick={togglePlanPanel}
          aria-pressed={panelVisible}
          className={cn(
            "gap-1.5 transition-colors hover:bg-muted/40",
            panelVisible ? "text-primary hover:text-primary" : "text-muted-foreground hover:text-foreground",
          )}
        >
          <ListChecks size={14} />
          <span className="text-sm">Plan</span>
        </Button>
      )}
    </>
  );
}

/** Inline Composer controls for wide layouts. */
export function InlineComposerOptions({
  threadId,
  accessMode,
  permissionLocked,
  approvalReviewSupported,
  onAccessModeChange,
}: ComposerOptionControlsProps) {
  return <ComposerOptionsMenu
    threadId={threadId}
    accessMode={accessMode}
    permissionLocked={permissionLocked}
    approvalReviewSupported={approvalReviewSupported}
    onAccessModeChange={onAccessModeChange}
  />;
}
