import { useEffect, useCallback, useState } from "react";
import { Menu, PanelRight, Diff, GitBranch, Upload, Check, GitPullRequest } from "lucide-react";
import { OpenInAppButton } from "./OpenInAppButton";
import { CreatePrDialog } from "./CreatePrDialog";
import { PrSplitButton } from "./PrSplitButton";
import { useBranchPr } from "@/hooks/useBranchPr";
import { useHasCommitsAhead } from "@/hooks/useHasCommitsAhead";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useDiffStore } from "@/stores/diffStore";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import { executeCommand } from "@/lib/command-registry";
import { isPrable } from "@/lib/is-prable";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Kbd } from "@/components/palette/Kbd";
import { getKeybindingForCommand, formatKeybinding } from "@/lib/keybinding-manager";
import { isMac } from "@/lib/platform";
import type { Thread } from "@/transport";
import { openGitHubUrl } from "@/lib/open-url-in-preview";

/** Composer prefill used by the consolidated menu's "Commit or push" item. */
const COMMIT_PREFILL = "Commit and push the current changes.";

/** Props for {@link HeaderActions}. */
interface HeaderActionsProps {
  thread: Thread;
}

/**
 * Renders the consolidated chat-header actions: the PR affordance, the open-in
 * split button, a single workspace menu (Changes / Branch / Commit or push), and
 * a dedicated toggle for the workspace-global right panel. Polls GitHub for the
 * thread's PR and syncs state changes back to the workspace store.
 */
export function HeaderActions({ thread }: HeaderActionsProps) {
  const [createPrOpen, setCreatePrOpen] = useState(false);
  const [branchCopied, setBranchCopied] = useState(false);

  const workspace = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === thread.workspace_id),
  );

  // Determine the path to open: worktree path if available, otherwise workspace root
  const dirPath = thread.worktree_path ?? workspace?.path ?? null;

  // PR affordances only apply to PR-able (worktree) threads. A direct-mode
  // thread runs against the main checkout and can never have a PR through this
  // app, so we render no PR UI and skip all GitHub polling for it.
  const cwd = workspace?.path ?? null;
  const prable = isPrable(thread);
  const polledPr = useBranchPr(prable ? thread.branch : null, cwd);

  // polledPr is the live source of truth for state (OPEN / MERGED / CLOSED).
  // The store-backed entry fills the window right after creation, before the first
  // poll resolves. Only use it when cachedPrUrl is present — otherwise we'd produce
  // a PR object with url: "" which breaks the Open-in-browser action.
  const cachedPrUrl = useWorkspaceStore((s) => s.prUrlsByThreadId[thread.id]);
  const checks = useWorkspaceStore((s) => s.checksById[thread.id]) ?? null;

  // Pull PR metadata (title/author) from the openPrs cache for the popover header.
  // polledPr and storePr only carry {number, url, state}; listOpenPrs has the rest.
  // openPrs is scoped to the active workspace, so no extra key is needed.
  const openPrDetail = useWorkspaceStore((s) => {
    if (thread.pr_number == null) return null;
    return s.openPrs.find((p) => p.number === thread.pr_number) ?? null;
  });
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
    prable ? thread.workspace_id : "",
    prable ? thread.branch : null,
    prable ? thread.id : undefined,
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

  // Deduplicated count of files touched across the thread's loaded turn snapshots.
  // Cheap, reactive, and always correct; the precise per-file +/- lives one click
  // away in the Changes tab (no cumulative diff-stat endpoint exists to total here).
  const changedFileCount = useDiffStore((s) => {
    const snaps = s.snapshotsByThread[thread.id];
    if (!snaps || snaps.length === 0) return 0;
    const seen = new Set<string>();
    for (const snap of snaps) {
      for (const file of snap.files_changed) seen.add(file);
    }
    return seen.size;
  });

  // Effective open/closed state for the workspace-global right panel.
  const panelVisible = useDiffStore((s) =>
    thread.workspace_id
      ? s.getRightPanelVisible(thread.workspace_id, thread.id)
      : false,
  );

  const togglePanel = useCallback(() => {
    if (!thread.workspace_id) return;
    useDiffStore.getState().toggleRightPanel(thread.workspace_id, thread.id);
  }, [thread.workspace_id, thread.id]);

  const openChanges = useCallback(() => {
    executeCommand("changes.toggle");
  }, []);

  // Mirror the live keybinding so the menu hint stays correct if the user rebinds it.
  const changesShortcut = formatKeybinding(
    getKeybindingForCommand("changes.toggle")?.key ?? "mod+d",
    isMac,
  );

  const copyBranch = useCallback(() => {
    void navigator.clipboard?.writeText(thread.branch);
    setBranchCopied(true);
    setTimeout(() => setBranchCopied(false), 1500);
  }, [thread.branch]);

  const setPendingPrefill = useComposerDraftStore((s) => s.setPendingPrefill);
  const handleCommitOrPush = useCallback(() => {
    setPendingPrefill(COMMIT_PREFILL);
  }, [setPendingPrefill]);

  const handleOpenPr = useCallback(
    (url: string, event?: React.MouseEvent) => {
      openGitHubUrl(url, thread.id, event);
    },
    [thread.id],
  );

  return (
    <div className="flex items-center justify-end gap-1">
      <div className="flex items-center gap-0.5 bg-muted/20 rounded-md px-1 py-0.5">
        {/* Standalone affordance is the live PR status (badge + checks). Creating a
            PR lives in the consolidated menu below; once a PR exists this takes over. */}
        {prable && dirPath && pr && (
          <PrSplitButton
            pr={pr}
            hasCommitsAhead={hasCommitsAhead}
            onCreatePr={() => setCreatePrOpen(true)}
            onOpenPr={handleOpenPr}
            checks={checks}
            threadId={thread.id}
            prTitle={openPrDetail?.title}
            prAuthor={openPrDetail?.author}
          />
        )}
        <OpenInAppButton
          dirPath={dirPath}
          threadId={thread.id}
          threadOverride={thread.default_open_in_app ?? null}
        />
      </div>

      <span className="mx-0.5 h-5 w-px bg-border" aria-hidden />

      {/* Consolidated workspace menu — the mcode items, no "environment"/"sources" framing. */}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              title="Workspace"
              aria-label="Workspace menu"
              data-testid="header-workspace-menu"
              className="cursor-pointer text-foreground/70 hover:text-foreground hover:bg-muted/40"
            >
              <Menu size={14} />
            </Button>
          }
        />
        <DropdownMenuContent align="end" sideOffset={4} className="min-w-[200px]">
          <DropdownMenuItem
            onClick={openChanges}
            data-testid="workspace-menu-changes"
            className="flex cursor-pointer items-center justify-between gap-3 text-xs"
          >
            <span className="flex items-center gap-2">
              <Diff size={14} className="text-muted-foreground" /> Changes
            </span>
            <span className="flex items-center gap-2">
              {changedFileCount > 0 && (
                <span className="font-mono text-[11px] text-muted-foreground">
                  {changedFileCount} {changedFileCount === 1 ? "file" : "files"}
                </span>
              )}
              <Kbd>{changesShortcut}</Kbd>
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={copyBranch}
            data-testid="workspace-menu-branch"
            className="flex cursor-pointer items-center justify-between gap-3 text-xs"
          >
            <span className="flex items-center gap-2">
              <GitBranch size={14} className="text-muted-foreground" /> Branch
            </span>
            <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
              {branchCopied && <Check size={12} className="text-primary" />}
              <span className="max-w-[120px] truncate font-mono">{thread.branch}</span>
            </span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={handleCommitOrPush}
            data-testid="workspace-menu-commit"
            className="flex cursor-pointer items-center gap-2 text-xs"
          >
            <Upload size={14} className="text-muted-foreground" /> Commit or push
          </DropdownMenuItem>
          {prable && !pr && (
            <DropdownMenuItem
              onClick={() => setCreatePrOpen(true)}
              disabled={!hasCommitsAhead}
              data-testid="workspace-menu-create-pr"
              title={hasCommitsAhead === false ? "No commits ahead of base branch" : undefined}
              className="flex cursor-pointer items-center gap-2 text-xs data-disabled:cursor-not-allowed"
            >
              <GitPullRequest size={14} className="text-muted-foreground" /> Create PR
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Dedicated right-panel toggle for the workspace-global panel. */}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={togglePanel}
              aria-label="Toggle panel"
              aria-pressed={panelVisible}
              data-testid="header-panel-toggle"
              className={
                panelVisible
                  ? "cursor-pointer text-foreground bg-muted/40"
                  : "cursor-pointer text-foreground/70 hover:text-foreground hover:bg-muted/40"
              }
            >
              <PanelRight size={14} />
            </Button>
          }
        />
        <TooltipContent side="bottom" className="text-xs">
          Toggle panel
        </TooltipContent>
      </Tooltip>

      {prable && (
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
