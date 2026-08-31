import { GitPullRequest, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CreatePrDialog } from "@/components/chat/CreatePrDialog";
import { useThreadGitActions } from "@/hooks/useThreadGitActions";
import type { Thread } from "@/transport";

/** Props for {@link ReviewActions}. */
interface ReviewActionsProps {
  /** The active worktree thread whose changes the toolbar is reviewing. */
  thread: Thread;
}

const ACTION_CLASS =
  "h-6 gap-1.5 px-2 text-xs text-foreground/70 hover:bg-muted/40 hover:text-foreground";

/**
 * Commit-or-push and Create-PR actions for the Review toolbar, mirroring the
 * chat header. "Commit or push" prefills the composer with an agent
 * instruction; "Create PR" opens the shared `CreatePrDialog`, and once a PR
 * exists the button becomes a link to it. Reuses {@link useThreadGitActions} so
 * the logic and PR state stay in one place. Renders nothing for direct-mode
 * (non-worktree) threads, which can't own a PR.
 */
export function ReviewActions({ thread }: ReviewActionsProps) {
  const {
    prable,
    pr,
    hasCommitsAhead,
    dirPath,
    createPrOpen,
    setCreatePrOpen,
    handleCommitOrPush,
    handleOpenPr,
  } = useThreadGitActions(thread);

  // Both actions need a worktree thread: somewhere to commit, a branch to PR.
  if (!prable || !dirPath) return null;

  return (
    <div className="flex items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="xs"
              onClick={handleCommitOrPush}
              data-testid="review-commit-or-push"
              className={ACTION_CLASS}
            >
              <Upload size={12} />
              <span>Commit or push</span>
            </Button>
          }
        />
        <TooltipContent side="bottom" className="text-xs">
          Ask the agent to commit and push the changes
        </TooltipContent>
      </Tooltip>

      {pr ? (
        <Button
          variant="ghost"
          size="xs"
          onClick={(event) => handleOpenPr(pr.url, event)}
          data-testid="review-open-pr"
          className={ACTION_CLASS}
        >
          <GitPullRequest size={12} />
          <span>PR #{pr.number}</span>
        </Button>
      ) : (
        <Tooltip>
          <TooltipTrigger
            render={
              hasCommitsAhead === false ? (
                <span className="inline-flex">
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => setCreatePrOpen(true)}
                    disabled
                    data-testid="review-create-pr"
                    className={`${ACTION_CLASS} disabled:cursor-not-allowed disabled:opacity-50`}
                  >
                    <GitPullRequest size={12} />
                    <span>Create PR</span>
                  </Button>
                </span>
              ) : (
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => setCreatePrOpen(true)}
                  disabled={!hasCommitsAhead}
                  data-testid="review-create-pr"
                  className={`${ACTION_CLASS} disabled:cursor-not-allowed disabled:opacity-50`}
                >
                  <GitPullRequest size={12} />
                  <span>Create PR</span>
                </Button>
              )
            }
          />
          {hasCommitsAhead === false ? (
            <TooltipContent side="bottom" className="text-xs">
              No commits ahead of base branch
            </TooltipContent>
          ) : null}
        </Tooltip>
      )}

      <CreatePrDialog
        open={createPrOpen}
        onOpenChange={setCreatePrOpen}
        threadId={thread.id}
        workspaceId={thread.workspace_id}
        branch={thread.branch}
      />
    </div>
  );
}
