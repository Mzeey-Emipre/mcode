/**
 * SQLite database setup with WAL mode, foreign keys, and forward-only migrations.
 * Migrated from apps/desktop/src/main/store/database.ts for standalone server use.
 */

import Database from "better-sqlite3";
import { existsSync } from "fs";
import { createRequire } from "module";
import { dirname, join } from "path";
import { getMcodeDir } from "@mcode/shared";

/**
 * Resolve the correct native binding for better-sqlite3 based on runtime.
 *
 * When running under Electron, returns the path to the Electron-specific
 * prebuild (`better_sqlite3.electron.node`). Under plain Node.js (e.g.
 * vitest), returns `undefined` so better-sqlite3 falls back to its default
 * `bindings` resolution (the Node.js prebuild).
 */
function resolveNativeBinding(): string | undefined {
  if (!process.versions.electron) return undefined;

  const localRequire = createRequire(import.meta.url);
  const betterSqliteDir = dirname(
    localRequire.resolve("better-sqlite3/package.json"),
  );
  const bindingPath = join(betterSqliteDir, "build", "Release", "better_sqlite3.electron.node");

  if (!existsSync(bindingPath)) {
    throw new Error(
      `Electron prebuild not found at ${bindingPath}. Run 'bun install' to download it.`,
    );
  }

  return bindingPath;
}

const V001_SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    provider_config TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    mode TEXT NOT NULL DEFAULT 'direct',
    worktree_path TEXT,
    branch TEXT NOT NULL,
    issue_number INTEGER,
    pr_number INTEGER,
    pr_status TEXT,
    session_name TEXT NOT NULL DEFAULT '',
    pid INTEGER,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_threads_workspace ON threads(workspace_id);
CREATE INDEX IF NOT EXISTS idx_threads_status ON threads(status);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY NOT NULL,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    tool_calls TEXT,
    files_changed TEXT,
    cost_usd REAL,
    tokens_used INTEGER,
    timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    sequence INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_messages_sequence ON messages(thread_id, sequence);
`;

/**
 * Open (or create) a SQLite database with WAL mode and foreign keys enabled,
 * then run any pending migrations.
 */
export function openDatabase(dbPath?: string): Database.Database {
  const resolvedPath =
    dbPath ?? process.env.MCODE_DB_PATH ?? join(getMcodeDir(), "mcode.db");
  const nativeBinding = resolveNativeBinding();
  const db = new Database(resolvedPath, { nativeBinding });
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("cache_size = -2000");  // 2MB page cache (negative = KB)
  db.pragma("mmap_size = 0");       // Disable memory-mapped I/O
  runMigrations(db);
  return db;
}

/**
 * Open an in-memory database for testing. Applies the same WAL mode, foreign
 * keys, and migrations as a file-backed database. Memory-tuning pragmas
 * (cache_size, mmap_size) are omitted as they are not meaningful for
 * in-memory databases.
 */
export function openMemoryDatabase(): Database.Database {
  const nativeBinding = resolveNativeBinding();
  const db = new Database(":memory:", { nativeBinding });
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function runMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  const row = db
    .prepare("SELECT MAX(version) as v FROM _migrations")
    .get() as { v: number | null } | undefined;
  const currentVersion = row?.v ?? 0;

  if (currentVersion < 1) {
    db.exec(V001_SCHEMA);
    db.prepare("INSERT INTO _migrations (version) VALUES (?)").run(1);
  }

  if (currentVersion < 2) {
    db.exec("ALTER TABLE threads ADD COLUMN model TEXT DEFAULT NULL");
    db.prepare("INSERT INTO _migrations (version) VALUES (?)").run(2);
  }

  if (currentVersion < 3) {
    db.exec(
      "ALTER TABLE threads ADD COLUMN worktree_managed INTEGER NOT NULL DEFAULT 1",
    );
    db.prepare("INSERT INTO _migrations (version) VALUES (?)").run(3);
  }

  if (currentVersion < 4) {
    db.exec("ALTER TABLE messages ADD COLUMN attachments TEXT DEFAULT NULL");
    db.prepare("INSERT INTO _migrations (version) VALUES (?)").run(4);
  }

  if (currentVersion < 5) {
    db.exec(
      "ALTER TABLE threads ADD COLUMN sdk_session_id TEXT DEFAULT NULL",
    );
    db.prepare("INSERT INTO _migrations (version) VALUES (?)").run(5);
  }

  if (currentVersion < 6) {
    db.exec("ALTER TABLE threads DROP COLUMN pid");
    db.exec("ALTER TABLE threads DROP COLUMN session_name");
    db.prepare("INSERT INTO _migrations (version) VALUES (?)").run(6);
  }

  if (currentVersion < 7) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tool_call_records (
        id TEXT PRIMARY KEY NOT NULL,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        parent_tool_call_id TEXT,
        tool_name TEXT NOT NULL,
        input_summary TEXT NOT NULL DEFAULT '',
        output_summary TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'running',
        started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        completed_at TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_tool_call_records_message ON tool_call_records(message_id);
      CREATE INDEX IF NOT EXISTS idx_tool_call_records_parent ON tool_call_records(parent_tool_call_id);

      CREATE TABLE IF NOT EXISTS turn_snapshots (
        id TEXT PRIMARY KEY NOT NULL,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        ref_before TEXT NOT NULL,
        ref_after TEXT NOT NULL,
        files_changed TEXT NOT NULL DEFAULT '[]',
        worktree_path TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE INDEX IF NOT EXISTS idx_turn_snapshots_message ON turn_snapshots(message_id);
      CREATE INDEX IF NOT EXISTS idx_turn_snapshots_thread ON turn_snapshots(thread_id);
    `);
    db.prepare("INSERT INTO _migrations (version) VALUES (?)").run(7);
  }

  if (currentVersion < 8) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS thread_tasks (
        thread_id TEXT PRIMARY KEY NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        tasks_json TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    `);
    db.prepare("INSERT INTO _migrations (version) VALUES (?)").run(8);
  }

  if (currentVersion < 9) {
    db.transaction(() => {
      db.exec(`
        ALTER TABLE threads ADD COLUMN last_context_tokens INTEGER DEFAULT NULL;
        ALTER TABLE threads ADD COLUMN context_window INTEGER DEFAULT NULL;
      `);
      db.prepare("INSERT INTO _migrations (version) VALUES (?)").run(9);
    })();
  }

  if (currentVersion < 10) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS cleanup_jobs (
        id TEXT PRIMARY KEY NOT NULL,
        thread_id TEXT NOT NULL UNIQUE,
        workspace_path TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        branch TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_retry_at INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_cleanup_jobs_retry ON cleanup_jobs(next_retry_at, attempts, created_at);
    `);
    db.prepare("INSERT INTO _migrations (version) VALUES (?)").run(10);
  }
}
