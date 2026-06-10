import type { McodeTransport } from "@/transport/types";
import type { SelectedFile } from "@/stores/diffStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";

/**
 * Fetch the unified diff for a single file in a Review view. Centralizes the
 * per-source routing shared by the inline file rows and the selected-file pane,
 * so the two stay in lockstep as sources are added. The `id` resolves the diff
 * per {@link SelectedFile.id}: snapshot ID, thread ID, commit SHA, or — for the
 * git working-tree views — the workspace ID. For those git views `threadId`
 * (when a real thread) makes the diff read the thread's worktree rather than the
 * workspace root; the server treats a non-thread id as the workspace root.
 * Returns `""` on any failure.
 */
export async function loadFileDiff(
  transport: McodeTransport,
  source: SelectedFile["source"],
  id: string,
  filePath: string,
  threadId?: string,
): Promise<string> {
  switch (source) {
    case "snapshot":
      return transport.getSnapshotDiff(id, filePath);
    case "cumulative":
      return transport.getCumulativeDiff(id, filePath);
    case "unstaged":
      return transport.getWorkingTreeDiff(id, false, filePath, undefined, threadId);
    case "staged":
      return transport.getWorkingTreeDiff(id, true, filePath, undefined, threadId);
    case "branch":
      return transport.getBranchDiff(id, filePath, undefined, threadId);
    case "commit": {
      const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
      return workspaceId ? transport.getCommitDiff(workspaceId, id, filePath) : "";
    }
  }
}
