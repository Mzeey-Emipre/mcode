/**
 * Thread lifecycle service.
 * Manages thread creation, deletion, worktree provisioning, and status transitions.
 * Extracted from apps/desktop/src/main/app-state.ts.
 */

import { injectable, inject } from "tsyringe";
import { validateBranchName } from "@mcode/shared";
import type { Thread, ThreadMode } from "@mcode/contracts";
import { ThreadRepo } from "../repositories/thread-repo";
import { WorkspaceRepo } from "../repositories/workspace-repo";
import { GitService } from "./git-service";

/** Handles thread creation, deletion, worktree provisioning, and lifecycle. */
@injectable()
export class ThreadService {
  constructor(
    @inject(ThreadRepo) private readonly threadRepo: ThreadRepo,
    @inject(WorkspaceRepo) private readonly workspaceRepo: WorkspaceRepo,
    @inject(GitService) private readonly gitService: GitService,
  ) {}

  /**
   * Create a thread with optional worktree provisioning.
   * If mode is "worktree", creates a git worktree on disk and persists its path.
   * Rolls back DB record on any failure.
   */
  create(
    workspaceId: string,
    title: string,
    mode: string,
    branch: string,
  ): Thread {
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

      const sanitizedTitle = title
        .split("")
        .map((c) => (/[a-zA-Z0-9-]/.test(c) ? c : "-"))
        .join("")
        .toLowerCase();
      const shortId = thread.id.slice(0, 8);
      const worktreeName = `${sanitizedTitle}-${shortId}`;

      try {
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
            this.gitService.removeWorktree(
              workspace.path,
              worktreeName,
              branch,
            );
          } catch {
            // best-effort cleanup
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
   * Delete a thread. Optionally removes the worktree from disk and
   * soft-deletes the DB record.
   */
  delete(threadId: string, cleanupWorktree: boolean): boolean {
    if (cleanupWorktree) {
      const thread = this.threadRepo.findById(threadId);
      if (thread?.worktree_path && thread.worktree_managed) {
        const workspace = this.workspaceRepo.findById(thread.workspace_id);
        if (workspace) {
          const wtName =
            thread.worktree_path
              .replace(/\\/g, "/")
              .split("/")
              .pop() ?? thread.worktree_path;
          try {
            this.gitService.removeWorktree(
              workspace.path,
              wtName,
              thread.branch,
            );
          } catch {
            // Non-fatal: worktree may already be gone
          }
        }
      }
    }

    return this.threadRepo.softDelete(threadId);
  }

  /** Update a thread's display title. */
  updateTitle(threadId: string, title: string): boolean {
    return this.threadRepo.updateTitle(threadId, title);
  }

  /** Mark a thread as viewed by touching its updated_at timestamp. */
  markViewed(threadId: string): void {
    this.threadRepo.updateStatus(
      threadId,
      this.threadRepo.findById(threadId)?.status ?? "completed",
    );
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
