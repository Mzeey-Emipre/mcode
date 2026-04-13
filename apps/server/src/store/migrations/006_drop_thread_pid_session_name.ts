import type Database from "better-sqlite3";

/** Human-readable description shown in CLI status. */
export const description = "Drop pid and session_name columns from threads";

/** Apply this migration. Runner wraps this in a transaction. */
export function up(db: Database.Database): void {
  db.exec("ALTER TABLE threads DROP COLUMN pid");
  db.exec("ALTER TABLE threads DROP COLUMN session_name");
}

/**
 * Reverse this migration.
 * Re-adds the dropped columns with their original defaults.
 */
export function down(db: Database.Database): void {
  db.exec("ALTER TABLE threads ADD COLUMN session_name TEXT NOT NULL DEFAULT ''");
  db.exec("ALTER TABLE threads ADD COLUMN pid INTEGER DEFAULT NULL");
}
