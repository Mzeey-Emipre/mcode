/**
 * Background worker that drains the cleanup_jobs queue.
 * Processes one job at a time to avoid git lock contention.
 * Retries with exponential backoff on failure.
 * Retry counters persist across app restarts so exhausted work stays blocked.
 */

import { injectable, inject } from "tsyringe";
import type Database from "better-sqlite3";
import { logger } from "@mcode/shared";
import type { HostRuntime } from "@mcode/shared/node/host-runtime";
import type { Thread } from "@mcode/contracts";
import { CleanupJobRepo, MAX_CLEANUP_ATTEMPTS } from "./persistence/cleanup-job-repo.js";
import type { CleanupJob } from "./persistence/cleanup-job-repo.js";
import { ThreadRepo } from "../persistence/thread-repo.js";
import { ClaudeProvider } from "../../providers/adapters/claude/claude-provider.js";
import {
  GitWorktreeService,
  RepositoryGitMutationLock,
  SandboxWorktreeCleanupPolicy,
} from "../../projects/index.js";
import { AttachmentService } from "../../attachments/storage/attachment-service.js";
import { killDescendantsByName } from "../../../runtime/process/containment/process-kill.js";
import { WorkspaceRepo } from "../../projects/persistence/workspace-repo.js";
import { broadcast } from "../../../application/transport/push.js";
import { HandoffStorage } from "../../handoff/index.js";
import { pruneStaleToolOutputArtifacts } from "@mcode/providers";
import { ThreadControlMutationReservationService } from "../index.js";
import { ThreadDeletionTeardownService } from "../lifecycle/thread-deletion-teardown-service.js";

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

type JobExecutionContext = {
  mutationToken: string | null;
};

type LockedCleanupResult = {
  completed: boolean;
  threadIds: string[];
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
    @inject(GitWorktreeService) private readonly gitWorktrees: GitWorktreeService,
    @inject(SandboxWorktreeCleanupPolicy) private readonly cleanupPolicy: SandboxWorktreeCleanupPolicy,
    @inject(RepositoryGitMutationLock) private readonly repositoryMutationLock: RepositoryGitMutationLock,
    @inject(WorkspaceRepo) private readonly workspaceRepo: WorkspaceRepo,
    @inject(AttachmentService) private readonly attachmentService: AttachmentService,
    @inject(HandoffStorage) private readonly handoffStorage: HandoffStorage,
    @inject(ThreadDeletionTeardownService)
    private readonly threadDeletionTeardownService: ThreadDeletionTeardownService,
    @inject("HostRuntime") private readonly hostRuntime: HostRuntime,
    @inject(ThreadControlMutationReservationService, { isOptional: true })
    mutationReservations?: ThreadControlMutationReservationService,
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
    if (job.kind !== "retention") return { mutationToken: null };
    const mutationToken = this.mutationReservations.reserve(job.thread_id, "cleaning");
    if (mutationToken) return { mutationToken };
    logger.info("CleanupWorker job deferred", {
      jobId: job.id,
      threadId: job.thread_id,
      kind: job.kind,
      reason: "mutation-reservation-unavailable",
    });
    return null;
  }

  private async executeReservedJob(job: CleanupJob): Promise<void> {
    const retentionThread = this.claimRetentionCleanup(job);
    if (job.kind === "retention" && !retentionThread) return;
    const thread = this.threadRepo.findById(job.thread_id);
    if (!thread && job.kind === "explicit") {
      this.cleanupJobRepo.delete(job.id);
      return;
    }
    if (!await this.matchesJobWorktree(thread, job)) {
      await this.completeThreadOnly(job);
      return;
    }
    await this.cleanupWorktree(job, job.worktree_path);
  }

  private async matchesJobWorktree(thread: Thread | null, job: CleanupJob): Promise<boolean> {
    if (job.worktree_path === null) return thread?.worktree_path === null;
    if (!thread?.worktree_path) return false;

    const [jobPath, currentPath] = await Promise.all([
      this.cleanupPolicy.resolveSandboxPath(job.worktree_path),
      this.cleanupPolicy.resolveSandboxPath(thread.worktree_path),
    ]);
    if (jobPath && currentPath) return this.cleanupPolicy.isSameSandboxPath(jobPath, currentPath);
    return this.cleanupPolicy.isSameSandboxPath(job.worktree_path, thread.worktree_path);
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

  private async cleanupWorktree(
    job: CleanupJob,
    worktreePath: string | null,
  ): Promise<void> {
    if (!worktreePath) {
      await this.completeThreadOnly(job);
      return;
    }
    const removal = await this.repositoryMutationLock.run(
      job.workspace_path,
      () => this.removeLockedWorktree(job, worktreePath),
    );
    if (!removal.completed) {
      throw new Error(`Worktree directory still exists after removal: ${worktreePath}`);
    }
    await this.completeThreads(job, removal.threadIds);
    await this.finalizeWorkspaceIfDone(job.workspace_path);
  }

  private async completeThreadOnly(job: CleanupJob): Promise<void> {
    await this.teardownThreadRuntime(job.thread_id);
    await this.completeThreads(job, [job.thread_id]);
    await this.finalizeWorkspaceIfDone(job.workspace_path);
  }

  private async removeLockedWorktree(
    job: CleanupJob,
    worktreePath: string,
  ): Promise<LockedCleanupResult> {
    const sourceThread = this.threadRepo.findById(job.thread_id);
    if (!sourceThread) return { completed: true, threadIds: [] };
    if (!await this.matchesJobWorktree(sourceThread, job)) return this.keepWorktree(job);

    const decision = await this.cleanupPolicy.decide({
      workspacePath: job.workspace_path,
      worktreePath,
      branch: job.branch,
      checkoutState: sourceThread.checkout_state,
    });
    if (decision.action === "retain") return this.keepWorktree(job);

    const linkedThreads = await this.findLinkedThreads(
      sourceThread.workspace_id,
      worktreePath,
      decision.worktreePath,
    );
    if (this.mustKeepWorktree(linkedThreads, job.thread_id)) return this.keepWorktree(job);

    const threadIds = linkedThreads.map((thread) => thread.id);
    await Promise.all(threadIds.map((threadId) => this.teardownThreadRuntime(threadId)));
    const removalPath = decision.worktreePath ?? worktreePath;
    const worktreeName = removalPath.replace(/\\/g, "/").split("/").pop() ?? removalPath;
    return {
      completed: await this.gitWorktrees.removeWorktree(job.workspace_path, worktreeName, {
        branchName: decision.branch ?? undefined,
        deleteBranch: decision.branch ? undefined : false,
        forceDeleteBranch: true,
        managedCanonicalOnly: true,
        worktreePath: removalPath,
      }),
      threadIds,
    };
  }

  private async keepWorktree(job: CleanupJob): Promise<LockedCleanupResult> {
    await this.teardownThreadRuntime(job.thread_id);
    return { completed: true, threadIds: [job.thread_id] };
  }

  private mustKeepWorktree(threads: readonly Thread[], threadId: string): boolean {
    return threads.length === 0 || this.hasOtherActiveThread(threads, threadId);
  }

  private async findLinkedThreads(
    workspaceId: string,
    worktreePath: string,
    canonicalWorktreePath: string | null,
  ): Promise<Thread[]> {
    const linked = this.threadRepo.findWorktreeThreadsByWorkspace(workspaceId);
    const threads = await Promise.all(linked.map(async (candidate) => {
      if (!candidate.worktree_path) return null;
      if (!canonicalWorktreePath) {
        return this.cleanupPolicy.isSameSandboxPath(candidate.worktree_path, worktreePath)
          ? candidate
          : null;
      }
      const candidatePath = await this.cleanupPolicy.resolveSandboxPath(candidate.worktree_path);
      return candidatePath && this.cleanupPolicy.isSameSandboxPath(candidatePath, canonicalWorktreePath)
        ? candidate
        : null;
    }));
    return threads.filter((thread): thread is Thread => thread !== null);
  }

  private hasOtherActiveThread(threads: readonly Thread[], threadId: string): boolean {
    return threads.some((thread) => (
      thread.id !== threadId
      && thread.deleted_at === null
      && thread.user_completed_at === null
    ));
  }

  private async completeThreads(job: CleanupJob, threadIds: readonly string[]): Promise<void> {
    const ids = [...new Set(threadIds)];
    for (const threadId of ids) {
      this.attachmentService.removeForThread(threadId);
      await this.handoffStorage.deleteThreadFiles(threadId);
    }
    this.db.transaction(() => {
      for (const threadId of ids) {
        this.cleanupJobRepo.deleteByThreadId(threadId);
        this.threadRepo.hardDelete(threadId, { preserveActiveDescendants: true });
      }
      this.cleanupJobRepo.delete(job.id);
    })();
    for (const threadId of ids) broadcast("thread.deleted", { threadId });
    logger.info("CleanupWorker job completed", {
      jobId: job.id,
      threadId: job.thread_id,
      kind: job.kind,
      deletedThreadIds: ids,
    });
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

  private async teardownThreadRuntime(threadId: string): Promise<void> {
    await this.threadDeletionTeardownService.teardownThread(threadId);
    await this.claudeProvider.waitForSessionExit(`mcode-${threadId}`, SESSION_EXIT_TIMEOUT_MS);

    // Claude does not report each child process, so this releases remaining Windows file handles.
    await killDescendantsByName(process.pid, "claude.exe", this.hostRuntime.platform);
    if (this.hostRuntime.platform === "win32") {
      await new Promise<void>((resolve) => setTimeout(resolve, HANDLE_RELEASE_DELAY_MS));
    }
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
      const worktreeThreads = threads.filter((t) => t.worktree_path);
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
