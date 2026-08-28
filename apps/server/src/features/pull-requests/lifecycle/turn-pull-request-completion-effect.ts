import { logger } from "@mcode/shared";
import type { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";
import type { WorkspaceRepo } from "../../projects/persistence/workspace-repo.js";
import type { ThreadService } from "../../thread-control/index.js";
import type { GithubService } from "../github/github-service.js";
import type { CiWatcherService } from "../status/ci-watcher.js";

/** Refreshes a feature-branch pull-request link after a turn is terminally published. */
export class TurnPullRequestCompletionEffect {
  constructor(
    private readonly threads: ThreadRepo,
    private readonly workspaces: WorkspaceRepo,
    private readonly threadService: ThreadService,
    private readonly github: GithubService,
    private readonly ciWatcher: CiWatcherService,
    private readonly publishLinked: (payload: { threadId: string; prNumber: number; prStatus: string }) => void,
  ) {}

  /** Start a non-blocking pull-request refresh for one completed turn. */
  schedule(threadId: string): void {
    void this.refresh(threadId).catch((error: unknown) => {
      logger.debug("PR lookup failed on completed turn", {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private async refresh(threadId: string): Promise<void> {
    const target = this.target(threadId);
    if (!target) return;
    const pr = await this.github.getBranchPr(target.branch, target.workspacePath);
    if (!pr) return;
    this.updateLink(target.threadId, target.currentNumber, target.currentStatus, pr.number, pr.state);
    this.updateWatcher(target.threadId, pr.number, target.branch, target.workspacePath, pr.state);
  }

  private target(threadId: string): {
    threadId: string;
    branch: string;
    workspacePath: string;
    currentNumber: number | null;
    currentStatus: string | null;
  } | null {
    const thread = this.threads.findById(threadId);
    if (!thread || thread.branch === "main" || thread.branch === "master") return null;
    const workspace = this.workspaces.findById(thread.workspace_id);
    if (!workspace) return null;
    return {
      threadId: thread.id,
      branch: thread.branch,
      workspacePath: workspace.path,
      currentNumber: thread.pr_number,
      currentStatus: thread.pr_status,
    };
  }

  private updateLink(
    threadId: string,
    currentNumber: number | null,
    currentStatus: string | null,
    number: number,
    status: string,
  ): void {
    if (currentNumber === number && currentStatus?.toLowerCase() === status.toLowerCase()) return;
    this.threadService.linkPr(threadId, number, status);
    this.publishLinked({ threadId, prNumber: number, prStatus: status });
  }

  private updateWatcher(
    threadId: string,
    number: number,
    branch: string,
    workspacePath: string,
    status: string,
  ): void {
    if (status.toLowerCase() === "merged" || status.toLowerCase() === "closed") {
      this.ciWatcher.unwatch(threadId);
      return;
    }
    this.ciWatcher.watch(threadId, number, branch, workspacePath);
  }
}
