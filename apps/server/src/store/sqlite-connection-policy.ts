import type Database from "better-sqlite3";

/** Active SQLite page-cache budget in kibibytes. */
export const SQLITE_ACTIVE_CACHE_KIB = 2_000;

/** Background SQLite page-cache budget in kibibytes. */
export const SQLITE_BACKGROUND_CACHE_KIB = 500;

function assertPragmaValue(
  db: Database.Database,
  name: string,
  expected: string | number,
): void {
  const actual = db.pragma(name, { simple: true });
  if (actual !== expected) {
    throw new Error(
      `SQLite connection policy requires PRAGMA ${name}=${expected}; received ${String(actual)}.`,
    );
  }
}

/** Apply and assert the approved durability and memory policy for one SQLite connection. */
export function applySQLiteConnectionPolicy(
  db: Database.Database,
  isFileBacked: boolean,
): void {
  if (isFileBacked) {
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.pragma(`cache_size = -${SQLITE_ACTIVE_CACHE_KIB}`);
    db.pragma("mmap_size = 0");
  }
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = FULL");

  if (isFileBacked) {
    assertPragmaValue(db, "journal_mode", "wal");
    assertPragmaValue(db, "busy_timeout", 5_000);
    assertPragmaValue(db, "cache_size", -SQLITE_ACTIVE_CACHE_KIB);
    assertPragmaValue(db, "mmap_size", 0);
  }
  assertPragmaValue(db, "foreign_keys", 1);
  assertPragmaValue(db, "synchronous", 2);
}

/** Run SQLite's bounded optimization for connection startup or later maintenance. */
export function optimizeSQLiteConnection(
  db: Database.Database,
  phase: "open" | "maintenance",
): void {
  db.pragma(phase === "open" ? "optimize = 0x10002" : "optimize");
}
