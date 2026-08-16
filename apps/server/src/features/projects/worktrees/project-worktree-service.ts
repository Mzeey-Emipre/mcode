import { inject, injectable } from "tsyringe";
import { sanitizeBranchForFolder, validateBranchName, logger } from "@mcode/shared";
import type { Thread } from "@mcode/contracts";
import { CleanupJobRepo } from "../../../repositories/cleanup-job-repo.js";
import { ThreadRepo } from "../../../repositories/thread-repo.js";
import { WorkspaceRepo } from "../../../repositories/workspace-repo.js";
import { GitService } from "../git/git-service.js";

function managedWorktreeName(ref: string, threadId: string): string {
  return `${sanitizeBranchForFolder(ref).slice(0, 91)}-${threadId.slice(0, 8)}`;
}

/** Owns project worktree provisioning, rollback, and cleanup scheduling. */
@injectable()
export class ProjectWorktreeService {
  constructor(
    @inject(ThreadRepo) private readonly threadRepo: ThreadRepo,
    @inject(WorkspaceRepo) private readonly workspaceRepo: WorkspaceRepo,
    @inject(CleanupJobRepo) private readonly cleanupJobRepo: CleanupJobRepo,
    @inject(GitService) private readonly gitService: GitService,
  ) {}

  /** Provision a worktree for a newly-created thread and persist its path. */
  async provisionThreadWorktree(
    thread: Thread,
    workspaceId: string,
    branch: string,
    options: { branchless?: boolean } = {},
  ): Promise<Thread & { warnings?: string[] }> {
    const workspace = this.workspaceRepo.findById(workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);

    const worktreeName = managedWorktreeName(branch, thread.id);
    const info = await this.gitService.createWorktree(
      workspace.path,
      worktreeName,
      branch,
      { branchless: options.branchless },
    );

    this.threadRepo.updateStatus(thread.id, "active");
    const updated = this.threadRepo.updateWorktreePath(thread.id, info.path);
    if (!updated) {
      try {
        const rollbackOptions = info.createdBranch
          ? { branchName: branch }
          : { deleteBranch: false };
        const cleaned = await this.gitService.removeWorktree(
          workspace.path,
          worktreeName,
          rollbackOptions,
        );
        if (!cleaned) {
          logger.warn("Rollback worktree cleanup returned false during thread creation", {
            threadId: thread.id,
            worktreeName,
            workspacePath: workspace.path,
          });
        }
      } catch (err) {
        logger.warn("Rollback worktree cleanup failed during thread creation", {
          threadId: thread.id,
          worktreeName,
          workspacePath: workspace.path,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      throw new Error(`Failed to persist worktree path for thread ${thread.id}`);
    }

    return {
      ...thread,
      worktree_path: info.path,
      warnings: info.warnings.length > 0 ? info.warnings : undefined,
    };
  }

  /** Provision a new worktree for an already-persisted delegated thread. */
  async provisionWorktree(
    threadId: string,
    workspaceId: string,
    placement: { baseRef: string; branchName?: string },
  ): Promise<Thread & { warnings?: string[] }> {
    const thread = this.threadRepo.findById(threadId);
    if (!thread || thread.workspace_id !== workspaceId || thread.mode !== "worktree") {
      throw new Error("Delegated worktree thread is not available for provisioning");
    }
    if (thread.worktree_path) {
      throw new Error("Delegated worktree thread is already provisioned");
    }
    validateBranchName(placement.baseRef);
    if (placement.branchName) validateBranchName(placement.branchName);
    const workspace = this.workspaceRepo.findById(workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);

    const worktreeRef = placement.branchName ?? placement.baseRef;
    const worktreeName = managedWorktreeName(worktreeRef, thread.id);
    const info = await this.gitService.createWorktree(
      workspace.path,
      worktreeName,
      worktreeRef,
      {
        branchless: placement.branchName === undefined,
        ...(placement.branchName ? { baseRef: placement.baseRef } : {}),
      },
    );
    const updated = this.threadRepo.updateWorktreePath(thread.id, info.path);
    if (!updated) {
      await this.gitService.removeWorktree(workspace.path, worktreeName, {
        ...(info.createdBranch ? { branchName: worktreeRef } : { deleteBranch: false }),
      });
      throw new Error(`Failed to persist worktree path for thread ${thread.id}`);
    }
    this.threadRepo.updateStatus(thread.id, "active");
    return {
      ...thread,
      worktree_path: info.path,
      warnings: info.warnings.length > 0 ? info.warnings : undefined,
    };
  }

  /** Idempotently remove only the deterministic managed worktree for interrupted provisioning. */
  async cleanupInterruptedProvisioning(
    threadId: string,
    workspaceId: string,
    placement: { baseRef: string; branchName?: string },
  ): Promise<boolean> {
    const workspace = this.workspaceRepo.findById(workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
    const ref = placement.branchName ?? placement.baseRef;
    const name = managedWorktreeName(ref, threadId);
    return this.gitService.removeWorktree(workspace.path, name, { deleteBranch: false });
  }

  /** Check ownership and enqueue cleanup for one managed worktree. */
  async scheduleCleanup(threadId: string): Promise<boolean> {
    const thread = this.threadRepo.findById(threadId);
    if (!thread || thread.deleted_at !== null || !thread.worktree_path || !thread.worktree_managed) {
      return false;
    }

    const worktreePath = thread.worktree_path;
    const workspace = this.workspaceRepo.findById(thread.workspace_id);
    if (!workspace) {
      logger.warn("Worktree cleanup skipped - workspace not found, directory will not be removed", {
        threadId,
        workspaceId: thread.workspace_id,
        worktreePath,
      });
      return false;
    }

    const current = this.threadRepo.findById(threadId);
    if (
      !current
      || current.deleted_at !== null
      || !current.worktree_managed
      || current.worktree_path !== worktreePath
    ) {
      return false;
    }

    const siblings = this.threadRepo.listActiveSiblingWorktreePaths(threadId);
    const safety = await this.gitService.assessWorktreeRemovalSafety(
      current.worktree_path,
      siblings.paths,
      siblings.truncated,
    );
    if (!safety.safe) {
      logger.info("Worktree cleanup skipped because ownership is not exclusive", {
        threadId,
        worktreePath: current.worktree_path,
        reason: safety.reason,
      });
      return false;
    }

    this.cleanupJobRepo.insert({
      thread_id: threadId,
      workspace_path: workspace.path,
      worktree_path: current.worktree_path,
      branch: current.branch,
    });
    logger.info("Worktree cleanup job enqueued", {
      threadId,
      worktreePath: current.worktree_path,
    });
    return this.threadRepo.softDelete(threadId);
  }
}
