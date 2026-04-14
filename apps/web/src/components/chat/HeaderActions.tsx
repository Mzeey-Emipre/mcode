import { useEffect, useCallback, useState } from "react";
import { Terminal, Diff } from "lucide-react";
import { OpenInEditorMenu } from "./OpenInEditorMenu";
import { CreatePrDialog } from "./CreatePrDialog";
import { PrSplitButton } from "./PrSplitButton";
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
  const polledPr = useBranchPr(shouldPollPr ? thread.branch : null, cwd);

  // polledPr is the live source of truth for state (OPEN / MERGED / CLOSED).
  // The store-backed entry fills the window right after creation, before the first
  // poll resolves. Only use it when cachedPrUrl is present — otherwise we'd produce
  // a PR object with url: "" which breaks the Open-in-browser action.
  const cachedPrUrl = useWorkspaceStore((s) => s.prUrlsByThreadId[thread.id]);
  const checks = useWorkspaceStore((s) => s.checksById[thread.id]) ?? null;
  const storePr = thread.pr_number != null && cachedPrUrl
    ? { number: thread.pr_number, url: cachedPrUrl, state: thread.pr_status ?? "OPEN" }
    : null;
  // When polledPr and storePr have different numbers, storePr is the freshly
  // created PR and polledPr is stale (not yet caught up). Prefer storePr.
  const pr = (storePr != null && polledPr?.url && polledPr.number !== storePr.number)
    ? storePr
    : (polledPr?.url ? polledPr : null) ?? storePr;

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

  const terminalVisible = useTerminalStore((s) =>
    thread?.id ? (s.terminalPanelByThread[thread.id]?.visible ?? false) : false,
  );
  const toggleTerminal = useCallback(() => {
    if (thread?.id) useTerminalStore.getState().toggleTerminalPanel(thread.id);
  }, [thread?.id]);

  const diffActive = useDiffStore((s) => {
    if (!thread?.id) return false;
    const panel = s.rightPanelByThread[thread.id];
    return (panel?.visible ?? false) && (panel?.activeTab ?? "tasks") === "changes";
  });

  const toggleDiff = useCallback(() => {
    if (!thread?.id) return;
    const { getRightPanel, showRightPanel, setRightPanelTab, hideRightPanel } =
      useDiffStore.getState();
    const panel = getRightPanel(thread.id);
    if (!panel.visible) {
      showRightPanel(thread.id);
      setRightPanelTab(thread.id, "changes");
    } else if (panel.activeTab !== "changes") {
      setRightPanelTab(thread.id, "changes");
    } else {
      hideRightPanel(thread.id);
    }
  }, [thread?.id]);

  const handleOpenPr = useCallback((url: string) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:" && parsed.hostname === "github.com") {
        window.desktopBridge?.openExternalUrl(url);
      }
    } catch {
      // Invalid URL, ignore
    }
  }, []);

  return (
    <div className="flex items-center justify-between gap-0.5">
      {dirPath && (
        <div className="flex items-center gap-0.5 bg-muted/20 rounded-md px-1 py-0.5">
          {shouldPollPr && (
            <PrSplitButton
              pr={pr}
              hasCommitsAhead={hasCommitsAhead}
              onCreatePr={() => setCreatePrOpen(true)}
              onOpenPr={handleOpenPr}
              checks={checks}
              threadId={thread.id}
            />
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
