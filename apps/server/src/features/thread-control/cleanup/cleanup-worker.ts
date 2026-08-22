/**
 * Background worker that drains the cleanup_jobs queue.
 * Processes one job at a time to avoid git lock contention.
 * Retries with exponential backoff on failure.
 * Retry counters persist across app restarts so exhausted work stays blocked.
 */

import { injectable, inject } from "tsyringe";
import { isAbsolute, relative, resolve, sep } from "path";
import { existsSync, realpathSync } from "fs";
import type Database from "better-sqlite3";
import { getMcodeDir, logger } from "@mcode/shared";
import { CleanupJobRepo, MAX_CLEANUP_ATTEMPTS } from "./persistence/cleanup-job-repo.js";
import type { CleanupJob } from "./persistence/cleanup-job-repo.js";
import { ThreadRepo } from "../persistence/thread-repo.js";
import { ClaudeProvider } from "../../providers/adapters/claude/claude-provider.js";
import { TerminalBackend, TERMINAL_BACKEND_TOKEN } from "../../terminal/backends/terminal-backend.js";
import { GitService } from "../../projects/index.js";
import { AttachmentService } from "../../attachments/storage/attachment-service.js";
import { killDescendantsByName } from "../../../runtime/process/containment/process-kill.js";
import { WorkspaceRepo } from "../../projects/persistence/workspace-repo.js";
import { broadcast } from "../../../application/transport/push.js";
import { HandoffStorage } from "../../handoff/index.js";
import { pruneStaleToolOutputArtifacts } from "@mcode/providers";
import { ThreadControlMutationReservationService } from "../index.js";
import { SettingsService } from "../../settings/settings-service.js";
import { WorkspaceEnvironmentService } from "../../projects/environment/workspace-environment-service.js";

/** How often to check for due cleanup jobs (ms). */
const POLL_INTERVAL_MS = 5_000;

/**
 * Grace period after signalling process termination on Windows.
 * Gives the OS time to release directory handles before fs operations.
 * 1.5 s gives Windows enough time to release directory handles after process
 * termination, including antivirus scans triggered by the process exit.
 */
const HANDLE_RELEASE_DELAY_MS = 1_500;

/**
 * Timeout waiting for the SDK subprocess to acknowledge close()
 * before proceeding with filesystem cleanup.
 */
const SESSION_EXIT_TIMEOUT_MS = 5_000;

type RetentionBlockCode =
  | "missing-base-branch"
  | "workspace-repository-inaccessible"
  | "worktree-safety";

/**
 * Drains the cleanup_jobs table with retry logic.
 * Must be started via start() after DI is fully resolved.
 * Call shutdown() during graceful shutdown to await an active poll.
 */
@injectable()
export class CleanupWorker {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private stopped = false;
  private pollPromise: Promise<void> | null = null;
  private readonly mutationReservations: ThreadControlMutationReservationService;

  constructor(
    @inject("Database") private readonly db: Database.Database,
    @inject(CleanupJobRepo) private readonly cleanupJobRepo: CleanupJobRepo,
    @inject(ThreadRepo) private readonly threadRepo: ThreadRepo,
    @inject(ClaudeProvider) private readonly claudeProvider: ClaudeProvider,
    @inject(TERMINAL_BACKEND_TOKEN) private readonly terminalService: TerminalBackend,
    @inject(GitService) private readonly gitService: GitService,
    @inject(WorkspaceRepo) private readonly workspaceRepo: WorkspaceRepo,
    @inject(AttachmentService) private readonly attachmentService: AttachmentService,
    @inject(HandoffStorage) private readonly handoffStorage: HandoffStorage,
    @inject(WorkspaceEnvironmentService)
    private readonly workspaceEnvironmentService: WorkspaceEnvironmentService,
    @inject(ThreadControlMutationReservationService, { isOptional: true })
    mutationReservations?: ThreadControlMutationReservationService,
    @inject(SettingsService, { isOptional: true })
    private readonly settingsService?: SettingsService,
  ) {
    this.mutationReservations = mutationReservations
      ?? new ThreadControlMutationReservationService();
  }

  /**
   * Start the worker and begin polling for due jobs.
   */
  start(): void {
    if (this.pollTimer !== null) return;
    const removedArtifacts = pruneStaleToolOutputArtifacts();
    if (removedArtifacts > 0) {
      logger.info("Pruned stale tool-output artifacts", { removed: removedArtifacts });
    }
    void this.reconcileOnStartup().catch((err) => {
      logger.error("CleanupWorker startup reconciliation errored", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    this.stopped = false;
    this.pollTimer = setInterval(() => {
      this.poll().catch((err) => {
        logger.error("CleanupWorker poll errored", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, POLL_INTERVAL_MS);

    logger.info("CleanupWorker started");
  }

  /**
   * Stop admitting new work without waiting for an active poll.
   * Use shutdown() when graceful shutdown must await that poll.
   */
  dispose(): void {
    this.stopAdmission();
  }

  /** Stop admission and wait for a poll that already started to settle. */
  async shutdown(): Promise<void> {
    this.stopAdmission();
    await this.pollPromise;
  }

  /** Stop new timer and poll admission without waiting for active work. */
  private stopAdmission(): void {
    this.stopped = true;
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    logger.info("CleanupWorker stopped");
  }

  /** Run a single poll cycle. Exported for testing. */
  async poll(): Promise<void> {
    if (this.running || this.stopped) return;
    const pollPromise = this.runPoll();
    this.pollPromise = pollPromise;
    try {
      await pollPromise;
    } finally {
      if (this.pollPromise === pollPromise) this.pollPromise = null;
    }
  }

  /** Execute one serial poll while exposing its completion to shutdown. */
  private async runPoll(): Promise<void> {
    // Set running before findDue so a concurrent timer-fired poll
    // that arrives during the async job execution sees running=true.
    this.running = true;
    try {
      const retentionJobsEnqueued = this.cleanupJobRepo.enqueueExpiredCompleted(new Date().toISOString());
      const nowMs = Date.now();
      const jobs = this.cleanupJobRepo.findDue(nowMs);
      if (jobs.length > 0 || retentionJobsEnqueued > 0) {
        const dueCounts = this.cleanupJobRepo.getDueCounts(nowMs);
        const selectedExplicitJobs = jobs.filter((job) => job.kind === "explicit").length;
        const selectedRetentionJobs = jobs.length - selectedExplicitJobs;
        logger.info("CleanupWorker batch selected", {
          retentionJobsEnqueued,
          selectedExplicitJobs,
          selectedRetentionJobs,
          backlogExplicitJobs: Math.max(0, dueCounts.explicit - selectedExplicitJobs),
          backlogRetentionJobs: Math.max(0, dueCounts.retention - selectedRetentionJobs),
        });
      }
      for (const job of jobs) {
        if (this.stopped) break;
        await this.executeJob(job);
      }
    } finally {
      this.running = false;
    }
  }

  private async executeJob(job: CleanupJob): Promise<void> {
    logger.info("CleanupWorker job started", {
      jobId: job.id,
      threadId: job.thread_id,
      kind: job.kind,
      worktreePath: job.worktree_path,
      attempt: job.attempts + 1,
    });

    const releaseSetupBarrier = this.workspaceEnvironmentService.beginThreadDeletion(job.thread_id);
    const mutationToken = job.kind === "retention"
      ? this.mutationReservations.reserve(job.thread_id, "cleaning")
      : null;
    if (job.kind === "retention" && !mutationToken) {
      logger.info("CleanupWorker job deferred", {
        jobId: job.id,
        threadId: job.thread_id,
        kind: job.kind,
        reason: "mutation-reservation-unavailable",
      });
      releaseSetupBarrier();
      return;
    }

    try {
      await this.workspaceEnvironmentService.cancelSetupForThread(job.thread_id);
      const retentionThread = job.kind === "retention"
        ? this.threadRepo.claimRetentionCleanup(job.thread_id, new Date().toISOString())
        : null;
      if (job.kind === "retention" && !retentionThread) {
        this.db.transaction(() => {
          this.cleanupJobRepo.delete(job.id);
          this.threadRepo.releaseRetentionCleanup(job.thread_id);
        })();
        logger.info("CleanupWorker job cancelled", {
          jobId: job.id,
          threadId: job.thread_id,
          kind: job.kind,
          reason: "no-longer-eligible",
        });
        return;
      }
      if (job.kind === "retention" && !job.worktree_path) {
        await this.completeCleanupWithoutWorktree(job);
        return;
      }
      if (!job.worktree_path) {
        throw new Error("Explicit worktree cleanup job has no worktree path");
      }
      // Validate paths from DB before using them in filesystem operations.
      // Normalise Windows backslashes so resolve() works on all platforms.
      const worktreeBase = resolve(getMcodeDir(), "worktrees");
      const resolvedWt = resolve(job.worktree_path.replace(/\\/g, "/"));
      const resolvedWs = resolve(job.workspace_path.replace(/\\/g, "/"));
      const rel = relative(worktreeBase, resolvedWt);
      const lexicalCanonicalPath =
        rel !== ""
        && !(rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel));
      const isCanonicalPath = !existsSync(resolvedWt)
        ? lexicalCanonicalPath
        : this.isCanonicalWorktreePath(worktreeBase, resolvedWt, lexicalCanonicalPath);
      if (
        job.kind === "retention"
        && (!isCanonicalPath || retentionThread?.worktree_managed !== true)
      ) {
        await this.teardownThreadRuntime(job.thread_id, job.id);
        await this.completeCleanupWithoutWorktree(job);
        await this.finalizeWorkspaceIfDone(job.workspace_path);
        return;
      }
      if (retentionThread?.checkout_state === "branchless" && !retentionThread.base_branch) {
        this.blockRetentionCleanup(job, "Mcode cannot verify the branchless worktree base.", "missing-base-branch");
        return;
      }

      if (!existsSync(resolvedWs)) {
        // The workspace directory is already gone (e.g. external deletion, re-installation).
        // Treat this as a successful cleanup: there's nothing on disk to remove.
        logger.info("Workspace directory gone, skipping filesystem cleanup", {
          threadId: job.thread_id,
          workspacePath: resolvedWs,
        });
        if (job.kind === "retention" && existsSync(resolvedWt)) {
          this.blockRetentionCleanup(
            job,
            "Mcode cannot access the Project repository.",
            "workspace-repository-inaccessible",
          );
          return;
        }
        await this.completeCleanupWithoutWorktree(job);
        await this.finalizeWorkspaceIfDone(job.workspace_path);
        return;
      }
      if (resolvedWt === resolvedWs) {
        throw new Error(`worktree_path must not equal workspace_path: ${resolvedWt}`);
      }

      if (!isCanonicalPath && !(await this.gitService.isRegisteredWorktreePath(resolvedWs, resolvedWt))) {
        throw new Error(`worktree_path is not a registered worktree for repo: ${resolvedWt}`);
      }

      await this.teardownThreadRuntime(job.thread_id, job.id);

      if (!existsSync(resolvedWt)) {
        // The worktree directory is already gone but the workspace root exists.
        // Treat this as a successful cleanup: no git operation needed.
        logger.info("Worktree directory already removed, skipping filesystem cleanup", {
          threadId: job.thread_id,
          worktreePath: resolvedWt,
        });
        await this.completeCleanupWithoutWorktree(job);
        await this.finalizeWorkspaceIfDone(job.workspace_path);
        return;
      }

      // 5. Remove the canonical worktree and delete its exact thread branch when
      //    no active sibling references that branch. Rollback paths are handled
      //    separately in ThreadService.
      const wtName = resolvedWt.replace(/\\/g, "/").split("/").pop() ?? resolvedWt;
      let preserveWorktreeReason: string | null = null;
      const removed = await this.gitService.withReviewWorktreeMutationLock(
        resolvedWs,
        async () => {
          const siblings = this.threadRepo.listActiveSiblingWorktreePaths(job.thread_id);
          const safety = await this.gitService.assessWorktreeRemovalSafety(
            resolvedWt,
            siblings.paths,
            siblings.truncated,
          );
          if (!safety.safe) {
            preserveWorktreeReason = safety.reason;
            return true;
          }
          if (job.kind === "retention" && retentionThread?.checkout_state === "named") {
            const namedSafety = await this.gitService.assessNamedWorktreeRemoval(resolvedWt);
            if (
              !namedSafety.safe
              && !(this.unsafeWorktreePolicy() === "delete" && namedSafety.reason === "dirty")
            ) {
              preserveWorktreeReason = namedSafety.reason;
              return true;
            }
          }
          if (
            job.kind === "retention"
            && retentionThread?.checkout_state === "branchless"
            && retentionThread.base_branch
          ) {
            const automaticSafety = await this.gitService.assessBranchlessWorktreeRemoval(
              resolvedWt,
              retentionThread.base_branch,
            );
            if (
              !automaticSafety.safe
              && !(
                this.unsafeWorktreePolicy() === "delete"
                && (automaticSafety.reason === "dirty" || automaticSafety.reason === "unique_commits")
              )
            ) {
              preserveWorktreeReason = automaticSafety.reason;
              return true;
            }
          }
          const shouldDelete = job.kind === "explicit" && job.branch
            ? this.shouldDeleteBranch(job)
            : false;
          // Retention cleanup never deletes a local branch. Explicit user
          // deletion retains its existing branch-deletion behavior.
          const removeOptions = job.kind === "retention"
            ? { deleteBranch: false, worktreePath: resolvedWt, managedCanonicalOnly: true }
            : (job.branch && shouldDelete)
            ? { branchName: job.branch, worktreePath: resolvedWt }
            : { deleteBranch: false, worktreePath: resolvedWt };
          return this.gitService.removeWorktree(resolvedWs, wtName, removeOptions);
        },
      );

      if (preserveWorktreeReason) {
        logger.info("Worktree preserved because removal ownership is not exclusive", {
          threadId: job.thread_id,
          worktreePath: resolvedWt,
          reason: preserveWorktreeReason,
        });
        if (job.kind === "retention" && preserveWorktreeReason !== "shared") {
          this.blockRetentionCleanup(
            job,
            this.userSafeBlockReason(preserveWorktreeReason),
            "worktree-safety",
          );
          return;
        }
        await this.completeCleanupWithoutWorktree(job);
        await this.finalizeWorkspaceIfDone(job.workspace_path);
        return;
      }

      if (!removed) {
        throw new Error(`Worktree directory still exists after removal: ${resolvedWt}`);
      }

      // 5b. Clean up attachment files for this thread (idempotent - ignores missing dirs)
      this.attachmentService.removeForThread(job.thread_id);
      // 5c. Wipe handoff artifacts for this thread (idempotent via rm --force).
      await this.handoffStorage.deleteThreadFiles(job.thread_id);

      // 6. Hard-delete thread row and cleanup job atomically.
      //    Wrapping in a transaction ensures no orphaned job if either statement fails.
      this.db.transaction(() => {
        this.threadRepo.hardDelete(job.thread_id);
        this.cleanupJobRepo.delete(job.id);
      })();
      if (job.kind === "retention") {
        broadcast("thread.deleted", { threadId: job.thread_id });
      }

      logger.info("CleanupWorker job completed", {
        jobId: job.id,
        threadId: job.thread_id,
        kind: job.kind,
      });

      // 7. If this was the last cleanup job for a soft-deleted workspace, hard-delete it.
      this.finalizeWorkspaceIfDone(job.workspace_path);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const failed = this.cleanupJobRepo.recordFailure(job.id, error);
      logger.warn("CleanupWorker job failed, scheduled for retry", {
        jobId: job.id,
        threadId: job.thread_id,
        kind: job.kind,
        attempt: failed?.attempts ?? job.attempts + 1,
        nextRetryAt: failed?.next_retry_at ?? null,
        error,
      });
      if (job.kind === "retention" && failed) {
        const reason = failed.attempts >= MAX_CLEANUP_ATTEMPTS
          ? `Cleanup failed after ${MAX_CLEANUP_ATTEMPTS} attempts.`
          : "Cleanup failed. Mcode will retry.";
        const thread = failed.attempts >= MAX_CLEANUP_ATTEMPTS
          ? this.db.transaction(() => {
              this.cleanupJobRepo.delete(job.id);
              return this.threadRepo.blockRetentionCleanup(job.thread_id, reason);
            })()
          : this.threadRepo.retryRetentionCleanup(job.thread_id, reason);
        if (thread) broadcast("thread.lifecycleChanged", { thread });
      }
    } finally {
      releaseSetupBarrier();
      if (mutationToken) this.mutationReservations.release(job.thread_id, mutationToken);
    }
  }

  private async teardownThreadRuntime(threadId: string, jobId: string): Promise<void> {
    // Signal the SDK subprocess to exit and wait for it to actually stop.
    // waitForSessionExit is idempotent: no-op if no active session.
    const sessionId = `mcode-${threadId}`;
    await this.claudeProvider.waitForSessionExit(sessionId, SESSION_EXIT_TIMEOUT_MS);

    // Kill PTY terminal sessions for this thread (idempotent).
    try {
      await this.terminalService.killByThread(threadId);
    } catch (err) {
      logger.warn("CleanupWorker terminal sessions killed with error", {
        jobId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // The SDK does not expose subprocess PIDs, so target all claude.exe
    // descendants to release any worktree directory handles on Windows.
    await killDescendantsByName(process.pid, "claude.exe");

    if (process.platform === "win32") {
      await new Promise<void>((resolve) => setTimeout(resolve, HANDLE_RELEASE_DELAY_MS));
    }
  }

  private async completeCleanupWithoutWorktree(job: CleanupJob): Promise<void> {
    this.attachmentService.removeForThread(job.thread_id);
    await this.handoffStorage.deleteThreadFiles(job.thread_id);
    this.db.transaction(() => {
      this.threadRepo.hardDelete(job.thread_id);
      this.cleanupJobRepo.delete(job.id);
    })();
    if (job.kind === "retention") {
      broadcast("thread.deleted", { threadId: job.thread_id });
    }
    logger.info("CleanupWorker job completed", {
      jobId: job.id,
      threadId: job.thread_id,
      kind: job.kind,
    });
  }

  private blockRetentionCleanup(job: CleanupJob, reason: string, code: RetentionBlockCode): void {
    const thread = this.db.transaction(() => {
      this.cleanupJobRepo.delete(job.id);
      return this.threadRepo.blockRetentionCleanup(job.thread_id, reason);
    })();
    if (thread) {
      broadcast("thread.lifecycleChanged", { thread });
      logger.info("CleanupWorker job blocked", {
        jobId: job.id,
        threadId: job.thread_id,
        kind: job.kind,
        reason: code,
      });
    }
  }

  private userSafeBlockReason(reason: string): string {
    switch (reason) {
      case "dirty":
        return "The worktree has uncommitted changes.";
      case "unique_commits":
        return "The branchless worktree has commits that are not in its base branch.";
      case "truncated":
      case "identity_uncertain":
      case "verification_failed":
        return "Mcode cannot prove that the worktree is safe to remove.";
      default:
        return "Mcode cannot prove that the worktree is safe to remove.";
    }
  }

  /** Read the unsafe-worktree policy at execution time, defaulting safely. */
  private unsafeWorktreePolicy(): "block" | "delete" {
    return this.settingsService?.get().thread.completion.unsafeWorktreePolicy === "delete"
      ? "delete"
      : "block";
  }

  /** Resolve filesystem identities before allowing deletion under Mcode storage. */
  private isCanonicalWorktreePath(
    worktreeBase: string,
    worktreePath: string,
    lexicalCanonicalPath: boolean,
  ): boolean {
    if (!lexicalCanonicalPath) return false;
    try {
      const canonicalBase = realpathSync(worktreeBase);
      const canonicalWorktree = realpathSync(worktreePath);
      const relativePath = relative(canonicalBase, canonicalWorktree);
      return relativePath !== ""
        && relativePath !== ".."
        && !relativePath.startsWith(".." + sep)
        && !isAbsolute(relativePath);
    } catch {
      return false;
    }
  }

  /** Check whether the branch is safe to delete (no other active thread references it). */
  private shouldDeleteBranch(job: CleanupJob): boolean {
    if (!job.branch) return false;
    // If the source thread has already been hard-deleted, we can't resolve its
    // workspace to check for siblings. Conservatively keep the branch.
    const thread = this.threadRepo.findById(job.thread_id);
    if (!thread) return false;
    return this.threadRepo.countActiveByBranch(job.thread_id, job.branch) === 0;
  }

  /**
   * Reconcile incomplete workspace deletions after app restart.
   * Finds soft-deleted workspaces and ensures all their worktree threads
   * have cleanup jobs enqueued. If a workspace has no remaining threads or jobs,
   * hard-deletes it immediately.
   */
  async reconcileOnStartup(): Promise<void> {
    const deletingWorkspaces = this.workspaceRepo.findDeleting();

    for (const ws of deletingWorkspaces) {
      const threads = this.threadRepo.listAllByWorkspace(ws.id);

      if (threads.length === 0) {
        // No threads remain - just hard-delete the workspace
        this.workspaceRepo.hardDelete(ws.id);
        logger.info("Reconciled orphaned workspace (no threads)", { workspaceId: ws.id });
        continue;
      }

      // Find worktree threads missing cleanup jobs
      const worktreeThreads = threads.filter((t) => t.worktree_path && t.worktree_managed);
      const missingJobs = worktreeThreads.filter(
        (t) => !this.cleanupJobRepo.findByThreadId(t.id),
      );

      if (missingJobs.length > 0) {
        this.cleanupJobRepo.insertBatch(
          missingJobs.map((t) => ({
            thread_id: t.id,
            workspace_path: ws.path,
            worktree_path: t.worktree_path!,
            branch: t.branch,
          })),
        );
        logger.info("Reconciled missing cleanup jobs for workspace", {
          workspaceId: ws.id,
          jobsEnqueued: missingJobs.length,
        });
      }

      // If the only remaining threads are non-worktree (already soft-deleted),
      // clean up attachments, hard-delete them, and hard-delete the workspace now
      const pendingJobs = this.cleanupJobRepo.countByWorkspacePath(ws.path);
      if (pendingJobs === 0) {
        for (const t of threads) {
          this.attachmentService.removeForThread(t.id);
          await this.handoffStorage.deleteThreadFiles(t.id);
          this.threadRepo.hardDelete(t.id);
        }
        this.workspaceRepo.hardDelete(ws.id);
        logger.info("Reconciled workspace with no pending cleanup", { workspaceId: ws.id });
      }
    }
  }

  /** Check if workspace cleanup is complete and hard-delete if so. */
  private async finalizeWorkspaceIfDone(workspacePath: string): Promise<void> {
    const remaining = this.cleanupJobRepo.countByWorkspacePath(workspacePath);
    if (remaining > 0) return;

    const workspace = this.workspaceRepo.findDeletingByPath(workspacePath);
    if (workspace) {
      // Clean up any remaining threads (e.g. crash-orphaned soft-deleted direct threads)
      // before FK cascade removes them without attachment file cleanup.
      const remainingThreads = this.threadRepo.listAllByWorkspace(workspace.id);
      for (const thread of remainingThreads) {
        this.attachmentService.removeForThread(thread.id);
        await this.handoffStorage.deleteThreadFiles(thread.id);
      }

      this.workspaceRepo.hardDelete(workspace.id);
      broadcast("workspace.deleted", { workspaceId: workspace.id });
      logger.info("Workspace hard-deleted after final cleanup job", {
        workspaceId: workspace.id,
        workspacePath,
      });
    }
  }

  /**
   * Find soft-deleted workspaces where ALL remaining cleanup jobs have exhausted retries.
   * These workspaces are permanently stuck and need user intervention (force-delete).
   */
  findStuckWorkspaces(): Array<{ workspaceId: string; workspacePath: string; reason: string }> {
    const deleting = this.workspaceRepo.findDeleting();
    const stuck: Array<{ workspaceId: string; workspacePath: string; reason: string }> = [];

    for (const ws of deleting) {
      const totalJobs = this.cleanupJobRepo.countByWorkspacePath(ws.path);
      if (totalJobs === 0) continue;

      const retriable = this.cleanupJobRepo.countRetriableByWorkspacePath(ws.path);
      if (retriable === 0) {
        const lastError = this.cleanupJobRepo.getLastErrorByWorkspacePath(ws.path);
        stuck.push({
          workspaceId: ws.id,
          workspacePath: ws.path,
          reason: lastError ?? "Unknown error after 5 attempts",
        });
      }
    }

    return stuck;
  }

  /** Process a single due cleanup job. Returns true if a job was processed. Exported for testing. */
  async processOneJob(): Promise<boolean> {
    const jobs = this.cleanupJobRepo.findDue(Date.now());
    if (jobs.length === 0) return false;
    await this.executeJob(jobs[0]);
    return true;
  }
}
