/**
 * Thread lifecycle service.
 * Manages thread creation, deletion, worktree provisioning, and status transitions.
 * Extracted from apps/desktop/src/main/app-state.ts.
 */

import { injectable, inject } from "tsyringe";
import { validateBranchName, sanitizeBranchForFolder, logger } from "@mcode/shared";
import type { Thread, ThreadMode } from "@mcode/contracts";
import { ThreadRepo } from "../repositories/thread-repo";
import { WorkspaceRepo } from "../repositories/workspace-repo";
import { GitService } from "./git-service";
import { CleanupJobRepo } from "../repositories/cleanup-job-repo";

/** Handles thread creation, deletion, worktree provisioning, and lifecycle. */
@injectable()
export class ThreadService {
  constructor(
    @inject(ThreadRepo) private readonly threadRepo: ThreadRepo,
    @inject(WorkspaceRepo) private readonly workspaceRepo: WorkspaceRepo,
    @inject(GitService) private readonly gitService: GitService,
    @inject(CleanupJobRepo) private readonly cleanupJobRepo: CleanupJobRepo,
  ) {}

  /**
   * Create a thread with optional worktree provisioning.
   * If mode is "worktree", creates a git worktree on disk and persists its path.
   * Rolls back DB record on any failure.
   */
  async create(
    workspaceId: string,
    title: string,
    mode: string,
    branch: string,
  ): Promise<Thread> {
    validateBranchName(branch);

    const threadMode: ThreadMode =
      mode === "worktree" || mode === "direct"
        ? mode
        : (() => {
            throw new Error(`Unknown thread mode: ${mode}`);
          })();

    const thread = this.threadRepo.create(
      workspaceId,
      title,
      threadMode,
      branch,
    );

    if (threadMode === "worktree") {
      const workspace = this.workspaceRepo.findById(workspaceId);
      if (!workspace) {
        this.threadRepo.hardDelete(thread.id);
        throw new Error(`Workspace not found: ${workspaceId}`);
      }

      try {
        const shortId = thread.id.slice(0, 8);
        // Truncate to 91 chars so the full name (prefix + "-" + 8-char id) stays within
        // the 100-character limit enforced by validateWorktreeName.
        const sanitized = sanitizeBranchForFolder(branch).slice(0, 91);
        const worktreeName = `${sanitized}-${shortId}`;
        const info = this.gitService.createWorktree(
          workspace.path,
          worktreeName,
          branch,
        );

        this.threadRepo.updateStatus(thread.id, "active");
        const updated = this.threadRepo.updateWorktreePath(
          thread.id,
          info.path,
        );

        if (!updated) {
          try {
            const cleaned = await this.gitService.removeWorktree(
              workspace.path,
              worktreeName,
              branch,
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
          this.threadRepo.hardDelete(thread.id);
          throw new Error(
            `Failed to persist worktree path for thread ${thread.id}`,
          );
        }

        return { ...thread, worktree_path: info.path };
      } catch (err) {
        this.threadRepo.hardDelete(thread.id);
        throw err;
      }
    }

    return thread;
  }

  /** List non-deleted threads for a workspace. */
  list(workspaceId: string): Thread[] {
    return this.threadRepo.listByWorkspace(workspaceId);
  }

  /**
   * Soft-delete a thread and enqueue a background cleanup job when the thread
   * has a managed worktree. The cleanup job handles process termination,
   * filesystem removal, and hard-deletion of the DB row asynchronously with
   * exponential backoff retries. The job's branch field is set from
   * thread.branch; branches prefixed with "mcode/" are deleted by the worker.
   */
  delete(threadId: string, cleanupWorktree: boolean): boolean {
    if (cleanupWorktree) {
      const thread = this.threadRepo.findById(threadId);
      if (thread?.worktree_path && thread.worktree_managed) {
        const workspace = this.workspaceRepo.findById(thread.workspace_id);
        if (workspace) {
          this.cleanupJobRepo.insert({
            thread_id: threadId,
            workspace_path: workspace.path,
            worktree_path: thread.worktree_path,
            branch: thread.branch,
          });
          logger.info("Worktree cleanup job enqueued", {
            threadId,
            worktreePath: thread.worktree_path,
          });
        } else {
          logger.warn("Worktree cleanup skipped - workspace not found, directory will not be removed", {
            threadId,
            workspaceId: thread.workspace_id,
            worktreePath: thread.worktree_path,
          });
        }
      }
    }

    return this.threadRepo.softDelete(threadId);
  }

  /** Update a thread's display title. */
  updateTitle(threadId: string, title: string): boolean {
    return this.threadRepo.updateTitle(threadId, title);
  }

  /** Link a GitHub PR to a thread by updating pr_number and pr_status. Throws on failure. */
  linkPr(threadId: string, prNumber: number, prStatus: string): void {
    const ok = this.threadRepo.updatePr(threadId, prNumber, prStatus);
    if (!ok) {
      throw new Error(`Failed to link PR #${prNumber} to thread ${threadId}`);
    }
  }

  /** Mark a thread as viewed, dismissing the completed badge if present. */
  markViewed(threadId: string): void {
    const thread = this.threadRepo.findById(threadId);
    if (!thread || thread.status !== "completed") return;
    this.threadRepo.updateStatus(threadId, "paused");
  }

  /** Mark all active threads as interrupted (for graceful shutdown). */
  markActiveThreadsInterrupted(activeThreadIds: string[]): void {
    for (const threadId of activeThreadIds) {
      try {
        this.threadRepo.updateStatus(threadId, "interrupted");
      } catch {
        // best-effort
      }
    }
  }

  /** Find a thread by its primary key. */
  findById(threadId: string): Thread | null {
    return this.threadRepo.findById(threadId);
  }
}
