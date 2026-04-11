import type Database from "better-sqlite3";

/** Human-readable description shown in CLI status. */
export const description = "Add reasoning_level, interaction_mode, permission_mode to threads";

/** Apply this migration. Runner wraps this in a transaction. */
export function up(db: Database.Database): void {
  db.exec(`
    ALTER TABLE threads ADD COLUMN reasoning_level TEXT DEFAULT NULL;
    ALTER TABLE threads ADD COLUMN interaction_mode TEXT DEFAULT NULL;
    ALTER TABLE threads ADD COLUMN permission_mode TEXT DEFAULT NULL;
  `);
}

/**
 * Reverse this migration.
 * Throw if rollback is not possible (e.g., irreversible data migration).
 */
export function down(db: Database.Database): void {
  db.exec("ALTER TABLE threads DROP COLUMN reasoning_level");
  db.exec("ALTER TABLE threads DROP COLUMN interaction_mode");
  db.exec("ALTER TABLE threads DROP COLUMN permission_mode");
}
