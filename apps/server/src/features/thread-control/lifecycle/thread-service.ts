/**
 * Thread lifecycle service.
 * Manages thread creation, deletion, worktree provisioning, and status transitions.
 * Extracted from apps/desktop/src/main/app-state.ts.
 */

import { injectable, inject } from "tsyringe";
import { validateBranchName, logger } from "@mcode/shared";
import type { Thread, RecentThread, ThreadMode, ContextWindowMode } from "@mcode/contracts";
import { ThreadRepo } from "../persistence/thread-repo.js";
import { ProjectWorktreeService } from "../../projects/index.js";
import { AttachmentService } from "../../attachments/storage/attachment-service.js";
import { HandoffStorage } from "../../handoff/index.js";

/** Handles thread creation, deletion, worktree provisioning, and lifecycle. */
@injectable()
export class ThreadService {
  constructor(
    @inject(ThreadRepo) private readonly threadRepo: ThreadRepo,
    @inject(ProjectWorktreeService) private readonly projectWorktreeService: ProjectWorktreeService,
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
      try {
        return await this.projectWorktreeService.provisionThreadWorktree(
          thread,
          workspaceId,
          branch,
          options,
        );
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
      if (await this.projectWorktreeService.scheduleCleanup(threadId)) return true;
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

  /** Find a thread by its primary key. */
  findById(threadId: string): Thread | null {
    return this.threadRepo.findById(threadId);
  }

}
