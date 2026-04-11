import type Database from "better-sqlite3";

/** Human-readable description shown in CLI status. */
export const description = "Clear context_window for non-Claude threads";

/** Apply this migration. Runner wraps this in a transaction. */
export function up(db: Database.Database): void {
  // Back up context_window values before clearing so down() can restore them.
  db.exec(`
    CREATE TABLE _migration_013_backup (
      thread_id TEXT NOT NULL PRIMARY KEY,
      context_window INTEGER NOT NULL
    )
  `);
  db.exec(`
    INSERT INTO _migration_013_backup (thread_id, context_window)
    SELECT id, context_window FROM threads
    WHERE provider != 'claude' AND context_window IS NOT NULL
  `);

  // Clear context_window for non-Claude threads. Earlier code wrote a
  // hardcoded DEFAULT_CONTEXT_WINDOW (200 000) for all providers, including
  // Codex which does not expose a context window. Those stale rows cause the
  // context tracker ring to render with an incorrect denominator.
  db.prepare("UPDATE threads SET context_window = NULL WHERE provider != 'claude'").run();
}

/** Reverse this migration by restoring backed-up context_window values. */
export function down(db: Database.Database): void {
  db.exec(`
    UPDATE threads SET context_window = (
      SELECT context_window FROM _migration_013_backup
      WHERE _migration_013_backup.thread_id = threads.id
    )
    WHERE id IN (SELECT thread_id FROM _migration_013_backup)
  `);
  db.exec("DROP TABLE _migration_013_backup");
}
