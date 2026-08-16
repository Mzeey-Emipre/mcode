import { showRightPanelAdaptive } from "@/lib/right-panel-layout";
import { useDiffStore } from "@/stores/diffStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { selectSubagentDetail, type SubagentRosterTab } from "../state";

/** Opens the active thread's Subagents panel. */
export function openSubagentsPanel(): boolean {
  const { activeWorkspaceId, activeThreadId } = useWorkspaceStore.getState();
  if (!activeWorkspaceId || !activeThreadId) return false;

  const diff = useDiffStore.getState();
  diff.setRightPanelTab(activeWorkspaceId, activeThreadId, "subagents");
  showRightPanelAdaptive(activeWorkspaceId, activeThreadId);
  return true;
}

/** Opens one child detail, preserving an unresolved roster tab for narration-origin selections. */
export function openSubagentDetail(id: string, tab?: SubagentRosterTab): boolean {
  const { activeWorkspaceId, activeThreadId } = useWorkspaceStore.getState();
  if (!activeWorkspaceId || !activeThreadId || id.length === 0) return false;

  selectSubagentDetail(activeThreadId, {
    id,
    scrollTop: 0,
    ...(tab === undefined ? {} : { originTab: tab }),
  });
  return openSubagentsPanel();
}
