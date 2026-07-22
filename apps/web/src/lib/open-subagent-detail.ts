import { showRightPanelAdaptive } from "@/lib/right-panel-layout";
import { useDiffStore, type SubagentRosterTab } from "@/stores/diffStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useUiStore } from "@/stores/uiStore";

/** Opens the active thread's Subagents panel. */
export function openSubagentsPanel(): boolean {
  const { activeWorkspaceId, activeThreadId } = useWorkspaceStore.getState();
  if (!activeWorkspaceId || !activeThreadId) return false;

  const diff = useDiffStore.getState();
  diff.setRightPanelTab(activeWorkspaceId, activeThreadId, "subagents");
  showRightPanelAdaptive(activeWorkspaceId, activeThreadId);
  useUiStore.getState().setRightPanelMaximized(true, "user");
  return true;
}

/** Opens the active thread's Subagents panel at one Agent detail. */
export function openSubagentDetail(id: string, tab: SubagentRosterTab): boolean {
  const { activeWorkspaceId, activeThreadId } = useWorkspaceStore.getState();
  if (!activeWorkspaceId || !activeThreadId || id.length === 0) return false;

  const diff = useDiffStore.getState();
  diff.selectSubagentDetail(activeThreadId, { id, originTab: tab, scrollTop: 0 });
  return openSubagentsPanel();
}
