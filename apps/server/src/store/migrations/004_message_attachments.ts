import type Database from "better-sqlite3";

/** Human-readable description shown in CLI status. */
export const description = "Add attachments column to messages";

/** Apply this migration. Runner wraps this in a transaction. */
export function up(db: Database.Database): void {
  db.exec("ALTER TABLE messages ADD COLUMN attachments TEXT DEFAULT NULL");
}

/**
 * Reverse this migration.
 * Throw if rollback is not possible (e.g., irreversible data migration).
 */
export function down(db: Database.Database): void {
  db.exec("ALTER TABLE messages DROP COLUMN attachments");
}
