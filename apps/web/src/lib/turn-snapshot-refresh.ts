import { getTransport } from "@/transport";
import { useDiffStore } from "@/stores/diffStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";

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

  try {
    const transport = getTransport();
    const snap = useDiffStore.getState();
    const wsState = useWorkspaceStore.getState();
    const workspaceId = wsState.threads.find((t) => t.id === threadId)?.workspace_id;
    // The whole panel record is per-thread (ADR-0012). Only defer when this
    // thread is on screen with its panel open on the Changes tab.
    const panel = workspaceId ? snap.getRightPanel(workspaceId, threadId) : undefined;
    const isViewingAllChanges =
      wsState.activeThreadId === threadId &&
      workspaceId !== undefined &&
      snap.getRightPanelVisible(workspaceId, threadId) &&
      panel?.activeTab === "changes" &&
      snap.viewMode === "cumulative";

    if (isViewingAllChanges) {
      useDiffStore.getState().markSnapshotsPending(threadId, true);
      return;
    }

    void transport
      .listSnapshots(threadId)
      .then((snapshots) => useDiffStore.getState().setSnapshots(threadId, snapshots))
      .catch(() => { /* non-critical */ });
  } catch {
    // Transport not initialized — ignore (startup race / tests).
  }
}
