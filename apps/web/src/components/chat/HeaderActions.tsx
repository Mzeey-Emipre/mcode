import { useEffect, useCallback, useState } from "react";
import { Github, Terminal, Diff, GitPullRequest } from "lucide-react";
import { OpenInEditorMenu } from "./OpenInEditorMenu";
import { CreatePrDialog } from "./CreatePrDialog";
import { useBranchPr } from "@/hooks/useBranchPr";
import { useHasCommitsAhead } from "@/hooks/useHasCommitsAhead";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useTerminalStore } from "@/stores/terminalStore";
import { useDiffStore } from "@/stores/diffStore";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Thread } from "@/transport";

/** Props for {@link HeaderActions}. */
interface HeaderActionsProps {
  thread: Thread;
}

/**
 * Renders PR link, editor shortcut, terminal toggle, and diff panel toggle for the active thread header.
 * Polls GitHub for the thread's PR and syncs state changes back to the workspace store.
 */
export function HeaderActions({ thread }: HeaderActionsProps) {
  const [createPrOpen, setCreatePrOpen] = useState(false);

  const workspace = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === thread.workspace_id),
  );

  // Determine the path to open: worktree path if available, otherwise workspace root
  const dirPath = thread.worktree_path ?? workspace?.path ?? null;

  // Only poll for PRs on feature branches (not main/master)
  const cwd = workspace?.path ?? null;
  const shouldPollPr = thread.branch !== "main" && thread.branch !== "master";
  const pr = useBranchPr(shouldPollPr ? thread.branch : null, cwd);

  // Check if the branch has commits ahead of main (disable Create PR when it doesn't)
  const hasCommitsAhead = useHasCommitsAhead(
    shouldPollPr ? thread.workspace_id : "",
    shouldPollPr ? thread.branch : null,
    shouldPollPr ? thread.id : undefined,
  );

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

  const terminalVisible = useTerminalStore((s) => s.panelVisible);
  const toggleTerminal = useTerminalStore((s) => s.togglePanel);

  const diffActive = useDiffStore(
    (s) => s.panelVisible && s.activeTab === "changes",
  );

  const toggleDiff = useCallback(() => {
    const store = useDiffStore.getState();
    if (!store.panelVisible || store.activeTab !== "changes") {
      store.showPanel();
      store.setActiveTab("changes");
    } else {
      store.hidePanel();
    }
  }, []);

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
          {!pr && shouldPollPr && (
            <Button
              variant="ghost"
              size="xs"
              className="gap-1 text-xs text-foreground/70 hover:text-foreground hover:bg-muted/40 h-6"
              onClick={() => setCreatePrOpen(true)}
              disabled={!hasCommitsAhead}
              title={hasCommitsAhead === false ? "No commits ahead of base branch" : undefined}
            >
              <GitPullRequest size={12} />
              <span>Create PR</span>
            </Button>
          )}
          <OpenInEditorMenu dirPath={dirPath} />
        </div>
      )}

      {/* Terminal toggle */}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="xs"
              onClick={toggleTerminal}
              className={`gap-1 text-xs h-6 ${
                terminalVisible
                  ? "text-foreground bg-muted/40"
                  : "text-foreground/70 hover:text-foreground hover:bg-muted/40"
              }`}
              aria-label="Toggle terminal"
              aria-pressed={terminalVisible}
            >
              <Terminal size={12} />
            </Button>
          }
        />
        <TooltipContent side="bottom" className="text-xs">
          Toggle terminal (Ctrl+J)
        </TooltipContent>
      </Tooltip>

      {/* Diff panel toggle */}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="xs"
              onClick={toggleDiff}
              className={`gap-1 text-xs h-6 ${
                diffActive
                  ? "text-foreground bg-muted/40"
                  : "text-foreground/70 hover:text-foreground hover:bg-muted/40"
              }`}
              aria-label="Toggle changes panel"
              aria-pressed={diffActive}
            >
              <Diff size={12} />
            </Button>
          }
        />
        <TooltipContent side="bottom" className="text-xs">
          Toggle changes (Ctrl+D)
        </TooltipContent>
      </Tooltip>

      {shouldPollPr && (
        <CreatePrDialog
          open={createPrOpen}
          onOpenChange={setCreatePrOpen}
          threadId={thread.id}
          workspaceId={thread.workspace_id}
          branch={thread.branch}
        />
      )}
    </div>
  );
}
