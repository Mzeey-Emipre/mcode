import { getTransport } from "@/transport";
import { useDiffStore } from "@/stores/diffStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";

function isViewingCumulativeChanges(threadId: string): boolean {
  const diffState = useDiffStore.getState();
  const workspaceState = useWorkspaceStore.getState();
  const workspaceId = workspaceState.threads.find((thread) => thread.id === threadId)?.workspace_id;
  const panel = workspaceId ? diffState.getRightPanel(workspaceId, threadId) : undefined;
  return (
    workspaceState.activeThreadId === threadId &&
    workspaceId !== undefined &&
    diffState.getRightPanelVisible(workspaceId, threadId) &&
    panel?.activeTab === "changes" &&
    diffState.viewMode === "cumulative"
  );
}

/**
 * Refresh turn snapshots after `turn.persisted` when a turn touched files.
 * Centralizes the Review panel update so chat (`threadStore`) and Changes
 * (`diffStore`) stay aligned on the same turn-end event.
 */
export function refreshTurnSnapshotsAfterPersist(
  threadId: string,
  filesChanged: string[],
): void {
  if (filesChanged.length === 0) return;

  useDiffStore.getState().bumpDiffRevision(threadId);

  if (isViewingCumulativeChanges(threadId)) {
    useDiffStore.getState().markSnapshotsPending(threadId, true);
    return;
  }

  const transport = getTransport();

  void transport
    .listSnapshots(threadId)
    .then((snapshots) => useDiffStore.getState().setSnapshots(threadId, snapshots))
    .catch(() => { /* non-critical */ });
}
