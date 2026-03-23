import { OpenInEditorMenu } from "./OpenInEditorMenu";
import { PrBadge } from "./PrBadge";
import { useBranchPr } from "@/hooks/useBranchPr";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import type { Thread } from "@/transport";

interface HeaderActionsProps {
  thread: Thread;
}

export function HeaderActions({ thread }: HeaderActionsProps) {
  const workspace = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === thread.workspace_id),
  );

  // Determine the path to open: worktree path if available, otherwise workspace root
  const dirPath = thread.worktree_path ?? workspace?.path ?? null;

  // Only poll for PRs on feature branches (not main/master)
  const cwd = workspace?.path ?? null;
  const shouldPollPr = thread.branch !== "main" && thread.branch !== "master";
  const pr = useBranchPr(shouldPollPr ? thread.branch : null, cwd);

  if (!dirPath) return null;

  return (
    <div className="flex items-center gap-1">
      <OpenInEditorMenu dirPath={dirPath} />
      {pr && <PrBadge pr={pr} />}
    </div>
  );
}
