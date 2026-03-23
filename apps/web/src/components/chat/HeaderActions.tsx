import { OpenInEditorMenu } from "./OpenInEditorMenu";
import { PrBadge } from "./PrBadge";
import { useBranchPr } from "@/hooks/useBranchPr";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import type { Thread } from "@/transport";

interface HeaderActionsProps {
  thread: Thread;
}

export function HeaderActions({ thread }: HeaderActionsProps) {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const workspace = workspaces.find((w) => w.id === thread.workspace_id);

  // Determine the path to open: worktree path if available, otherwise workspace root
  const dirPath = thread.worktree_path ?? workspace?.path ?? null;

  // Poll for PR on the thread's branch
  const cwd = workspace?.path ?? null;
  const pr = useBranchPr(thread.branch, cwd);

  if (!dirPath) return null;

  return (
    <div className="flex items-center gap-1">
      <OpenInEditorMenu dirPath={dirPath} />
      {pr && <PrBadge pr={pr} />}
    </div>
  );
}
