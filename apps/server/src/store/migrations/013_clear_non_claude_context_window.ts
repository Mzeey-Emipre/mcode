import type Database from "better-sqlite3";

/** Human-readable description shown in CLI status. */
export const description = "Clear context_window for non-Claude threads";

/** Apply this migration. Runner wraps this in a transaction. */
export function up(db: Database.Database): void {
  // Clear context_window for non-Claude threads. Earlier code wrote a
  // hardcoded DEFAULT_CONTEXT_WINDOW (200 000) for all providers, including
  // Codex which does not expose a context window. Those stale rows cause the
  // context tracker ring to render with an incorrect denominator.
  db.prepare("UPDATE threads SET context_window = NULL WHERE provider != 'claude'").run();
}

/**
 * Reverse this migration.
 * This migration is irreversible: the cleared data cannot be restored.
 */
export function down(_db: Database.Database): void {
  throw new Error("Migration 013 is irreversible: cleared data cannot be restored");
}
