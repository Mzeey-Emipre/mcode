/**
 * Cleanup job data access layer.
 * Stores worktree cleanup jobs that are processed by CleanupWorker with
 * exponential backoff retries. A job persists until the cleanup succeeds,
 * surviving app restarts.
 */

import { randomUUID } from "crypto";
import { injectable, inject } from "tsyringe";
import type Database from "better-sqlite3";
import type { Statement } from "better-sqlite3";

/** Max persisted retry attempts before a cleanup job requires user action. */
export const MAX_CLEANUP_ATTEMPTS = 5;

/** Maximum cleanup jobs one worker poll may execute. */
export const CLEANUP_BATCH_LIMIT = 20;

/** Max length for persisted error messages. */
const MAX_ERROR_LENGTH = 500;

/** Queued worktree cleanup job processed by CleanupWorker with exponential backoff. */
export interface CleanupJob {
  id: string;
  thread_id: string;
  workspace_path: string;
  worktree_path: string | null;
  branch: string | null;
  kind: "explicit" | "retention";
  attempts: number;
  next_retry_at: number;
  last_error: string | null;
  created_at: number;
}

/** Counts due cleanup jobs by their processing kind. */
export interface CleanupJobDueCounts {
  explicit: number;
  retention: number;
}

const SELECT_COLS =
  "id, thread_id, workspace_path, worktree_path, branch, kind, attempts, next_retry_at, last_error, created_at";

/** Repository for worktree cleanup job persistence. */
@injectable()
export class CleanupJobRepo {
  private readonly stmtInsert: Statement;
  private readonly stmtFindDueByKind: Statement;
  private readonly stmtFindDueCounts: Statement;
  private readonly stmtRecordFailure: Statement;
  private readonly stmtDelete: Statement;
  private readonly stmtResetAttempts: Statement;
  private readonly stmtFindById: Statement;
  private readonly stmtFindByThreadId: Statement;
  private readonly stmtCount: Statement;

  constructor(@inject("Database") private readonly db: Database.Database) {
    this.stmtInsert = db.prepare(
      `INSERT OR IGNORE INTO cleanup_jobs
        (id, thread_id, workspace_path, worktree_path, branch, kind, attempts, next_retry_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)`,
    );
    this.stmtFindDueByKind = db.prepare(
      `SELECT ${SELECT_COLS} FROM cleanup_jobs
          WHERE next_retry_at <= ? AND attempts < ?
            AND kind = ?
          ORDER BY created_at ASC
          LIMIT ?`,
    );
    this.stmtFindDueCounts = db.prepare(
      `SELECT kind, COUNT(*) AS count FROM cleanup_jobs
         WHERE next_retry_at <= ? AND attempts < ?
           AND kind IN ('explicit', 'retention')
         GROUP BY kind`,
    );
    this.stmtRecordFailure = db.prepare(
      `UPDATE cleanup_jobs
          SET attempts = attempts + 1,
              next_retry_at = ? + (CAST(POW(2, attempts + 1) AS INTEGER) * 1000),
              last_error = ?
        WHERE id = ?`,
    );
    this.stmtDelete = db.prepare("DELETE FROM cleanup_jobs WHERE id = ?");
    this.stmtResetAttempts = db.prepare(
      "UPDATE cleanup_jobs SET attempts = 0, next_retry_at = 0",
    );
    this.stmtFindById = db.prepare(
      `SELECT ${SELECT_COLS} FROM cleanup_jobs WHERE id = ?`,
    );
    this.stmtFindByThreadId = db.prepare(
      `SELECT ${SELECT_COLS} FROM cleanup_jobs WHERE thread_id = ?`,
    );
    this.stmtCount = db.prepare("SELECT COUNT(*) as n FROM cleanup_jobs");
  }

  /**
   * Insert a new cleanup job. The job will be picked up by CleanupWorker
   * as soon as next_retry_at <= now and attempts < MAX_CLEANUP_ATTEMPTS.
   * A UNIQUE constraint on thread_id prevents duplicate jobs for the same thread.
   */
  insert(job: {
    thread_id: string;
    workspace_path: string;
    worktree_path: string | null;
    branch: string | null;
    kind?: "explicit" | "retention";
  }): CleanupJob {
    const id = randomUUID();
    const now = Date.now();
    const kind = job.kind ?? "explicit";

    const result = this.stmtInsert.run(
      id,
      job.thread_id,
      job.workspace_path,
      job.worktree_path,
      job.branch ?? null,
      kind,
      now,
    );

    if (result.changes === 0) {
      // A job for this thread already exists (UNIQUE constraint). Return the
      // persisted row so callers always get a valid, DB-backed object.
      return this.stmtFindByThreadId.get(job.thread_id) as CleanupJob;
    }

    return {
      id,
      thread_id: job.thread_id,
      workspace_path: job.workspace_path,
      worktree_path: job.worktree_path,
      branch: job.branch,
      kind,
      attempts: 0,
      next_retry_at: 0,
      last_error: null,
      created_at: now,
    };
  }

  /**
   * Return jobs that are due to run: next_retry_at <= now and attempts < max.
   * Ordered by created_at ascending so oldest jobs are processed first.
   */
  findDue(nowMs: number, limit = CLEANUP_BATCH_LIMIT): CleanupJob[] {
    const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const counts = this.getDueCounts(nowMs);
    if (counts.explicit === 0 || counts.retention === 0) {
      const kind = counts.retention > 0 ? "retention" : "explicit";
      return this.stmtFindDueByKind.all(
        nowMs,
        MAX_CLEANUP_ATTEMPTS,
        kind,
        boundedLimit,
      ) as CleanupJob[];
    }

    let retentionLimit = Math.min(counts.retention, Math.max(1, Math.floor(boundedLimit / 2)));
    let explicitLimit = Math.min(counts.explicit, boundedLimit - retentionLimit);
    const spareLimit = boundedLimit - explicitLimit - retentionLimit;
    if (spareLimit > 0) {
      const additionalRetention = Math.min(spareLimit, counts.retention - retentionLimit);
      retentionLimit += additionalRetention;
      explicitLimit += Math.min(
        spareLimit - additionalRetention,
        counts.explicit - explicitLimit,
      );
    }
    const explicitJobs = this.stmtFindDueByKind.all(
      nowMs,
      MAX_CLEANUP_ATTEMPTS,
      "explicit",
      explicitLimit,
    ) as CleanupJob[];
    const retentionJobs = this.stmtFindDueByKind.all(
      nowMs,
      MAX_CLEANUP_ATTEMPTS,
      "retention",
      retentionLimit,
    ) as CleanupJob[];

    const selected: CleanupJob[] = [];
    for (
      let index = 0;
      selected.length < boundedLimit && (index < retentionJobs.length || index < explicitJobs.length);
      index += 1
    ) {
      if (index < retentionJobs.length) selected.push(retentionJobs[index]);
      if (selected.length < boundedLimit && index < explicitJobs.length) {
        selected.push(explicitJobs[index]);
      }
    }
    return selected;
  }

  /** Return due cleanup job counts grouped by processing kind. */
  getDueCounts(nowMs: number): CleanupJobDueCounts {
    const counts: CleanupJobDueCounts = { explicit: 0, retention: 0 };
    const rows = this.stmtFindDueCounts.all(nowMs, MAX_CLEANUP_ATTEMPTS) as Array<{
      kind: CleanupJob["kind"];
      count: number;
    }>;
    for (const row of rows) counts[row.kind] = row.count;
    return counts;
  }

  /** Queue a bounded set of expired completed threads in one database transaction. */
  enqueueExpiredCompleted(nowIso: string, limit = CLEANUP_BATCH_LIMIT): number {
    const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const due = this.db.prepare(
      `SELECT t.id, w.path AS workspace_path, t.worktree_path, t.branch
       FROM threads t
       JOIN workspaces w ON w.id = t.workspace_id
       WHERE t.deleted_at IS NULL
         AND w.deleted_at IS NULL
         AND t.user_completed_at IS NOT NULL
         AND t.scheduled_deletion_at IS NOT NULL
         AND t.scheduled_deletion_at <= ?
         AND t.cleanup_state IS NULL
       ORDER BY t.scheduled_deletion_at ASC, t.id ASC
       LIMIT ?`,
    ).all(nowIso, boundedLimit) as Array<{
      id: string;
      workspace_path: string;
      worktree_path: string | null;
      branch: string | null;
    }>;

    return this.db.transaction(() => {
      let queued = 0;
      for (const thread of due) {
        const claimed = this.db.prepare(
          `UPDATE threads
           SET cleanup_state = 'queued', cleanup_reason = NULL
           WHERE id = ?
             AND deleted_at IS NULL
             AND user_completed_at IS NOT NULL
             AND scheduled_deletion_at IS NOT NULL
             AND scheduled_deletion_at <= ?
             AND cleanup_state IS NULL`,
        ).run(thread.id, nowIso);
        if (claimed.changes === 0) continue;
        this.insert({
          thread_id: thread.id,
          workspace_path: thread.workspace_path,
          worktree_path: thread.worktree_path,
          branch: thread.branch,
          kind: "retention",
        });
        queued += 1;
      }
      return queued;
    })();
  }

  /**
   * Record a failed attempt. Increments attempts and schedules next retry
   * with exponential backoff (2^(attempts+1) seconds). Error message is
   * truncated to prevent unbounded growth.
   */
  recordFailure(id: string, error: string): CleanupJob | null {
    const truncated = error.slice(0, MAX_ERROR_LENGTH);
    this.stmtRecordFailure.run(Date.now(), truncated, id);
    return this.findById(id);
  }

  /** Remove a completed cleanup job. */
  delete(id: string): boolean {
    const result = this.stmtDelete.run(id);
    return result.changes > 0;
  }

  /**
   * Reset all attempt counters to 0 and clear next_retry_at.
   * Retained for explicit administrative recovery. Startup does not call this.
   */
  resetAttempts(): void {
    this.stmtResetAttempts.run();
  }

  /** Find a single job by its primary key. Returns null if not found. */
  findById(id: string): CleanupJob | null {
    const row = this.stmtFindById.get(id) as CleanupJob | undefined;
    return row ?? null;
  }

  /** Return the total number of pending cleanup jobs. */
  count(): number {
    const row = this.stmtCount.get() as { n: number };
    return row.n;
  }

  /**
   * Insert multiple cleanup jobs in a single transaction.
   * Skips any thread_id that already has a pending job (ON CONFLICT IGNORE).
   */
  insertBatch(jobs: Array<{ thread_id: string; workspace_path: string; worktree_path: string | null; branch: string | null }>): number {
    if (jobs.length === 0) return 0;

    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO cleanup_jobs (id, thread_id, workspace_path, worktree_path, branch, kind, attempts, next_retry_at, created_at)
       VALUES (?, ?, ?, ?, ?, 'explicit', 0, 0, ?)`,
    );

    let inserted = 0;
    const now = Date.now();

    const tx = this.db.transaction(() => {
      for (const job of jobs) {
        const result = insert.run(randomUUID(), job.thread_id, job.workspace_path, job.worktree_path, job.branch, now);
        if (result.changes > 0) inserted++;
      }
    });
    tx();

    return inserted;
  }

  /** Count pending cleanup jobs for a given workspace path. */
  countByWorkspacePath(workspacePath: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM cleanup_jobs WHERE workspace_path = ?")
      .get(workspacePath) as { count: number };
    return row.count;
  }

  /** Find a cleanup job by thread ID. Returns null if no job exists. */
  findByThreadId(threadId: string): CleanupJob | null {
    const row = this.stmtFindByThreadId.get(threadId) as CleanupJob | undefined;
    return row ?? null;
  }

  /** Delete a cleanup job by its associated thread ID. Returns true if a row was removed. */
  deleteByThreadId(threadId: string): boolean {
    const job = this.findByThreadId(threadId);
    if (!job) return false;
    return this.delete(job.id);
  }

  /** Count jobs that still have retries remaining for a workspace path. */
  countRetriableByWorkspacePath(workspacePath: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM cleanup_jobs WHERE workspace_path = ? AND attempts < 5")
      .get(workspacePath) as { count: number };
    return row.count;
  }

  /** Get the most recent error message from cleanup jobs for a workspace path. */
  getLastErrorByWorkspacePath(workspacePath: string): string | null {
    const row = this.db
      .prepare(
        `SELECT last_error FROM cleanup_jobs
          WHERE workspace_path = ? AND last_error IS NOT NULL
          ORDER BY next_retry_at DESC, created_at DESC
          LIMIT 1`,
      )
      .get(workspacePath) as { last_error: string | null } | undefined;
    return row?.last_error ?? null;
  }
}
