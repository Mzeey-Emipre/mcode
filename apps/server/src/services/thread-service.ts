/**
 * Thread lifecycle service.
 * Manages thread creation, deletion, worktree provisioning, and status transitions.
 * Extracted from apps/desktop/src/main/app-state.ts.
 */

import { injectable, inject } from "tsyringe";
import { validateBranchName, sanitizeBranchForFolder, logger } from "@mcode/shared";
import type { Thread, RecentThread, ThreadMode, ContextWindowMode } from "@mcode/contracts";
import { ThreadRepo } from "../repositories/thread-repo";
import { WorkspaceRepo } from "../repositories/workspace-repo";
import { GitService } from "./git-service";
import { CleanupJobRepo } from "../repositories/cleanup-job-repo";
import { AttachmentService } from "./attachment-service";
import { HandoffStorage } from "./handoff/handoff-storage.js";

/** Handles thread creation, deletion, worktree provisioning, and lifecycle. */
@injectable()
export class ThreadService {
  constructor(
    @inject(ThreadRepo) private readonly threadRepo: ThreadRepo,
    @inject(WorkspaceRepo) private readonly workspaceRepo: WorkspaceRepo,
    @inject(GitService) private readonly gitService: GitService,
    @inject(CleanupJobRepo) private readonly cleanupJobRepo: CleanupJobRepo,
    @inject(AttachmentService) private readonly attachmentService: AttachmentService,
    @inject(HandoffStorage) private readonly handoffStorage: HandoffStorage,
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
    options: { branchless?: boolean } = {},
  ): Promise<Thread & { warnings?: string[] }> {
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
      true,
      "claude",
      undefined,
      options.branchless ? "branchless" : "named",
      options.branchless ? branch : null,
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
        const info = await this.gitService.createWorktree(
          workspace.path,
          worktreeName,
          branch,
          { branchless: options.branchless },
        );

        this.threadRepo.updateStatus(thread.id, "active");
        const updated = this.threadRepo.updateWorktreePath(
          thread.id,
          info.path,
        );

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
          this.threadRepo.hardDelete(thread.id);
          throw new Error(
            `Failed to persist worktree path for thread ${thread.id}`,
          );
        }

        return {
          ...thread,
          worktree_path: info.path,
          warnings: info.warnings.length > 0 ? info.warnings : undefined,
        };
      } catch (err) {
        this.threadRepo.hardDelete(thread.id);
        throw err;
      }
    }

    return thread;
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
    const shortId = thread.id.slice(0, 8);
    const sanitized = sanitizeBranchForFolder(worktreeRef).slice(0, 91);
    const worktreeName = `${sanitized}-${shortId}`;
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

  /** Remove only the deterministic managed worktree for an interrupted provisioning approval. */
  async cleanupInterruptedProvisioning(
    threadId: string,
    workspaceId: string,
    placement: { baseRef: string; branchName?: string },
  ): Promise<boolean> {
    const workspace = this.workspaceRepo.findById(workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
    const ref = placement.branchName ?? placement.baseRef;
    const name = `${sanitizeBranchForFolder(ref).slice(0, 91)}-${threadId.slice(0, 8)}`;
    return this.gitService.removeWorktree(workspace.path, name, { deleteBranch: false });
  }

  /**
   * Create a named branch in a thread's resolved checkout and persist the named checkout state.
   */
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

  /** List non-deleted threads for a workspace. */
  list(workspaceId: string): Thread[] {
    return this.threadRepo.listByWorkspace(workspaceId);
  }

  /** List the most recently updated threads across all workspaces (joined with workspace name + path). */
  listRecent(limit?: number): RecentThread[] {
    return this.threadRepo.listRecent(limit);
  }

  /** Search threads across all workspaces by display and checkout metadata. */
  search(opts: {
    query: string;
    filters?: { status?: string[]; provider?: string[] };
    sort?: { field: "updated_at" | "created_at" | "title"; direction: "asc" | "desc" };
    limit?: number;
  }) {
    return this.threadRepo.search(opts);
  }

  /**
   * Soft-delete a thread and enqueue a background cleanup job when the thread
   * has a worktree path. The cleanup job handles process termination,
   * filesystem removal, and hard-deletion of the DB row asynchronously with
   * exponential backoff retries. The job stores the thread's exact branch so
   * explicit user cleanup deletes the worktree and its associated thread branch.
   */
  async delete(threadId: string, cleanupWorktree: boolean): Promise<boolean> {
    const thread = this.threadRepo.findById(threadId);
    if (!thread || thread.deleted_at !== null) return false;

    if (cleanupWorktree && thread.worktree_path && thread.worktree_managed) {
      const worktreePath = thread.worktree_path;
      const workspace = this.workspaceRepo.findById(thread.workspace_id);
      if (workspace) {
        const current = this.threadRepo.findById(threadId);
        if (
          current
          && current.deleted_at === null
          && current.worktree_managed
          && current.worktree_path === worktreePath
        ) {
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
          } else {
            // The cleanup worker repeats this ownership check while holding the
            // repository lock. Keeping that lock out of the foreground RPC
            // prevents an unrelated cleanup from stalling the delete dialog.
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
            if (this.threadRepo.softDelete(threadId)) return true;
          }
        }
      } else {
        logger.warn("Worktree cleanup skipped - workspace not found, directory will not be removed", {
          threadId,
          workspaceId: thread.workspace_id,
          worktreePath: thread.worktree_path,
        });
      }
    } else if (cleanupWorktree && thread.worktree_path) {
      logger.info("Worktree cleanup skipped because the checkout is reused or unmanaged", {
        threadId,
        worktreePath: thread.worktree_path,
        managed: thread.worktree_managed,
      });
    }

    this.attachmentService.removeForThread(threadId);
    await this.handoffStorage.deleteThreadFiles(threadId);
    return this.threadRepo.hardDelete(threadId);
  }

  /** Update a thread's display title. */
  updateTitle(threadId: string, title: string): boolean {
    return this.threadRepo.updateTitle(threadId, title);
  }

  /** Persist per-thread composer settings (reasoning, mode, permission, copilot agent, context window, thinking). */
  updateSettings(
    threadId: string,
    settings: {
      reasoning_level?: string;
      interaction_mode?: string;
      orchestration_mode?: string;
      permission_mode?: string;
      copilot_agent?: string | null;
      context_window_mode?: ContextWindowMode | null;
      thinking?: boolean | null;
      codex_fast_mode?: boolean | null;
      default_open_in_app?: string | null;
    },
  ): boolean {
    return this.threadRepo.updateSettings(threadId, {
      ...(settings.reasoning_level !== undefined && { reasoning_level: settings.reasoning_level }),
      ...(settings.interaction_mode !== undefined && { interaction_mode: settings.interaction_mode }),
      ...(settings.orchestration_mode !== undefined && { orchestration_mode: settings.orchestration_mode }),
      ...(settings.permission_mode !== undefined && { permission_mode: settings.permission_mode }),
      ...("copilot_agent" in settings && { copilot_agent: settings.copilot_agent }),
      ...("context_window_mode" in settings && { context_window_mode: settings.context_window_mode }),
      ...("thinking" in settings && { thinking: settings.thinking }),
      ...("codex_fast_mode" in settings && { codex_fast_mode: settings.codex_fast_mode }),
      ...("default_open_in_app" in settings && { default_open_in_app: settings.default_open_in_app }),
    });
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

  /**
   * Sync a worktree thread's persisted checkout state from its current Git HEAD.
   */
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
