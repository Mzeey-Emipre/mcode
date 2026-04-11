import type Database from "better-sqlite3";

/** Human-readable description shown in CLI status. */
export const description = "Add thread_tasks table";

/** Apply this migration. Runner wraps this in a transaction. */
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS thread_tasks (
      thread_id TEXT PRIMARY KEY NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      tasks_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);
}

/**
 * Reverse this migration.
 * Throw if rollback is not possible (e.g., irreversible data migration).
 */
export function down(db: Database.Database): void {
  db.exec("DROP TABLE IF EXISTS thread_tasks;");
}
