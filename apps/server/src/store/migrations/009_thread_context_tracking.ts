import type Database from "better-sqlite3";

/** Human-readable description shown in CLI status. */
export const description = "Add last_context_tokens and context_window to threads";

/** Apply this migration. Runner wraps this in a transaction. */
export function up(db: Database.Database): void {
  db.exec(`
    ALTER TABLE threads ADD COLUMN last_context_tokens INTEGER DEFAULT NULL;
    ALTER TABLE threads ADD COLUMN context_window INTEGER DEFAULT NULL;
  `);
}

/**
 * Reverse this migration.
 * Throw if rollback is not possible (e.g., irreversible data migration).
 */
export function down(db: Database.Database): void {
  db.exec("ALTER TABLE threads DROP COLUMN last_context_tokens");
  db.exec("ALTER TABLE threads DROP COLUMN context_window");
}
