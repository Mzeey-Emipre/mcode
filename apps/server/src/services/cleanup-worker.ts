/**
 * Background worker that drains the cleanup_jobs queue.
 * Processes one job at a time to avoid git lock contention.
 * Retries with exponential backoff on failure.
 * Attempt counter resets on each app start so stale jobs are retried.
 */

import { injectable, inject } from "tsyringe";
import { isAbsolute, relative, resolve } from "path";
import { existsSync } from "fs";
import type Database from "better-sqlite3";
import { getMcodeDir, logger } from "@mcode/shared";
import { CleanupJobRepo } from "../repositories/cleanup-job-repo.js";
import type { CleanupJob } from "../repositories/cleanup-job-repo.js";
import { ThreadRepo } from "../repositories/thread-repo.js";
import { ClaudeProvider } from "../providers/claude/claude-provider.js";
import { TerminalService } from "./terminal-service.js";
import { GitService } from "./git-service.js";
import { killDescendantsByName } from "./process-kill.js";

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

/**
 * Drains the cleanup_jobs table with retry logic.
 * Must be started via start() after DI is fully resolved.
 * Call dispose() during graceful shutdown.
 */
@injectable()
export class CleanupWorker {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private stopped = false;

  constructor(
    @inject("Database") private readonly db: Database.Database,
    @inject(CleanupJobRepo) private readonly cleanupJobRepo: CleanupJobRepo,
    @inject(ThreadRepo) private readonly threadRepo: ThreadRepo,
    @inject(ClaudeProvider) private readonly claudeProvider: ClaudeProvider,
    @inject(TerminalService) private readonly terminalService: TerminalService,
    @inject(GitService) private readonly gitService: GitService,
  ) {}

  /**
   * Start the worker. Resets attempt counters (new app session) and begins
   * polling for due jobs.
   */
  start(): void {
    if (this.pollTimer !== null) return;
    this.cleanupJobRepo.resetAttempts();
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
   * Stop the worker. Matches the dispose() convention used by other
   * timer-owning services in the codebase. The currently-executing job
   * (if any) finishes before the poll loop halts.
   */
  dispose(): void {
    this.stopped = true;
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    logger.info("CleanupWorker stopped");
  }

  /** Run a single poll cycle. Exported for testing. */
  async poll(): Promise<void> {
    // Set running before findDue so a concurrent timer-fired poll
    // that arrives during the async job execution sees running=true.
    if (this.running || this.stopped) return;
    this.running = true;

    try {
      const jobs = this.cleanupJobRepo.findDue(Date.now());
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
      worktreePath: job.worktree_path,
      attempt: job.attempts + 1,
    });

    try {
      // Validate paths from DB before using them in filesystem operations.
      // Normalise Windows backslashes so resolve() works on all platforms.
      const worktreeBase = resolve(getMcodeDir(), "worktrees");
      const resolvedWt = resolve(job.worktree_path.replace(/\\/g, "/"));
      const resolvedWs = resolve(job.workspace_path.replace(/\\/g, "/"));

      if (!existsSync(resolvedWs)) {
        throw new Error(`workspace_path does not exist: ${resolvedWs}`);
      }
      if (resolvedWt === resolvedWs) {
        throw new Error(`worktree_path must not equal workspace_path: ${resolvedWt}`);
      }

      const rel = relative(worktreeBase, resolvedWt);
      const isManagedPath = !(rel.startsWith("..") || isAbsolute(rel));
      if (!isManagedPath && !this.gitService.isRegisteredWorktreePath(resolvedWs, resolvedWt)) {
        throw new Error(`worktree_path is not a registered worktree for repo: ${resolvedWt}`);
      }

      // 1. Signal the SDK subprocess to exit and wait for it to actually stop.
      //    waitForSessionExit is idempotent: no-op if no active session.
      const sessionId = `mcode-${job.thread_id}`;
      await this.claudeProvider.waitForSessionExit(sessionId, SESSION_EXIT_TIMEOUT_MS);

      // 2. Kill PTY terminal sessions for this thread (idempotent).
      try {
        await this.terminalService.killByThread(job.thread_id);
      } catch (err) {
        logger.warn("CleanupWorker terminal sessions killed with error", {
          jobId: job.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // 3. Force-kill any lingering SDK subprocess (claude.exe) that is a
      //    descendant of this server process. waitForSessionExit only confirms
      //    the stream ended, not that the OS process exited.  Its cwd handle
      //    locks the worktree directory and ancestors on Windows.
      //
      //    Scope: targets all claude.exe descendants of the server, not just
      //    this session's subprocess. The SDK does not expose subprocess PIDs,
      //    so per-session targeting is not possible. This is acceptable because
      //    cleanup jobs only exist for deleted threads whose sessions have
      //    already been asked to exit in step 1.
      await killDescendantsByName(process.pid, "claude.exe");

      // 4. Brief delay on Windows so the OS releases directory handles.
      if (process.platform === "win32") {
        await new Promise<void>((resolve) => setTimeout(resolve, HANDLE_RELEASE_DELAY_MS));
      }

      // 5. Remove the worktree directory and delete the exact thread branch when
      //    the thread record has one. The delete-thread dialog is the user intent
      //    boundary; rollback paths are handled separately in ThreadService.
      const wtName = resolvedWt.replace(/\\/g, "/").split("/").pop() ?? resolvedWt;
      const removeOptions = job.branch
        ? { branchName: job.branch, worktreePath: resolvedWt }
        : { deleteBranch: false, worktreePath: resolvedWt };

      const removed = await this.gitService.removeWorktree(
        resolvedWs,
        wtName,
        removeOptions,
      );

      if (!removed) {
        throw new Error(`Worktree directory still exists after removal: ${resolvedWt}`);
      }

      // 6. Hard-delete thread row and cleanup job atomically.
      //    Wrapping in a transaction ensures no orphaned job if either statement fails.
      this.db.transaction(() => {
        this.threadRepo.hardDelete(job.thread_id);
        this.cleanupJobRepo.delete(job.id);
      })();

      logger.info("CleanupWorker job completed", {
        jobId: job.id,
        threadId: job.thread_id,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.warn("CleanupWorker job failed, scheduled for retry", {
        jobId: job.id,
        threadId: job.thread_id,
        attempt: job.attempts + 1,
        error,
      });
      this.cleanupJobRepo.recordFailure(job.id, error);
    }
  }
}
