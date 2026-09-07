/**
 * Seeds Drizzle migration bookkeeping when opening a database that was migrated
 * with the legacy `_migrations` runner so `migrate()` stays in sync without
 * re-applying the baseline SQL.
 *
 * Also provides {@link reconcileMigrations} to clean up orphaned tracking
 * entries left behind when migration files are renumbered (e.g. after
 * resolving merge conflicts).
 */

import * as NodeCrypto from "node:crypto";
import type { Database } from "bun:sqlite";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const PREVIOUS_MIGRATION_TAG = "0041_index_completed_thread_cleanup";
const SUBAGENT_IDENTITY_MIGRATION_TAG = "0042_supreme_terrax";

type JournalEntry = {
  tag: string;
  when: number;
};

type MigrationJournal = {
  entries: JournalEntry[];
};

function readJournal(drizzleDir: string): MigrationJournal {
  const journalPath = NodePath.join(drizzleDir, "meta", "_journal.json");
  return JSON.parse(NodeFS.readFileSync(journalPath, "utf-8")) as MigrationJournal;
}

function migrationHash(drizzleDir: string, tag: string): string {
  return NodeCrypto.createHash("sha256")
    .update(NodeFS.readFileSync(NodePath.join(drizzleDir, `${tag}.sql`), "utf-8"))
    .digest("hex");
}

function tableExists(db: Database, name: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
  return row !== null;
}

function hasSubagentIdentityKey(db: Database): boolean {
  return (
    db.prepare("PRAGMA table_info(tool_call_records)").all() as Array<{ name: string }>
  ).some((column) => column.name === "subagent_identity_key");
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
function baselineAlreadyApplied(db: Database): boolean {
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
export function bootstrapDrizzle(db: Database, drizzleDir: string): void {
  if (tableExists(db, "__drizzle_migrations")) {
    const drizzleCount = (
      db.prepare("SELECT count(*) AS c FROM __drizzle_migrations").get() as { c: number }
    ).c;
    if (drizzleCount > 0) return;
  }

  if (!baselineAlreadyApplied(db)) return;

  const journalPath = NodePath.join(drizzleDir, "meta", "_journal.json");
  const journal = JSON.parse(NodeFS.readFileSync(journalPath, "utf-8")) as {
    entries: Array<{ idx: number; tag: string; when: number }>;
  };
  const baseline = journal.entries[0];
  if (!baseline) {
    throw new Error("Drizzle journal has no entries; cannot bootstrap");
  }

  const sqlPath = NodePath.join(drizzleDir, `${baseline.tag}.sql`);
  const sqlContent = NodeFS.readFileSync(sqlPath, "utf-8");
  const hash = NodeCrypto.createHash("sha256").update(sqlContent).digest("hex");

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
export function reconcileMigrations(db: Database, drizzleDir: string): void {
  if (!tableExists(db, "__drizzle_migrations")) return;

  const journalPath = NodePath.join(drizzleDir, "meta", "_journal.json");
  const journal = JSON.parse(NodeFS.readFileSync(journalPath, "utf-8")) as {
    entries: Array<{ idx: number; tag: string; when: number }>;
  };

  // Compute hashes the same way Drizzle does: Buffer.toString() then SHA-256
  const currentHashes = new Set<string>();
  for (const entry of journal.entries) {
    const sqlPath = NodePath.join(drizzleDir, `${entry.tag}.sql`);
    const sqlContent = NodeFS.readFileSync(sqlPath).toString();
    currentHashes.add(NodeCrypto.createHash("sha256").update(sqlContent).digest("hex"));
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

/** Reconciles the 0042 tracker entry for databases patched by the previous release. */
export function reconcileSubagentIdentityMigration(
  db: Database,
  drizzleDir: string,
): void {
  const journal = readJournal(drizzleDir);
  const subagentIdentityMigration = journal.entries.find(
    (entry) => entry.tag === SUBAGENT_IDENTITY_MIGRATION_TAG,
  );
  if (!subagentIdentityMigration) {
    return;
  }
  const previousMigration = journal.entries.find(
    (entry) => entry.tag === PREVIOUS_MIGRATION_TAG,
  );
  if (!previousMigration) {
    throw new Error(`Drizzle journal has no entry for ${PREVIOUS_MIGRATION_TAG}`);
  }

  const previousMigrationHash = migrationHash(drizzleDir, PREVIOUS_MIGRATION_TAG);
  const subagentIdentityMigrationHash = migrationHash(
    drizzleDir,
    SUBAGENT_IDENTITY_MIGRATION_TAG,
  );
  db.transaction(() => {
    if (
      !tableExists(db, "__drizzle_migrations")
      || !hasSubagentIdentityKey(db)
    ) {
      return;
    }
    const latestMigration = db.prepare(
      "SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1",
    ).get() as { hash: string; created_at: number } | undefined;
    if (
      !latestMigration
      || latestMigration.created_at !== previousMigration.when
      || latestMigration.hash !== previousMigrationHash
    ) {
      return;
    }
    db.prepare(
      `INSERT INTO __drizzle_migrations ("hash", "created_at") VALUES (?, ?)`,
    ).run(subagentIdentityMigrationHash, subagentIdentityMigration.when);
  }).immediate();
}
