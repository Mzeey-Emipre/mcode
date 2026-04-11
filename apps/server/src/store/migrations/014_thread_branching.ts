import type Database from "better-sqlite3";

/** Human-readable description shown in CLI status. */
export const description = "Add parent_thread_id and forked_from_message_id to threads";

/** Apply this migration. Runner wraps this in a transaction. */
export function up(db: Database.Database): void {
  db.exec(`
    ALTER TABLE threads ADD COLUMN parent_thread_id TEXT DEFAULT NULL;
    ALTER TABLE threads ADD COLUMN forked_from_message_id TEXT DEFAULT NULL;
  `);
}

/**
 * Reverse this migration.
 * Throw if rollback is not possible (e.g., irreversible data migration).
 */
export function down(db: Database.Database): void {
  db.exec("ALTER TABLE threads DROP COLUMN parent_thread_id");
  db.exec("ALTER TABLE threads DROP COLUMN forked_from_message_id");
}
