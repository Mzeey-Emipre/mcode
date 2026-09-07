/**
 * SQLite database setup with the approved connection policy and Drizzle migrations.
 */

import { Database } from "bun:sqlite";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { getMcodeDir, resolveDbPath } from "@mcode/shared";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import {
  bootstrapDrizzle,
  reconcileMigrations,
  reconcileSubagentIdentityMigration,
} from "./bootstrap-drizzle.js";
import {
  createMigrationBackup,
  pruneMigrationBackups,
  restoreMigrationBackupAfterFailure,
  type MigrationBackupSpaceOptions,
} from "./migration-backup.js";
import {
  applySQLiteConnectionPolicy,
  optimizeSQLiteConnection,
} from "./sqlite-connection-policy.js";

/**
 * Drizzle's migrator joins paths with `/` inside readMigrationFiles; normalize so
 * Windows `migrationsFolder` strings remain valid for fs.*
 */
function migrationsFolderForDrizzle(absDir: string): string {
  return NodePath.resolve(absDir).replace(/\\/g, "/");
}

/**
 * Locate the Drizzle `drizzle/` directory at runtime.
 *
 * Walks upward from this module so it works when:
 * - Bundled next to `server.cjs` (`dist/server/drizzle/`),
 * - Run from source under `apps/server/src/runtime/persistence/sqlite/`,
 * - Vitest or other tools rewrite `import.meta.url` into deep cache paths.
 *
 * Override with `MCODE_DRIZZLE_MIGRATIONS_DIR` (absolute path to `drizzle/`).
 */
function resolveDrizzleMigrationsDir(): string {
  const fromEnv = process.env.MCODE_DRIZZLE_MIGRATIONS_DIR;
  if (fromEnv) {
    const dir = NodePath.resolve(fromEnv.trim());
    if (!NodeFS.existsSync(NodePath.join(dir, "meta", "_journal.json"))) {
      throw new Error(
        `MCODE_DRIZZLE_MIGRATIONS_DIR is set but meta/_journal.json is missing: ${dir}`,
      );
    }
    return dir;
  }

  let dir = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
  for (let i = 0; i < 20; i++) {
    const candidate = NodePath.join(dir, "drizzle");
    if (NodeFS.existsSync(NodePath.join(candidate, "meta", "_journal.json"))) {
      return NodePath.resolve(candidate);
    }
    const parent = NodePath.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(
    "Drizzle migrations not found: no directory named drizzle/meta/_journal.json when walking up from this module",
  );
}

/** Cached migrations folder and the override that selected it. */
let drizzleDirMemo: { override: string | undefined; directory: string } | null = null;

function getDrizzleMigrationsDir(): string {
  const override = process.env.MCODE_DRIZZLE_MIGRATIONS_DIR;
  if (!drizzleDirMemo || drizzleDirMemo.override !== override) {
    drizzleDirMemo = { override, directory: resolveDrizzleMigrationsDir() };
  }
  return drizzleDirMemo.directory;
}

function hasSubagentIdentityMigration(migrationsDir: string | undefined): boolean {
  if (!migrationsDir || !NodeFS.existsSync(migrationsDir)) return false;
  return NodeFS.readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .some((name) => NodeFS.readFileSync(NodePath.join(migrationsDir, name), "utf8").includes("subagent_identity_key"));
}

/**
 * Adds columns that were retrofitted into migration 0000 after some databases
 * were already created. `bootstrapDrizzle` marks 0000 as done for any DB that
 * has the `workspaces` sentinel table, so these columns are never applied via
 * the normal migration path on pre-existing installs.
 *
 * Safe to run on fresh databases: the PRAGMA check is a no-op when the column
 * already exists. Safe under concurrent startup: if two processes both pass the
 * PRAGMA check and race to ALTER TABLE, the second will receive a
 * "duplicate column name" error which is swallowed — any other error is
 * rethrown. The optional migration directory lets a staged migration apply
 * through Drizzle before the legacy fallback runs.
 */
export function applySchemaPatches(db: Database, migrationsDir?: string): void {
  applyWorkspaceSchemaPatches(db);
  applyToolCallSchemaPatches(db, migrationsDir);
  applyMessageSchemaPatches(db);
}

function tableColumns(db: Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
}

function addColumn(db: Database, table: string, columnSql: string): void {
  try {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${columnSql}`).run();
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("duplicate column name")) throw error;
  }
}

function applyWorkspaceSchemaPatches(db: Database): void {
  const columns = tableColumns(db, "workspaces");
  if (columns.length === 0) return;
  if (!columns.includes("sort_order")) {
    addColumn(db, "workspaces", "sort_order INTEGER DEFAULT 0 NOT NULL");
  }
  normalizeWorkspaceSortOrder(db);
}

function normalizeWorkspaceSortOrder(db: Database): void {
  const distinctCount = (db.prepare("SELECT COUNT(DISTINCT sort_order) AS cnt FROM workspaces").get() as { cnt: number }).cnt;
  const totalCount = (db.prepare("SELECT COUNT(*) AS cnt FROM workspaces").get() as { cnt: number }).cnt;
  if (totalCount <= 1 || distinctCount >= totalCount) return;
  const ids = (db.prepare("SELECT id FROM workspaces ORDER BY sort_order ASC, created_at DESC, id ASC").all() as Array<{ id: string }>).map((row) => row.id);
  const statement = db.prepare("UPDATE workspaces SET sort_order = ? WHERE id = ?");
  db.transaction(() => ids.forEach((id, index) => statement.run(index, id)))();
}

function applyToolCallSchemaPatches(db: Database, migrationsDir: string | undefined): void {
  const columns = tableColumns(db, "tool_call_records");
  if (columns.length === 0) return;
  const patches = [
    ["output_truncated", "output_truncated INTEGER DEFAULT 0 NOT NULL"],
    ["output_total_bytes", "output_total_bytes INTEGER"],
    ["output_artifact_path", "output_artifact_path TEXT"],
    ["exit_code", "exit_code INTEGER"],
    ["display_name", "display_name TEXT"],
    ["provider_agent_key", "provider_agent_key TEXT"],
    ["model", "model TEXT"],
    ["reasoning_effort", "reasoning_effort TEXT"],
  ] as const;
  for (const [name, sql] of patches) {
    if (!columns.includes(name)) addColumn(db, "tool_call_records", sql);
  }
  if (!columns.includes("subagent_identity_key") && !hasSubagentIdentityMigration(migrationsDir)) {
    addColumn(db, "tool_call_records", "subagent_identity_key TEXT");
  }
}

function applyMessageSchemaPatches(db: Database): void {
  const columns = tableColumns(db, "messages");
  if (columns.length > 0 && !columns.includes("mentions")) {
    addColumn(db, "messages", "mentions TEXT");
  }
}

function runMigrations(db: Database): void {
  const dir = getDrizzleMigrationsDir();
  bootstrapDrizzle(db, dir);
  reconcileMigrations(db, dir);
  reconcileSubagentIdentityMigration(db, dir);
  const d = drizzle(db);
  migrate(d, { migrationsFolder: migrationsFolderForDrizzle(dir) });
  applySchemaPatches(db, dir);
}

function readSchemaVersion(db: Database): number {
  const version = (db.query("PRAGMA schema_version").get() as { schema_version?: unknown } | null)?.schema_version;
  if (typeof version !== "number") {
    throw new Error(`PRAGMA schema_version returned ${typeof version}, expected number.`);
  }
  return version;
}

/** Options for a file-backed application database connection. */
export interface OpenDatabaseOptions {
  dbPath?: string;
  branch?: string;
  gitToplevel?: string;
  migrationBackupSpace?: MigrationBackupSpaceOptions;
}

/**
 * Open (or create) a SQLite database with WAL mode and foreign keys enabled,
 * then run any pending Drizzle migrations.
 *
 * In non-production, a linked git worktree uses `<toplevel>/.mcode-local/mcode.db`; otherwise a
 * branch opts in to `dbs/dev-<hash>.db`. Resolution matches `resolveDbPath` from `@mcode/shared`.
 */
export function openDatabase(opts?: OpenDatabaseOptions): Database {
  const resolvedPath = resolveDatabasePath(opts);
  const dir = NodePath.dirname(resolvedPath);
  if (!NodeFS.existsSync(dir)) NodeFS.mkdirSync(dir, { recursive: true });
  const backupPath = opts?.migrationBackupSpace
    ? createMigrationBackup(resolvedPath, opts.migrationBackupSpace)
    : createMigrationBackup(resolvedPath);
  let db: Database | undefined;
  try {
    db = new Database(resolvedPath, { strict: true });
    applySQLiteConnectionPolicy(db, true);
    optimizeSQLiteConnection(db, "open");
    const schemaVersionBeforeMigrations = readSchemaVersion(db);
    runMigrations(db);
    if (readSchemaVersion(db) !== schemaVersionBeforeMigrations) {
      optimizeSQLiteConnection(db, "maintenance");
    }
    if (backupPath) {
      pruneMigrationBackups(resolvedPath);
    }
  } catch (err) {
    try {
      db?.close(true);
    } catch {
      // ignore: connection may already be invalid
    }
    if (backupPath) {
      restoreMigrationBackupAfterFailure(backupPath, resolvedPath, err);
    }
    throw err;
  }
  return db;
}

function resolveDatabasePath(opts: OpenDatabaseOptions | undefined): string {
  return opts?.dbPath ?? process.env.MCODE_DB_PATH ?? resolveDbPath(getMcodeDir(), {
    branch: opts?.branch ?? process.env.MCODE_GIT_BRANCH,
    gitToplevel: opts?.gitToplevel ?? process.env.MCODE_GIT_TOPLEVEL,
  });
}

/**
 * Open an in-memory database for testing. Applies the same foreign keys
 * and migrations as a file-backed database.
 */
export function openMemoryDatabase(): Database {
  const db = new Database(":memory:", { strict: true });
  applySQLiteConnectionPolicy(db, false);
  try {
    runMigrations(db);
  } catch (err) {
    db.close(true);
    throw err;
  }
  return db;
}
