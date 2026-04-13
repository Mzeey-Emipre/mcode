import type Database from "better-sqlite3";

/** Human-readable description shown in CLI status. */
export const description = "Add model column to threads";

/** Apply this migration. Runner wraps this in a transaction. */
export function up(db: Database.Database): void {
  db.exec("ALTER TABLE threads ADD COLUMN model TEXT DEFAULT NULL");
}

/**
 * Reverse this migration.
 * Throw if rollback is not possible (e.g., irreversible data migration).
 */
export function down(db: Database.Database): void {
  db.exec("ALTER TABLE threads DROP COLUMN model");
}
