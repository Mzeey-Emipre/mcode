import { Github, Terminal } from "lucide-react";
import { OpenInEditorMenu } from "./OpenInEditorMenu";
import { useBranchPr } from "@/hooks/useBranchPr";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useTerminalStore } from "@/stores/terminalStore";
import { Button } from "@/components/ui/button";
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

  const panelVisible = useTerminalStore((s) => s.panelVisible);
  const togglePanel = useTerminalStore((s) => s.togglePanel);

  if (!dirPath) return null;

  const handleOpenPr = () => {
    if (pr?.url) {
      try {
        const parsed = new URL(pr.url);
        if (parsed.protocol === "https:") {
          window.desktopBridge?.openExternalUrl(pr.url);
        }
      } catch {
        // Invalid URL, ignore
      }
    }
  };

  return (
    <div className="flex items-center justify-between gap-0.5">
      <div className="flex items-center gap-0.5 bg-muted/20 rounded-md px-1 py-0.5">
        {pr && (
          <>
            <Button
              variant="ghost"
              size="xs"
              onClick={handleOpenPr}
              className="gap-1 text-xs text-foreground/70 hover:text-foreground hover:bg-muted/40 h-6"
              title={`PR #${pr.number} – ${pr.state}`}
            >
              <Github size={12} />
              <span>View PR</span>
            </Button>
            <div className="w-px h-4 bg-border/30" />
          </>
        )}
        <OpenInEditorMenu dirPath={dirPath} />
      </div>
      <Button
        variant="ghost"
        size="xs"
        onClick={togglePanel}
        className={`gap-1 text-xs h-6 ${
          panelVisible
            ? "text-foreground bg-muted/40"
            : "text-foreground/70 hover:text-foreground hover:bg-muted/40"
        }`}
        title="Toggle terminal (Ctrl+J)"
      >
        <Terminal size={12} />
      </Button>
    </div>
  );
}
