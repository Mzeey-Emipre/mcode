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

/** Max retry attempts per app session before a job is skipped until restart. */
export const MAX_CLEANUP_ATTEMPTS = 5;

/** Max length for persisted error messages. */
const MAX_ERROR_LENGTH = 500;

export interface CleanupJob {
  id: string;
  thread_id: string;
  workspace_path: string;
  worktree_path: string;
  branch: string | null;
  attempts: number;
  next_retry_at: number;
  last_error: string | null;
  created_at: number;
}

const SELECT_COLS =
  "id, thread_id, workspace_path, worktree_path, branch, attempts, next_retry_at, last_error, created_at";

/** Repository for worktree cleanup job persistence. */
@injectable()
export class CleanupJobRepo {
  private readonly stmtInsert: Statement;
  private readonly stmtFindDue: Statement;
  private readonly stmtRecordFailure: Statement;
  private readonly stmtDelete: Statement;
  private readonly stmtResetAttempts: Statement;
  private readonly stmtFindById: Statement;
  private readonly stmtFindByThreadId: Statement;
  private readonly stmtCount: Statement;

  constructor(@inject("Database") db: Database.Database) {
    this.stmtInsert = db.prepare(
      `INSERT OR IGNORE INTO cleanup_jobs
        (id, thread_id, workspace_path, worktree_path, branch, attempts, next_retry_at, created_at)
       VALUES (?, ?, ?, ?, ?, 0, 0, ?)`,
    );
    this.stmtFindDue = db.prepare(
      `SELECT ${SELECT_COLS} FROM cleanup_jobs
        WHERE next_retry_at <= ? AND attempts < ?
        ORDER BY created_at ASC`,
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
    worktree_path: string;
    branch: string | null;
  }): CleanupJob {
    const id = randomUUID();
    const now = Date.now();

    const result = this.stmtInsert.run(
      id,
      job.thread_id,
      job.workspace_path,
      job.worktree_path,
      job.branch ?? null,
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
  findDue(nowMs: number): CleanupJob[] {
    return this.stmtFindDue.all(nowMs, MAX_CLEANUP_ATTEMPTS) as CleanupJob[];
  }

  /**
   * Record a failed attempt. Increments attempts and schedules next retry
   * with exponential backoff (2^(attempts+1) seconds). Error message is
   * truncated to prevent unbounded growth.
   */
  recordFailure(id: string, error: string): void {
    const truncated = error.slice(0, MAX_ERROR_LENGTH);
    this.stmtRecordFailure.run(Date.now(), truncated, id);
  }

  /** Remove a completed cleanup job. */
  delete(id: string): boolean {
    const result = this.stmtDelete.run(id);
    return result.changes > 0;
  }

  /**
   * Reset all attempt counters to 0 and clear next_retry_at.
   * Called on app startup so stale jobs are retried in the new session.
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
}
