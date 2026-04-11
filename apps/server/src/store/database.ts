/**
 * SQLite database setup with WAL mode, foreign keys, and forward-only migrations.
 * Migrated from apps/desktop/src/main/store/database.ts for standalone server use.
 */

import Database from "better-sqlite3";
import { existsSync } from "fs";
import { createRequire } from "module";
import { dirname, join } from "path";
import { getMcodeDir } from "@mcode/shared";
import { MigrationRunner } from "./migrations/runner.js";
import type { MigrationModule } from "./migrations/runner.js";
import * as m001 from "./migrations/001_initial_schema.js";
import * as m002 from "./migrations/002_thread_model.js";
import * as m003 from "./migrations/003_thread_worktree_managed.js";
import * as m004 from "./migrations/004_message_attachments.js";
import * as m005 from "./migrations/005_thread_sdk_session_id.js";
import * as m006 from "./migrations/006_drop_thread_pid_session_name.js";
import * as m007 from "./migrations/007_tool_call_records_turn_snapshots.js";
import * as m008 from "./migrations/008_thread_tasks.js";
import * as m009 from "./migrations/009_thread_context_tracking.js";
import * as m010 from "./migrations/010_cleanup_jobs.js";
import * as m011 from "./migrations/011_thread_provider.js";
import * as m012 from "./migrations/012_thread_reasoning_interaction_permission.js";
import * as m013 from "./migrations/013_clear_non_claude_context_window.js";
import * as m014 from "./migrations/014_thread_branching.js";
import * as m015 from "./migrations/015_thread_compact_summary.js";

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

/** Builds the ordered map of all migration modules keyed by version number. */
function loadMigrations(): Map<number, MigrationModule> {
  const migrations = new Map<number, MigrationModule>();
  migrations.set(1, m001);
  migrations.set(2, m002);
  migrations.set(3, m003);
  migrations.set(4, m004);
  migrations.set(5, m005);
  migrations.set(6, m006);
  migrations.set(7, m007);
  migrations.set(8, m008);
  migrations.set(9, m009);
  migrations.set(10, m010);
  migrations.set(11, m011);
  migrations.set(12, m012);
  migrations.set(13, m013);
  migrations.set(14, m014);
  migrations.set(15, m015);
  return migrations;
}

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
  new MigrationRunner(db, loadMigrations()).up();
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
  new MigrationRunner(db, loadMigrations()).up();
  return db;
}
