import { showRightPanelAdaptive } from "@/lib/right-panel-layout";
import { useDiffStore } from "@/stores/diffStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";

/** Opens the active thread's persisted coordination panel. */
export function openThreadCoordinationPanel(): boolean {
  const { activeWorkspaceId, activeThreadId } = useWorkspaceStore.getState();
  if (!activeWorkspaceId || !activeThreadId) return false;
  const diff = useDiffStore.getState();
  diff.setRightPanelTab(activeWorkspaceId, activeThreadId, "coordination");
  showRightPanelAdaptive(activeWorkspaceId, activeThreadId);
  return true;
}
