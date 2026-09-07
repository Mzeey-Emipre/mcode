import type { Database } from "bun:sqlite";

/** Active SQLite page-cache budget in kibibytes. */
export const SQLITE_ACTIVE_CACHE_KIB = 2_048;

/** Background SQLite page-cache budget in kibibytes. */
export const SQLITE_BACKGROUND_CACHE_KIB = 500;

/** SQLite page-cache policy selected by the application lifecycle. */
export type SQLiteCacheBudget = "active" | "background";

function assertPragmaValue(
  db: Database,
  name: "journal_mode" | "busy_timeout" | "mmap_size" | "foreign_keys" | "synchronous" | "cache_size",
  expected: string | number,
): void {
  const row = db.query(`PRAGMA ${name}`).get() as Record<string, unknown> | null;
  const actual = row?.[name === "busy_timeout" ? "timeout" : name];
  if (actual !== expected) {
    throw new Error(
      `SQLite connection policy requires PRAGMA ${name}=${expected}; received ${String(actual)}.`,
    );
  }
}

/** Apply and assert the approved durability and memory policy for one SQLite connection. */
export function applySQLiteConnectionPolicy(
  db: Database,
  isFileBacked: boolean,
): void {
  if (isFileBacked) {
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA busy_timeout = 5000");
    applySQLiteCacheBudget(db, "active");
    db.run("PRAGMA mmap_size = 0");
  }
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA synchronous = FULL");

  if (isFileBacked) {
    assertPragmaValue(db, "journal_mode", "wal");
    assertPragmaValue(db, "busy_timeout", 5_000);
    assertPragmaValue(db, "mmap_size", 0);
  }
  assertPragmaValue(db, "foreign_keys", 1);
  assertPragmaValue(db, "synchronous", 2);
}

/** Apply and assert one bounded SQLite page-cache budget. */
export function applySQLiteCacheBudget(
  db: Database,
  budget: SQLiteCacheBudget,
): number {
  const cacheKiB = budget === "active"
    ? SQLITE_ACTIVE_CACHE_KIB
    : SQLITE_BACKGROUND_CACHE_KIB;
  db.run(`PRAGMA cache_size = -${cacheKiB}`);
  assertPragmaValue(db, "cache_size", -cacheKiB);
  return cacheKiB;
}

/** Run SQLite's bounded optimization for connection startup or later maintenance. */
export function optimizeSQLiteConnection(
  db: Database,
  phase: "open" | "maintenance",
): void {
  db.run(phase === "open" ? "PRAGMA optimize = 0x10002" : "PRAGMA optimize");
}
