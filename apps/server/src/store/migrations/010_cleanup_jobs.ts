import type Database from "better-sqlite3";

/** Human-readable description shown in CLI status. */
export const description = "Add cleanup_jobs table";

/** Apply this migration. Runner wraps this in a transaction. */
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE cleanup_jobs (
      id TEXT PRIMARY KEY NOT NULL,
      thread_id TEXT NOT NULL UNIQUE,
      workspace_path TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      branch TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_retry_at INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_cleanup_jobs_retry ON cleanup_jobs(next_retry_at, attempts, created_at);
  `);
}

/** Reverse this migration. */
export function down(db: Database.Database): void {
  db.exec("DROP TABLE cleanup_jobs;");
}
