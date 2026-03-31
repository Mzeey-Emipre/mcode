import { useEffect } from "react";
import { Github, Terminal } from "lucide-react";
import { OpenInEditorMenu } from "./OpenInEditorMenu";
import { useBranchPr } from "@/hooks/useBranchPr";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useTerminalStore } from "@/stores/terminalStore";
import { Button } from "@/components/ui/button";
import type { Thread } from "@/transport";

/** Props for {@link HeaderActions}. */
interface HeaderActionsProps {
  thread: Thread;
}

/**
 * Renders PR link, editor shortcut, and terminal toggle for the active thread header.
 * Polls GitHub for the thread's PR and syncs state changes back to the workspace store.
 */
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

  // Sync polled PR state back to the workspace store so the project tree
  // icon reflects state changes (e.g. OPEN -> MERGED) in realtime.
  useEffect(() => {
    if (!pr) return;
    useWorkspaceStore.setState((ws) => {
      const stored = ws.threads.find((t) => t.id === thread.id);
      if (!stored) return ws;
      const stateChanged = stored.pr_status?.toLowerCase() !== pr.state.toLowerCase();
      const numberChanged = stored.pr_number !== pr.number;
      if (!stateChanged && !numberChanged) return ws;
      return {
        threads: ws.threads.map((t) =>
          t.id === thread.id
            ? { ...t, pr_number: pr.number, pr_status: pr.state }
            : t,
        ),
      };
    });
  }, [pr, thread.id]);

  const panelVisible = useTerminalStore((s) => s.panelVisible);
  const togglePanel = useTerminalStore((s) => s.togglePanel);

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
      {dirPath && (
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
                <span>View PR #{pr.number}</span>
              </Button>
              <div className="w-px h-4 bg-border/30" />
            </>
          )}
          <OpenInEditorMenu dirPath={dirPath} />
        </div>
      )}
      <Button
        variant="ghost"
        size="xs"
        onClick={togglePanel}
        className={`gap-1 text-xs h-6 ${
          panelVisible
            ? "text-foreground bg-muted/40"
            : "text-foreground/70 hover:text-foreground hover:bg-muted/40"
        }`}
        aria-label="Toggle terminal"
        aria-pressed={panelVisible}
        title="Toggle terminal (Ctrl+J)"
      >
        <Terminal size={12} />
      </Button>
    </div>
  );
}
