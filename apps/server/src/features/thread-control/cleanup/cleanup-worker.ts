/**
 * Background worker that drains the cleanup_jobs queue.
 * Processes one job at a time to avoid git lock contention.
 * Retries with exponential backoff on failure.
 * Retry counters persist across app restarts so exhausted work stays blocked.
 */

import { injectable, inject } from "tsyringe";
import * as NodePath from "node:path";
import * as NodeFS from "node:fs";
import type Database from "better-sqlite3";
import { getMcodeDir, logger } from "@mcode/shared";
import type { HostRuntime } from "@mcode/shared/node/host-runtime";
import { CleanupJobRepo, MAX_CLEANUP_ATTEMPTS } from "./persistence/cleanup-job-repo.js";
import type { CleanupJob } from "./persistence/cleanup-job-repo.js";
import { ThreadRepo } from "../persistence/thread-repo.js";
import { ClaudeProvider } from "../../providers/adapters/claude/claude-provider.js";
import { TerminalBackend, TERMINAL_BACKEND_TOKEN } from "../../terminal/backends/terminal-backend.js";
import {
  GitWorktreeService,
  RepositoryGitMutationLock,
  WorktreeSafetyService,
} from "../../projects/index.js";
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

type JobExecutionContext = {
  releaseSetupBarrier: () => void;
  mutationToken: string | null;
};

type CleanupPaths = {
  workspacePath: string;
  worktreePath: string;
  worktreeName: string;
  canonicalPath: boolean;
};

type LockedRemovalResult = {
  removed: boolean;
  preserveWorktreeReason: string | null;
};

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
    @inject(GitWorktreeService) private readonly gitWorktrees: GitWorktreeService,
    @inject(WorktreeSafetyService) private readonly worktreeSafety: WorktreeSafetyService,
    @inject(RepositoryGitMutationLock) private readonly repositoryMutationLock: RepositoryGitMutationLock,
    @inject(WorkspaceRepo) private readonly workspaceRepo: WorkspaceRepo,
    @inject(AttachmentService) private readonly attachmentService: AttachmentService,
    @inject(HandoffStorage) private readonly handoffStorage: HandoffStorage,
    @inject(WorkspaceEnvironmentService)
    private readonly workspaceEnvironmentService: WorkspaceEnvironmentService,
    @inject("HostRuntime") private readonly hostRuntime: HostRuntime,
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
    this.logJobStarted(job);
    const context = this.beginJobExecution(job);
    if (!context) return;
    try {
      await this.executeReservedJob(job);
    } catch (error) {
      this.recordJobFailure(job, error);
    } finally {
      context.releaseSetupBarrier();
      if (context.mutationToken) this.mutationReservations.release(job.thread_id, context.mutationToken);
    }
  }

  private logJobStarted(job: CleanupJob): void {
    logger.info("CleanupWorker job started", {
      jobId: job.id,
      threadId: job.thread_id,
      kind: job.kind,
      worktreePath: job.worktree_path,
      attempt: job.attempts + 1,
    });
  }

  private beginJobExecution(job: CleanupJob): JobExecutionContext | null {
    const releaseSetupBarrier = this.workspaceEnvironmentService.beginThreadDeletion(job.thread_id);
    if (job.kind !== "retention") return { releaseSetupBarrier, mutationToken: null };
    const mutationToken = this.mutationReservations.reserve(job.thread_id, "cleaning");
    if (mutationToken) return { releaseSetupBarrier, mutationToken };
    logger.info("CleanupWorker job deferred", {
      jobId: job.id,
      threadId: job.thread_id,
      kind: job.kind,
      reason: "mutation-reservation-unavailable",
    });
    releaseSetupBarrier();
    return null;
  }

  private async executeReservedJob(job: CleanupJob): Promise<void> {
    await this.workspaceEnvironmentService.cancelSetupForThread(job.thread_id);
    const retentionThread = this.claimRetentionCleanup(job);
    if (job.kind === "retention" && !retentionThread) return;
    const paths = await this.prepareWorktreeCleanup(job, retentionThread);
    if (!paths) return;
    await this.executeFilesystemCleanup(job, retentionThread, paths);
  }

  private claimRetentionCleanup(job: CleanupJob): ReturnType<ThreadRepo["claimRetentionCleanup"]> | undefined {
    if (job.kind !== "retention") return undefined;
    const thread = this.threadRepo.claimRetentionCleanup(job.thread_id, new Date().toISOString());
    if (thread) return thread;
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
    return null;
  }

  private async prepareWorktreeCleanup(
    job: CleanupJob,
    retentionThread: ReturnType<ThreadRepo["claimRetentionCleanup"]> | undefined,
  ): Promise<CleanupPaths | null> {
    if (job.kind === "retention" && !job.worktree_path) {
      await this.completeCleanupWithoutWorktree(job);
      return null;
    }
    if (!job.worktree_path) throw new Error("Explicit worktree cleanup job has no worktree path");
    const paths = this.resolveCleanupPaths(job);
    if (this.requiresRetentionPathFallback(job, retentionThread, paths)) {
      await this.teardownThreadRuntime(job.thread_id, job.id);
      await this.completeCleanupWithoutWorktree(job);
      await this.finalizeWorkspaceIfDone(job.workspace_path);
      return null;
    }
    if (retentionThread?.checkout_state === "branchless" && !retentionThread.base_branch) {
      this.blockRetentionCleanup(job, "Mcode cannot verify the branchless worktree base.", "missing-base-branch");
      return null;
    }
    if (await this.handleMissingWorkspace(job, paths)) return null;
    this.assertDistinctCleanupPaths(paths);
    await this.assertRegisteredWorktreePath(paths);
    return paths;
  }

  private resolveCleanupPaths(job: CleanupJob): CleanupPaths {
    const worktreeBase = resolve(getMcodeDir(), "worktrees");
    const worktreePath = resolve(job.worktree_path!.replace(/\\/g, "/"));
    const workspacePath = resolve(job.workspace_path.replace(/\\/g, "/"));
    const relativePath = relative(worktreeBase, worktreePath);
    const lexicalCanonicalPath = relativePath !== ""
      && !(relativePath === ".." || relativePath.startsWith(".." + sep) || isAbsolute(relativePath));
    return {
      workspacePath,
      worktreePath,
      worktreeName: worktreePath.replace(/\\/g, "/").split("/").pop() ?? worktreePath,
      canonicalPath: !existsSync(worktreePath)
        ? lexicalCanonicalPath
        : this.isCanonicalWorktreePath(worktreeBase, worktreePath, lexicalCanonicalPath),
    };
  }

  private requiresRetentionPathFallback(
    job: CleanupJob,
    retentionThread: ReturnType<ThreadRepo["claimRetentionCleanup"]> | undefined,
    paths: CleanupPaths,
  ): boolean {
    return job.kind === "retention" && (!paths.canonicalPath || retentionThread?.worktree_managed !== true);
  }

  private async handleMissingWorkspace(job: CleanupJob, paths: CleanupPaths): Promise<boolean> {
    if (existsSync(paths.workspacePath)) return false;
    logger.info("Workspace directory gone, skipping filesystem cleanup", {
      threadId: job.thread_id,
      workspacePath: paths.workspacePath,
    });
    if (job.kind === "retention" && existsSync(paths.worktreePath)) {
      this.blockRetentionCleanup(job, "Mcode cannot access the Project repository.", "workspace-repository-inaccessible");
      return true;
    }
    await this.completeCleanupWithoutWorktree(job);
    await this.finalizeWorkspaceIfDone(job.workspace_path);
    return true;
  }

  private assertDistinctCleanupPaths(paths: CleanupPaths): void {
    if (paths.worktreePath === paths.workspacePath) {
      throw new Error(`worktree_path must not equal workspace_path: ${paths.worktreePath}`);
    }
  }

  private async assertRegisteredWorktreePath(paths: CleanupPaths): Promise<void> {
    if (!paths.canonicalPath && !(await this.gitWorktrees.isRegisteredWorktreePath(paths.workspacePath, paths.worktreePath))) {
      throw new Error(`worktree_path is not a registered worktree for repo: ${paths.worktreePath}`);
    }
  }

  private async executeFilesystemCleanup(
    job: CleanupJob,
    retentionThread: ReturnType<ThreadRepo["claimRetentionCleanup"]> | undefined,
    paths: CleanupPaths,
  ): Promise<void> {
    await this.teardownThreadRuntime(job.thread_id, job.id);
    if (await this.completeIfWorktreeMissing(job, paths)) return;
    const removal = await this.removeWorktree(job, retentionThread, paths);
    if (await this.completePreservedWorktree(job, paths, removal.preserveWorktreeReason)) return;
    if (!removal.removed) throw new Error(`Worktree directory still exists after removal: ${paths.worktreePath}`);
    await this.completeRemovedWorktree(job);
    await this.finalizeWorkspaceIfDone(job.workspace_path);
  }

  private async completeIfWorktreeMissing(job: CleanupJob, paths: CleanupPaths): Promise<boolean> {
    if (existsSync(paths.worktreePath)) return false;
    logger.info("Worktree directory already removed, skipping filesystem cleanup", {
      threadId: job.thread_id,
      worktreePath: paths.worktreePath,
    });
    await this.completeCleanupWithoutWorktree(job);
    await this.finalizeWorkspaceIfDone(job.workspace_path);
    return true;
  }

  private async removeWorktree(
    job: CleanupJob,
    retentionThread: ReturnType<ThreadRepo["claimRetentionCleanup"]> | undefined,
    paths: CleanupPaths,
  ): Promise<LockedRemovalResult> {
    return this.repositoryMutationLock.run(
      paths.workspacePath,
      () => this.removeLockedWorktree(job, retentionThread, paths),
    );
  }

  private async removeLockedWorktree(
    job: CleanupJob,
    retentionThread: ReturnType<ThreadRepo["claimRetentionCleanup"]> | undefined,
    paths: CleanupPaths,
  ): Promise<LockedRemovalResult> {
    const siblings = this.threadRepo.listActiveSiblingWorktreePaths(job.thread_id);
    const safety = await this.worktreeSafety.assessWorktreeRemovalSafety(
      paths.worktreePath,
      siblings.paths,
      siblings.truncated,
    );
    if (!safety.safe) return { removed: true, preserveWorktreeReason: safety.reason };
    const gitStillOwnsWorktree = await this.gitWorktrees.isRegisteredWorktreePath(
      paths.workspacePath,
      paths.worktreePath,
    );
    const retentionSafety = await this.assessRetentionWorktreeSafety(
      job,
      retentionThread,
      paths.worktreePath,
      gitStillOwnsWorktree,
    );
    if (!retentionSafety.safe) return { removed: true, preserveWorktreeReason: retentionSafety.reason };
    return {
      removed: await this.gitWorktrees.removeWorktree(
        paths.workspacePath,
        paths.worktreeName,
        this.worktreeRemovalOptions(job, paths.worktreePath),
      ),
      preserveWorktreeReason: null,
    };
  }

  private async assessRetentionWorktreeSafety(
    job: CleanupJob,
    retentionThread: ReturnType<ThreadRepo["claimRetentionCleanup"]> | undefined,
    worktreePath: string,
    gitStillOwnsWorktree: boolean,
  ): Promise<{ safe: boolean; reason: string }> {
    if (!gitStillOwnsWorktree || job.kind !== "retention") return { safe: true, reason: "" };
    if (retentionThread?.checkout_state === "named") return this.assessNamedRetentionWorktree(worktreePath);
    if (retentionThread?.checkout_state === "branchless" && retentionThread.base_branch) {
      return this.assessBranchlessRetentionWorktree(worktreePath, retentionThread.base_branch);
    }
    return { safe: true, reason: "" };
  }

  private async assessNamedRetentionWorktree(worktreePath: string): Promise<{ safe: boolean; reason: string }> {
    const safety = await this.worktreeSafety.assessNamedWorktreeRemoval(worktreePath);
    return safety.safe || this.unsafeWorktreePolicy() === "delete" && safety.reason === "dirty"
      ? { safe: true, reason: "" }
      : safety;
  }

  private async assessBranchlessRetentionWorktree(
    worktreePath: string,
    baseBranch: string,
  ): Promise<{ safe: boolean; reason: string }> {
    const safety = await this.worktreeSafety.assessBranchlessWorktreeRemoval(worktreePath, baseBranch);
    const unsafeRemovalAllowed = this.unsafeWorktreePolicy() === "delete"
      && (safety.reason === "dirty" || safety.reason === "unique_commits");
    return safety.safe || unsafeRemovalAllowed ? { safe: true, reason: "" } : safety;
  }

  private worktreeRemovalOptions(job: CleanupJob, worktreePath: string): {
    deleteBranch?: boolean;
    branchName?: string;
    worktreePath: string;
    managedCanonicalOnly?: boolean;
  } {
    if (job.kind === "retention") return { deleteBranch: false, worktreePath, managedCanonicalOnly: true };
    if (job.branch && this.shouldDeleteBranch(job)) return { branchName: job.branch, worktreePath };
    return { deleteBranch: false, worktreePath };
  }

  private async completePreservedWorktree(
    job: CleanupJob,
    paths: CleanupPaths,
    preserveWorktreeReason: string | null,
  ): Promise<boolean> {
    if (!preserveWorktreeReason) return false;
    logger.info("Worktree preserved because removal ownership is not exclusive", {
      threadId: job.thread_id,
      worktreePath: paths.worktreePath,
      reason: preserveWorktreeReason,
    });
    if (job.kind === "retention" && preserveWorktreeReason !== "shared") {
      this.blockRetentionCleanup(job, this.userSafeBlockReason(preserveWorktreeReason), "worktree-safety");
      return true;
    }
    await this.completeCleanupWithoutWorktree(job);
    await this.finalizeWorkspaceIfDone(job.workspace_path);
    return true;
  }

  private async completeRemovedWorktree(job: CleanupJob): Promise<void> {
    this.attachmentService.removeForThread(job.thread_id);
    await this.handoffStorage.deleteThreadFiles(job.thread_id);
    this.db.transaction(() => {
      this.threadRepo.hardDelete(job.thread_id);
      this.cleanupJobRepo.delete(job.id);
    })();
    if (job.kind === "retention") broadcast("thread.deleted", { threadId: job.thread_id });
    logger.info("CleanupWorker job completed", { jobId: job.id, threadId: job.thread_id, kind: job.kind });
  }

  private recordJobFailure(job: CleanupJob, failure: unknown): void {
    const error = failure instanceof Error ? failure.message : String(failure);
    const failed = this.cleanupJobRepo.recordFailure(job.id, error);
    logger.warn("CleanupWorker job failed, scheduled for retry", {
      jobId: job.id,
      threadId: job.thread_id,
      kind: job.kind,
      attempt: failed?.attempts ?? job.attempts + 1,
      nextRetryAt: failed?.next_retry_at ?? null,
      error,
    });
    if (job.kind === "retention" && failed) this.updateFailedRetentionJob(job, failed.attempts);
  }

  private updateFailedRetentionJob(job: CleanupJob, attempts: number): void {
    const exhausted = attempts >= MAX_CLEANUP_ATTEMPTS;
    const reason = exhausted ? `Cleanup failed after ${MAX_CLEANUP_ATTEMPTS} attempts.` : "Cleanup failed. Mcode will retry.";
    const thread = exhausted
      ? this.db.transaction(() => {
          this.cleanupJobRepo.delete(job.id);
          return this.threadRepo.blockRetentionCleanup(job.thread_id, reason);
        })()
      : this.threadRepo.retryRetentionCleanup(job.thread_id, reason);
    if (thread) broadcast("thread.lifecycleChanged", { thread });
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
    await killDescendantsByName(process.pid, "claude.exe", this.hostRuntime.platform);

    if (this.hostRuntime.platform === "win32") {
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
