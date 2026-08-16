/**
 * Seeds Drizzle migration bookkeeping when opening a database that was migrated
 * with the legacy `_migrations` runner so `migrate()` stays in sync without
 * re-applying the baseline SQL.
 *
 * Also provides {@link reconcileMigrations} to clean up orphaned tracking
 * entries left behind when migration files are renumbered (e.g. after
 * resolving merge conflicts).
 */

import { createHash } from "crypto";
import type Database from "better-sqlite3";
import { readFileSync } from "fs";
import { join } from "path";

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
  return row !== undefined;
}

/**
 * Sentinel application table. Its presence on a DB without any migration
 * tracking means the schema was set up out-of-band (e.g. `drizzle-kit push`
 * during dev) or by a build older than the legacy `_migrations` runner. In
 * both cases the baseline DDL has effectively been applied and must be
 * marked as such so `migrate()` does not try to replay it.
 */
const SCHEMA_SENTINEL_TABLE = "workspaces";

/**
 * Returns `true` when the DB should be treated as having the Drizzle baseline
 * already applied. Three independent signals satisfy this:
 *   1. Legacy `_migrations` has at least one row (snapshot from the old runner).
 *   2. The sentinel application table exists (DB created via `db:push` or by
 *      a pre-legacy build).
 *   3. Both — handled by either branch above.
 */
function baselineAlreadyApplied(db: Database.Database): boolean {
  if (tableExists(db, "_migrations")) {
    const legacyCount = (
      db.prepare("SELECT count(*) AS c FROM _migrations").get() as { c: number }
    ).c;
    if (legacyCount > 0) return true;
  }
  return tableExists(db, SCHEMA_SENTINEL_TABLE);
}

/**
 * Seeds Drizzle's tracking table so `migrate()` skips the baseline SQL on
 * databases that were already set up by an older path. Covers four cases:
 *
 *   - Legacy `_migrations` populated, no Drizzle tracker → seed baseline.
 *   - `__drizzle_migrations` exists but empty (interrupted bootstrap, or
 *     Drizzle's own migrator created the table before failing) → seed.
 *   - Sentinel app table exists with no tracking at all (`db:push` or
 *     pre-legacy DB) → seed.
 *   - Truly fresh DB → no-op; `migrate()` applies everything from scratch.
 *
 * The CREATE + INSERT runs in a single transaction so an interrupted
 * bootstrap can never leave the tracking table in a half-initialised state.
 *
 * @param db Open SQLite database (foreign keys enabled by caller).
 * @param drizzleDir Absolute or cwd-relative path to `apps/server/drizzle`.
 */
export function bootstrapDrizzle(db: Database.Database, drizzleDir: string): void {
  if (tableExists(db, "__drizzle_migrations")) {
    const drizzleCount = (
      db.prepare("SELECT count(*) AS c FROM __drizzle_migrations").get() as { c: number }
    ).c;
    if (drizzleCount > 0) return;
  }

  if (!baselineAlreadyApplied(db)) return;

  const journalPath = join(drizzleDir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf-8")) as {
    entries: Array<{ idx: number; tag: string; when: number }>;
  };
  const baseline = journal.entries[0];
  if (!baseline) {
    throw new Error("Drizzle journal has no entries; cannot bootstrap");
  }

  const sqlPath = join(drizzleDir, `${baseline.tag}.sql`);
  const sqlContent = readFileSync(sqlPath, "utf-8");
  const hash = createHash("sha256").update(sqlContent).digest("hex");

  // Atomic CREATE + INSERT so an interrupted bootstrap can never leave the
  // tracking table in a "exists but empty" state that fools the early-return.
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS __drizzle_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        hash text NOT NULL,
        created_at numeric
      )
    `);
    db.prepare(
      `INSERT INTO __drizzle_migrations ("hash", "created_at") VALUES (?, ?)`,
    ).run(hash, baseline.when);
  })();
}

/**
 * Removes stale entries from `__drizzle_migrations` whose hashes no longer
 * correspond to any current migration file.
 *
 * This happens when migration files are deleted and renumbered (e.g. after
 * resolving a merge conflict). The orphaned entries' `created_at` timestamps
 * can act as a watermark that blocks newer migrations from being applied,
 * since Drizzle only applies migrations whose `when` exceeds the latest
 * recorded `created_at`.
 *
 * Safe in production: when all applied hashes match the current journal,
 * nothing is deleted.
 */
export function reconcileMigrations(db: Database.Database, drizzleDir: string): void {
  if (!tableExists(db, "__drizzle_migrations")) return;

  const journalPath = join(drizzleDir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf-8")) as {
    entries: Array<{ idx: number; tag: string; when: number }>;
  };

  // Compute hashes the same way Drizzle does: Buffer.toString() then SHA-256
  const currentHashes = new Set<string>();
  for (const entry of journal.entries) {
    const sqlPath = join(drizzleDir, `${entry.tag}.sql`);
    const sqlContent = readFileSync(sqlPath).toString();
    currentHashes.add(createHash("sha256").update(sqlContent).digest("hex"));
  }

  const applied = db
    .prepare("SELECT id, hash FROM __drizzle_migrations")
    .all() as Array<{ id: number; hash: string }>;

  const stale = applied.filter((row) => !currentHashes.has(row.hash));
  if (stale.length === 0) return;

  const del = db.prepare("DELETE FROM __drizzle_migrations WHERE id = ?");
  db.transaction(() => {
    for (const row of stale) {
      del.run(row.id);
    }
  })();
}
