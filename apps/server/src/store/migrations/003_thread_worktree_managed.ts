import type Database from "better-sqlite3";

/** Human-readable description shown in CLI status. */
export const description = "Add worktree_managed column to threads";

/** Apply this migration. Runner wraps this in a transaction. */
export function up(db: Database.Database): void {
  db.exec("ALTER TABLE threads ADD COLUMN worktree_managed INTEGER NOT NULL DEFAULT 1");
}

/**
 * Reverse this migration.
 * Throw if rollback is not possible (e.g., irreversible data migration).
 */
export function down(db: Database.Database): void {
  db.exec("ALTER TABLE threads DROP COLUMN worktree_managed");
}
