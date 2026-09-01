import { inject, injectable } from "tsyringe";
import { sanitizeBranchForFolder, validateBranchName, logger } from "@mcode/shared";
import type { Thread } from "@mcode/contracts";
import { CleanupJobRepo } from "../../thread-control/cleanup/persistence/cleanup-job-repo.js";
import { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";
import { WorkspaceRepo } from "../persistence/workspace-repo.js";
import { GitWorktreeService } from "../git/git-worktree-service.js";
import { SandboxWorktreeCleanupPolicy } from "./sandbox-worktree-cleanup-policy.js";

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
    @inject(GitWorktreeService) private readonly gitWorktrees: GitWorktreeService,
    @inject(SandboxWorktreeCleanupPolicy) private readonly cleanupPolicy: SandboxWorktreeCleanupPolicy,
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
    const info = await this.gitWorktrees.createWorktree(
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
        const cleaned = await this.gitWorktrees.removeWorktree(
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
    const thread = this.requireProvisionableThread(threadId, workspaceId);
    const workspace = this.requireWorkspace(workspaceId);
    validateWorktreePlacement(placement);
    const provisioned = await this.createDelegatedWorktree(thread, workspace.path, placement);
    await this.persistDelegatedWorktree(thread, workspace.path, provisioned);
    this.threadRepo.updateStatus(thread.id, "active");
    return {
      ...thread,
      worktree_path: provisioned.info.path,
      warnings: provisioned.info.warnings.length > 0 ? provisioned.info.warnings : undefined,
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
    return this.gitWorktrees.removeWorktree(workspace.path, name, { deleteBranch: false });
  }

  /** Enqueue checkout cleanup when Mcode owns the sandbox worktree. */
  async scheduleCleanup(threadId: string): Promise<boolean> {
    const thread = this.getWorktreeCleanupCandidate(threadId);
    if (!thread) return false;
    const worktreePath = thread.worktree_path;
    if (!worktreePath) return false;
    const workspace = this.workspaceRepo.findById(thread.workspace_id);
    if (!workspace) {
      logger.warn("Worktree cleanup skipped because the workspace no longer exists", {
        threadId,
        workspaceId: thread.workspace_id,
        worktreePath,
      });
      return false;
    }

    const firstDecision = await this.cleanupPolicy.decide({
      workspacePath: workspace.path,
      worktreePath,
    });
    if (firstDecision.action === "retain") return false;

    const current = this.getCurrentCleanupCandidate(threadId, worktreePath);
    if (!current || current.worktree_path !== worktreePath) return false;
    const currentDecision = await this.cleanupPolicy.decide({
      workspacePath: workspace.path,
      worktreePath: current.worktree_path,
    });
    if (currentDecision.action === "retain") return false;
    this.cleanupJobRepo.insert({
      thread_id: threadId,
      workspace_path: workspace.path,
      worktree_path: current.worktree_path,
      branch: currentDecision.branch,
    });
    logger.info("Worktree cleanup job enqueued", { threadId, worktreePath: current.worktree_path });
    return this.threadRepo.softDelete(threadId);
  }

  private requireProvisionableThread(threadId: string, workspaceId: string): Thread {
    const thread = this.threadRepo.findById(threadId);
    if (!thread || thread.workspace_id !== workspaceId || thread.mode !== "worktree") {
      throw new Error("Delegated worktree thread is not available for provisioning");
    }
    if (thread.worktree_path) throw new Error("Delegated worktree thread is already provisioned");
    return thread;
  }

  private requireWorkspace(workspaceId: string) {
    const workspace = this.workspaceRepo.findById(workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
    return workspace;
  }

  private async createDelegatedWorktree(
    thread: Thread,
    workspacePath: string,
    placement: { baseRef: string; branchName?: string },
  ): Promise<{ info: Awaited<ReturnType<GitWorktreeService["createWorktree"]>>; name: string; ref: string }> {
    const ref = placement.branchName ?? placement.baseRef;
    const name = managedWorktreeName(ref, thread.id);
    const info = await this.gitWorktrees.createWorktree(
      workspacePath,
      name,
      ref,
      delegatedWorktreeOptions(placement),
    );
    return { info, name, ref };
  }

  private async persistDelegatedWorktree(
    thread: Thread,
    workspacePath: string,
    provisioned: { info: Awaited<ReturnType<GitWorktreeService["createWorktree"]>>; name: string; ref: string },
  ): Promise<void> {
    if (this.threadRepo.updateWorktreePath(thread.id, provisioned.info.path)) return;
    await this.gitWorktrees.removeWorktree(workspacePath, provisioned.name, rollbackOptions(provisioned));
    throw new Error(`Failed to persist worktree path for thread ${thread.id}`);
  }

  private getWorktreeCleanupCandidate(threadId: string): Thread | null {
    const thread = this.threadRepo.findById(threadId);
    if (!thread || thread.deleted_at !== null || !thread.worktree_path) return null;
    return thread;
  }

  private getCurrentCleanupCandidate(threadId: string, worktreePath: string): Thread | null {
    const current = this.getWorktreeCleanupCandidate(threadId);
    return current?.worktree_path === worktreePath ? current : null;
  }
}

function validateWorktreePlacement(placement: { baseRef: string; branchName?: string }): void {
  validateBranchName(placement.baseRef);
  if (placement.branchName) validateBranchName(placement.branchName);
}

function delegatedWorktreeOptions(placement: { baseRef: string; branchName?: string }): { branchless: boolean; baseRef?: string } {
  return placement.branchName
    ? { branchless: false, baseRef: placement.baseRef }
    : { branchless: true };
}

function rollbackOptions(provisioned: { info: { createdBranch: boolean }; ref: string }): { branchName: string } | { deleteBranch: false } {
  return provisioned.info.createdBranch ? { branchName: provisioned.ref } : { deleteBranch: false };
}
