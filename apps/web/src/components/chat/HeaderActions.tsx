import { useCallback, useState } from "react";
import { Menu, PanelRight, Diff, GitBranch, Upload, Check, GitPullRequest } from "lucide-react";
import { OpenInAppButton } from "./OpenInAppButton";
import { CreatePrDialog } from "./CreatePrDialog";
import { PrSplitButton } from "./PrSplitButton";
import { useThreadGitActions } from "@/hooks/useThreadGitActions";
import { useDiffStore } from "@/stores/diffStore";
import { toggleRightPanelAdaptive } from "@/lib/right-panel-layout";
import { executeCommand } from "@/lib/command-registry";
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
  const [branchCopied, setBranchCopied] = useState(false);

  // Commit-or-push + Create-PR orchestration is shared with the Review toolbar.
  const {
    prable,
    pr,
    hasCommitsAhead,
    checks,
    openPrDetail,
    dirPath,
    createPrOpen,
    setCreatePrOpen,
    handleCommitOrPush,
    handleOpenPr,
  } = useThreadGitActions(thread);

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
    toggleRightPanelAdaptive(thread.workspace_id, thread.id);
  }, [thread.workspace_id, thread.id]);

  const openChanges = useCallback(() => {
    executeCommand("changes.toggle");
  }, []);

  // Mirror the live keybinding so the menu hint stays correct if the user rebinds it.
  const changesShortcut = formatKeybinding(
    getKeybindingForCommand("changes.toggle")?.key ?? "mod+d",
    isMac,
  );

  // Live keycap for the right-panel toggle, shown in the button's tooltip.
  const panelShortcut = formatKeybinding(
    getKeybindingForCommand("rightPanel.toggle")?.key ?? "mod+alt+b",
    isMac,
  );

  const copyBranch = useCallback(() => {
    void navigator.clipboard?.writeText(thread.branch);
    setBranchCopied(true);
    setTimeout(() => setBranchCopied(false), 1500);
  }, [thread.branch]);

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
          Toggle panel{" "}
          <span className="text-foreground">{panelShortcut}</span>
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
