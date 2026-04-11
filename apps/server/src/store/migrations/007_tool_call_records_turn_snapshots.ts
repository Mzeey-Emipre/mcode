import type Database from "better-sqlite3";

/** Human-readable description shown in CLI status. */
export const description = "Add tool_call_records and turn_snapshots tables";

/** Apply this migration. Runner wraps this in a transaction. */
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_call_records (
      id TEXT PRIMARY KEY NOT NULL,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      parent_tool_call_id TEXT,
      tool_name TEXT NOT NULL,
      input_summary TEXT NOT NULL DEFAULT '',
      output_summary TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'running',
      started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      completed_at TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_tool_call_records_message ON tool_call_records(message_id);
    CREATE INDEX IF NOT EXISTS idx_tool_call_records_parent ON tool_call_records(parent_tool_call_id);

    CREATE TABLE IF NOT EXISTS turn_snapshots (
      id TEXT PRIMARY KEY NOT NULL,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      ref_before TEXT NOT NULL,
      ref_after TEXT NOT NULL,
      files_changed TEXT NOT NULL DEFAULT '[]',
      worktree_path TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_turn_snapshots_message ON turn_snapshots(message_id);
    CREATE INDEX IF NOT EXISTS idx_turn_snapshots_thread ON turn_snapshots(thread_id);
  `);
}

/**
 * Reverse this migration.
 * Throw if rollback is not possible (e.g., irreversible data migration).
 */
export function down(db: Database.Database): void {
  db.exec("DROP TABLE IF EXISTS turn_snapshots;");
  db.exec("DROP TABLE IF EXISTS tool_call_records;");
}
