import { useCallback } from "react";
import { PanelRight, SlidersHorizontal } from "lucide-react";
import { OpenInAppButton } from "./OpenInAppButton";
import { ThreadOverview } from "./ThreadOverview";
import { useDiffStore } from "@/stores/diffStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { showRightPanelAdaptive, toggleRightPanelAdaptive } from "@/lib/right-panel-layout";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getKeybindingForCommand, formatKeybinding } from "@/lib/keybinding-manager";
import { isMac } from "@/lib/platform";
import type { Thread } from "@/transport";
/** Props for {@link HeaderActions}. */
interface HeaderActionsProps {
  thread: Thread;
  /** Current width of the chat pane that owns the composer and thread timeline. */
  threadPaneWidth: number;
}

/**
 * Renders the chat-header action strip: open-in, thread Overview, and the
 * workspace-global right-panel toggle.
 */
export function HeaderActions({ thread, threadPaneWidth }: HeaderActionsProps) {
  const workspacePath = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === thread.workspace_id)?.path ?? null,
  );

  // Effective open/closed state for the workspace-global right panel.
  const panelVisible = useDiffStore((s) =>
    thread.workspace_id
      ? s.getRightPanelVisible(thread.workspace_id, thread.id)
      : false,
  );

  const togglePanel = useCallback(() => {
    if (!thread.workspace_id) return;
    toggleRightPanelAdaptive(thread.workspace_id, thread.id);
  }, [thread.workspace_id, thread.id]);

  const openProjectSettings = useCallback(() => {
    showRightPanelAdaptive(thread.workspace_id, thread.id);
    useDiffStore.getState().setRightPanelTab(thread.workspace_id, thread.id, "environment");
  }, [thread.workspace_id, thread.id]);

  // Live keycap for the right-panel toggle, shown in the button's tooltip.
  const panelShortcut = formatKeybinding(
    getKeybindingForCommand("rightPanel.toggle")?.key ?? "mod+alt+b",
    isMac,
  );

  return (
    <div className="flex items-center justify-end gap-1">
      <div className="flex items-center gap-0.5 bg-muted/20 rounded-md px-1 py-0.5">
        <OpenInAppButton
          dirPath={thread.worktree_path ?? workspacePath}
          threadId={thread.id}
          threadOverride={thread.default_open_in_app ?? null}
        />
      </div>

      <span className="mx-0.5 h-5 w-px bg-border" aria-hidden />

      <ThreadOverview thread={thread} threadPaneWidth={threadPaneWidth} />

      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={openProjectSettings}
              aria-label="Open Project settings"
              data-testid="project-settings-toggle"
              className="cursor-pointer text-foreground/70 hover:text-foreground hover:bg-muted/40"
            >
              <SlidersHorizontal size={14} aria-hidden />
            </Button>
          }
        />
        <TooltipContent side="bottom" className="text-xs">Project settings</TooltipContent>
      </Tooltip>

      {/* Dedicated right-panel toggle for the workspace-global panel. */}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={togglePanel}
              aria-label="Toggle panel"
              aria-pressed={panelVisible}
              data-testid="header-panel-toggle"
              className={
                panelVisible
                  ? "cursor-pointer text-foreground bg-muted/40"
                  : "cursor-pointer text-foreground/70 hover:text-foreground hover:bg-muted/40"
              }
            >
              <PanelRight size={14} />
            </Button>
          }
        />
        <TooltipContent side="bottom" className="text-xs">
          Toggle panel{" "}
          <span className="text-foreground">{panelShortcut}</span>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
