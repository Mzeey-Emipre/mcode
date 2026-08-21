/**
 * SQLite database setup with the approved connection policy and Drizzle migrations.
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, realpathSync, readdirSync, readFileSync } from "fs";
import { createRequire } from "module";
import { dirname, isAbsolute, join, resolve } from "path";
import { fileURLToPath } from "url";
import { getMcodeDir, resolveDbPath } from "@mcode/shared";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
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
  return resolve(absDir).replace(/\\/g, "/");
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
    const dir = resolve(fromEnv.trim());
    if (!existsSync(join(dir, "meta", "_journal.json"))) {
      throw new Error(
        `MCODE_DRIZZLE_MIGRATIONS_DIR is set but meta/_journal.json is missing: ${dir}`,
      );
    }
    return dir;
  }

  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 20; i++) {
    const candidate = join(dir, "drizzle");
    if (existsSync(join(candidate, "meta", "_journal.json"))) {
      return resolve(candidate);
    }
    const parent = dirname(dir);
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

/** Resolves and validates the approved better-sqlite3 binding for this process. */
export function resolveElectronNativeBinding(): string {
  if (!process.versions.electron) {
    throw new Error("SQLite requires Electron's Node.js runtime.");
  }

  const localRequire = createRequire(import.meta.url);
  const betterSqliteDir = dirname(localRequire.resolve("better-sqlite3/package.json"));
  const expectedBinding = join(
    betterSqliteDir,
    "build",
    "Release",
    "better_sqlite3.electron.node",
  );
  const configuredBinding = process.env.BETTER_SQLITE3_BINDING;

  if (!configuredBinding) {
    throw new Error(
      `BETTER_SQLITE3_BINDING must be ${expectedBinding}. Run 'bun install' to install the Electron binding.`,
    );
  }
  if (resolve(configuredBinding) === resolve(expectedBinding)) {
    if (!existsSync(expectedBinding)) {
      throw new Error(
        `Workspace Electron better-sqlite3 binding not found: ${expectedBinding}. Run 'bun install'.`,
      );
    }
    return expectedBinding;
  }

  const packagedResourcesRoot = process.env.MCODE_PACKAGED_RESOURCES_ROOT;
  if (!packagedResourcesRoot || !isAbsolute(packagedResourcesRoot)) {
    throw new Error("MCODE_PACKAGED_RESOURCES_ROOT must be an absolute canonical packaged resources directory.");
  }

  const canonicalResourcesRoot = realpathSync(packagedResourcesRoot);
  if (packagedResourcesRoot !== canonicalResourcesRoot) {
    throw new Error("MCODE_PACKAGED_RESOURCES_ROOT must be a canonical packaged resources directory.");
  }

  const expectedPackagedBinding = join(
    canonicalResourcesRoot,
    "app.asar.unpacked",
    "node_modules",
    "better-sqlite3",
    "build",
    "Release",
    "better_sqlite3.node",
  );
  if (!existsSync(configuredBinding) || !existsSync(expectedPackagedBinding)) {
    throw new Error(
      `BETTER_SQLITE3_BINDING must reference the workspace Electron binding or the packaged binding: ${expectedPackagedBinding}`,
    );
  }

  const canonicalBinding = realpathSync(configuredBinding);
  if (canonicalBinding !== expectedPackagedBinding) {
    throw new Error(
      `BETTER_SQLITE3_BINDING must reference the workspace Electron binding or the packaged binding: ${expectedPackagedBinding}`,
    );
  }

  return canonicalBinding;
}

function hasSubagentIdentityMigration(migrationsDir: string | undefined): boolean {
  if (!migrationsDir || !existsSync(migrationsDir)) return false;
  return readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .some((name) => readFileSync(join(migrationsDir, name), "utf8").includes("subagent_identity_key"));
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
export function applySchemaPatches(db: Database.Database, migrationsDir?: string): void {
  const cols = (
    db.prepare("PRAGMA table_info(workspaces)").all() as Array<{ name: string }>
  ).map((r) => r.name);

  // cols is empty when the table doesn't exist; nothing to patch in that case
  if (cols.length > 0 && !cols.includes("sort_order")) {
    try {
      db.prepare(
        "ALTER TABLE workspaces ADD COLUMN sort_order INTEGER DEFAULT 0 NOT NULL",
      ).run();
    } catch (err) {
      if (
        !(err instanceof Error) ||
        !err.message.includes("duplicate column name")
      ) {
        throw err;
      }
    }
  }

  // Normalize sort_order when duplicates exist (e.g. column added with DEFAULT 0).
  // Without unique values, reorder operations silently fail.
  if (cols.length > 0) {
    const distinctCount = (
      db
        .prepare(
          "SELECT COUNT(DISTINCT sort_order) AS cnt FROM workspaces",
        )
        .get() as { cnt: number }
    ).cnt;
    const totalCount = (
      db.prepare("SELECT COUNT(*) AS cnt FROM workspaces").get() as {
        cnt: number;
      }
    ).cnt;

    if (totalCount > 1 && distinctCount < totalCount) {
      const ids = (
        db
          .prepare(
            "SELECT id FROM workspaces ORDER BY sort_order ASC, created_at DESC, id ASC",
          )
          .all() as Array<{ id: string }>
      ).map((r) => r.id);
      const stmt = db.prepare(
        "UPDATE workspaces SET sort_order = ? WHERE id = ?",
      );
      const assign = db.transaction(() => {
        for (let i = 0; i < ids.length; i++) {
          stmt.run(i, ids[i]);
        }
      });
      assign();
    }
  }

  const toolCols = (
    db.prepare("PRAGMA table_info(tool_call_records)").all() as Array<{ name: string }>
  ).map((r) => r.name);
  const addToolCallColumn = (columnSql: string): void => {
    try {
      db.prepare(`ALTER TABLE tool_call_records ADD COLUMN ${columnSql}`).run();
    } catch (err) {
      if (
        !(err instanceof Error) ||
        !err.message.includes("duplicate column name")
      ) {
        throw err;
      }
    }
  };

  if (toolCols.length > 0 && !toolCols.includes("output_truncated")) {
    addToolCallColumn("output_truncated INTEGER DEFAULT 0 NOT NULL");
  }
  if (toolCols.length > 0 && !toolCols.includes("output_total_bytes")) {
    addToolCallColumn("output_total_bytes INTEGER");
  }
  if (toolCols.length > 0 && !toolCols.includes("output_artifact_path")) {
    addToolCallColumn("output_artifact_path TEXT");
  }
  if (toolCols.length > 0 && !toolCols.includes("exit_code")) {
    addToolCallColumn("exit_code INTEGER");
  }
  if (toolCols.length > 0 && !toolCols.includes("display_name")) {
    addToolCallColumn("display_name TEXT");
  }
  if (toolCols.length > 0 && !toolCols.includes("provider_agent_key")) {
    addToolCallColumn("provider_agent_key TEXT");
  }
  if (
    toolCols.length > 0
    && !toolCols.includes("subagent_identity_key")
    && !hasSubagentIdentityMigration(migrationsDir)
  ) {
    // Use the legacy fallback only when the generated migration is unavailable;
    // staged certification runs defer to Drizzle when that artifact is present.
    addToolCallColumn("subagent_identity_key TEXT");
  }
  if (toolCols.length > 0 && !toolCols.includes("model")) {
    addToolCallColumn("model TEXT");
  }
  if (toolCols.length > 0 && !toolCols.includes("reasoning_effort")) {
    addToolCallColumn("reasoning_effort TEXT");
  }

  const messageCols = (
    db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>
  ).map((r) => r.name);
  if (messageCols.length > 0 && !messageCols.includes("mentions")) {
    try {
      db.prepare("ALTER TABLE messages ADD COLUMN mentions TEXT").run();
    } catch (err) {
      if (
        !(err instanceof Error) ||
        !err.message.includes("duplicate column name")
      ) {
        throw err;
      }
    }
  }
}

function runMigrations(db: Database.Database): void {
  const dir = getDrizzleMigrationsDir();
  bootstrapDrizzle(db, dir);
  reconcileMigrations(db, dir);
  reconcileSubagentIdentityMigration(db, dir);
  const d = drizzle(db);
  migrate(d, { migrationsFolder: migrationsFolderForDrizzle(dir) });
  applySchemaPatches(db, dir);
}

function readSchemaVersion(db: Database.Database): number {
  const version = db.pragma("schema_version", { simple: true });
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
export function openDatabase(opts?: OpenDatabaseOptions): Database.Database {
  const resolvedPath =
    opts?.dbPath ??
    process.env.MCODE_DB_PATH ??
    resolveDbPath(getMcodeDir(), {
      branch: opts?.branch ?? process.env.MCODE_GIT_BRANCH,
      gitToplevel: opts?.gitToplevel ?? process.env.MCODE_GIT_TOPLEVEL,
    });

  const dir = dirname(resolvedPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const nativeBinding = resolveElectronNativeBinding();
  const backupPath = opts?.migrationBackupSpace
    ? createMigrationBackup(resolvedPath, opts.migrationBackupSpace)
    : createMigrationBackup(resolvedPath);
  let db: Database.Database | undefined;
  try {
    db = new Database(resolvedPath, { nativeBinding });
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
      db?.close();
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

/**
 * Open an in-memory database for testing. Applies the same foreign keys
 * and migrations as a file-backed database.
 */
export function openMemoryDatabase(): Database.Database {
  const nativeBinding = resolveElectronNativeBinding();
  const db = new Database(":memory:", { nativeBinding });
  applySQLiteConnectionPolicy(db, false);
  try {
    runMigrations(db);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}
