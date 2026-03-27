/**
 * SQLite database setup with WAL mode, foreign keys, and forward-only migrations.
 * Migrated from apps/desktop/src/main/store/database.ts for standalone server use.
 */

import Database from "better-sqlite3";
import { join } from "path";
import { getMcodeDir } from "@mcode/shared";

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
  const db = new Database(resolvedPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

/**
 * Open an in-memory database for testing. Applies the same pragmas and
 * migrations as a file-backed database.
 */
export function openMemoryDatabase(): Database.Database {
  const db = new Database(":memory:");
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
}
