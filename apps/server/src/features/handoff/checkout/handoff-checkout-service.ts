import { delay, inject, injectable } from "tsyringe";
import type { Thread } from "@mcode/contracts";
import { WorkspaceRepo } from "../../projects/persistence/workspace-repo.js";
import { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";
import { GitService } from "../../projects/index.js";

/** Owns branch creation and checkout-state synchronization for thread handoffs. */
@injectable()
export class HandoffCheckoutService {
  constructor(
    @inject(ThreadRepo) private readonly threadRepo: ThreadRepo,
    @inject(WorkspaceRepo) private readonly workspaceRepo: WorkspaceRepo,
    @inject(delay(() => GitService)) private readonly gitService: GitService,
  ) {}

  /** Create a named branch in a thread's resolved checkout and persist its state. */
  async createBranchForThread(
    workspaceId: string,
    threadId: string | undefined,
    name: string,
  ): Promise<string> {
    const workspace = this.workspaceRepo.findById(workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);

    let path = workspace.path;
    if (threadId) {
      const thread = this.threadRepo.findById(threadId);
      if (!thread) throw new Error(`Thread not found: ${threadId}`);
      if (thread.workspace_id !== workspaceId) {
        throw new Error(`Thread ${threadId} does not belong to workspace ${workspaceId}`);
      }
      path = this.gitService.resolveWorkingDir(
        workspace.path,
        thread.mode,
        thread.worktree_path,
      );
    }

    const branch = await this.gitService.createBranch(path, name);
    if (threadId) {
      const updated = this.threadRepo.updateCheckoutToNamedBranch(threadId, branch);
      if (!updated) {
        throw new Error(
          `Failed to update checkout state for thread ${threadId}`,
        );
      }
    }
    return branch;
  }

  /** Synchronize a worktree thread's persisted checkout state from its Git HEAD. */
  async syncCheckoutFromHead(threadId: string): Promise<{ thread: Thread; changed: boolean } | null> {
    const thread = this.threadRepo.findById(threadId);
    if (!thread || thread.mode !== "worktree" || !thread.worktree_path) return null;

    const currentBranch = await this.gitService.getCurrentBranchAt(thread.worktree_path);
    const detached = !currentBranch || currentBranch === "HEAD";
    const branch = detached ? "HEAD" : currentBranch;
    const checkoutState = detached ? "branchless" : "named";
    const baseBranch = detached
      ? thread.base_branch ?? (thread.branch !== "HEAD" ? thread.branch : null)
      : null;

    return this.threadRepo.updateCheckoutFromHead(
      threadId,
      branch,
      checkoutState,
      baseBranch,
    );
  }
}
