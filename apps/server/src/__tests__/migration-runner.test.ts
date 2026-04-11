import Database from "better-sqlite3";
import { describe, it, expect, beforeEach } from "vitest";
import { MigrationRunner } from "../store/migrations/runner.js";
import type { MigrationModule } from "../store/migrations/runner.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Open a fresh in-memory SQLite database for each test. */
function freshDb(): Database.Database {
  return new Database(":memory:");
}

/**
 * Build a simple migration module that adds/drops a single column.
 * Using a dedicated table per test (not `threads`) keeps tests independent.
 */
function makeColumnMigration(
  description: string,
  table: string,
  column: string,
): MigrationModule {
  return {
    description,
    up(db) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT DEFAULT NULL`);
    },
    down(db) {
      db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    },
  };
}

/** Create a temporary table so column migrations have something to work with. */
function createTempTable(db: Database.Database, name: string): void {
  db.exec(`CREATE TABLE IF NOT EXISTS ${name} (id INTEGER PRIMARY KEY)`);
}

// A reusable set of three migrations that all operate on table "items".
function threeItemMigrations(): Map<number, MigrationModule> {
  return new Map([
    [1, makeColumnMigration("add col_a", "items", "col_a")],
    [2, makeColumnMigration("add col_b", "items", "col_b")],
    [3, makeColumnMigration("add col_c", "items", "col_c")],
  ]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MigrationRunner", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = freshDb();
  });

  // -------------------------------------------------------------------------
  // 1. Fresh DB: up() applies all migrations
  // -------------------------------------------------------------------------
  describe("up() on fresh DB", () => {
    it("applies all migrations and applied() returns them all", () => {
      createTempTable(db, "items");
      const runner = new MigrationRunner(db, threeItemMigrations());

      const result = runner.up();

      expect(result.applied).toBe(3);
      expect(result.migrations).toHaveLength(3);
      expect(result.migrations.map((m) => m.version)).toEqual([1, 2, 3]);

      const allApplied = runner.applied();
      expect(allApplied).toHaveLength(3);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Partial DB: up() only applies remaining migrations
  // -------------------------------------------------------------------------
  describe("up() with pre-applied migration", () => {
    it("skips already-applied versions and only runs the rest", () => {
      createTempTable(db, "items");

      // Pre-apply version 1 via the runner so col_a exists.
      const runnerA = new MigrationRunner(db, threeItemMigrations());
      runnerA.up(1);

      // A new runner over the same DB should only apply 2 and 3.
      const runnerB = new MigrationRunner(db, threeItemMigrations());
      const result = runnerB.up();

      expect(result.applied).toBe(2);
      expect(result.migrations.map((m) => m.version)).toEqual([2, 3]);
    });
  });

  // -------------------------------------------------------------------------
  // 3. down() reverts the last migration
  // -------------------------------------------------------------------------
  describe("down() with no argument", () => {
    it("reverts only the last applied migration", () => {
      createTempTable(db, "items");
      const runner = new MigrationRunner(db, threeItemMigrations());
      runner.up();

      const result = runner.down();

      expect(result.reverted).toBe(1);
      expect(result.migrations).toHaveLength(1);
      expect(result.migrations[0].version).toBe(3);

      // col_c should be gone, col_a and col_b should remain.
      const cols = (db.pragma("table_info(items)")) as Array<{ name: string }>;
      const colNames = cols.map((c) => c.name);
      expect(colNames).not.toContain("col_c");
      expect(colNames).toContain("col_a");
      expect(colNames).toContain("col_b");

      expect(runner.applied()).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // 4. down(2) reverts the last two migrations
  // -------------------------------------------------------------------------
  describe("down(2)", () => {
    it("reverts the last two applied migrations", () => {
      createTempTable(db, "items");
      const runner = new MigrationRunner(db, threeItemMigrations());
      runner.up();

      const result = runner.down(2);

      expect(result.reverted).toBe(2);
      expect(result.migrations.map((m) => m.version)).toEqual([3, 2]);

      const cols = (db.pragma("table_info(items)")) as Array<{ name: string }>;
      const colNames = cols.map((c) => c.name);
      expect(colNames).not.toContain("col_c");
      expect(colNames).not.toContain("col_b");
      expect(colNames).toContain("col_a");

      expect(runner.applied()).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // 5. down() on empty set returns 0 reverted
  // -------------------------------------------------------------------------
  describe("down() on empty applied set", () => {
    it("returns 0 reverted without throwing when nothing is applied", () => {
      const runner = new MigrationRunner(db, new Map());
      const result = runner.down();

      expect(result.reverted).toBe(0);
      expect(result.migrations).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // 6. pending() returns correct list before and after applying
  // -------------------------------------------------------------------------
  describe("pending()", () => {
    it("returns all migrations as pending before any are applied", () => {
      createTempTable(db, "items");
      const runner = new MigrationRunner(db, threeItemMigrations());

      const pending = runner.pending();
      expect(pending.map((m) => m.version)).toEqual([1, 2, 3]);
    });

    it("returns only unapplied migrations after some are applied", () => {
      createTempTable(db, "items");
      const runner = new MigrationRunner(db, threeItemMigrations());
      runner.up(1);

      const pending = runner.pending();
      expect(pending.map((m) => m.version)).toEqual([2, 3]);
    });

    it("returns empty list when all are applied", () => {
      createTempTable(db, "items");
      const runner = new MigrationRunner(db, threeItemMigrations());
      runner.up();

      expect(runner.pending()).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // 7. applied() returns records sorted ascending
  // -------------------------------------------------------------------------
  describe("applied()", () => {
    it("returns records in ascending version order", () => {
      createTempTable(db, "items");
      const runner = new MigrationRunner(db, threeItemMigrations());
      runner.up();

      const records = runner.applied();
      expect(records.map((r) => r.version)).toEqual([1, 2, 3]);
    });

    it("records include name and appliedAt fields", () => {
      createTempTable(db, "items");
      const runner = new MigrationRunner(db, threeItemMigrations());
      runner.up(1);

      const [record] = runner.applied();
      expect(record.version).toBe(1);
      expect(record.name).toBe("add col_a");
      expect(typeof record.appliedAt).toBe("string");
      expect(record.appliedAt.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // 8. validate() detects gaps (applied version with no module)
  // -------------------------------------------------------------------------
  describe("validate()", () => {
    it("is valid when all applied versions have a module", () => {
      createTempTable(db, "items");
      const runner = new MigrationRunner(db, threeItemMigrations());
      runner.up();

      expect(runner.validate()).toEqual({ valid: true, gaps: [] });
    });

    it("reports applied version with no file in map as a gap", () => {
      // Manually insert a version that has no module in the map.
      const runner = new MigrationRunner(db, new Map());
      db.exec("INSERT INTO _migrations (version, name) VALUES (99, 'ghost')");

      const result = runner.validate();
      expect(result.valid).toBe(false);
      expect(result.gaps).toContain(99);
    });
  });

  // -------------------------------------------------------------------------
  // 9. Transaction rollback: if up() throws, DB is unchanged
  // -------------------------------------------------------------------------
  describe("transaction rollback on up() failure", () => {
    it("leaves DB unchanged when a migration throws", () => {
      createTempTable(db, "items");

      const failingMigrations: Map<number, MigrationModule> = new Map([
        [1, makeColumnMigration("add col_a", "items", "col_a")],
        [
          2,
          {
            description: "intentional failure",
            up(_db) {
              throw new Error("migration 2 failed intentionally");
            },
            down(_db) {
              /* no-op */
            },
          },
        ],
      ]);

      const runner = new MigrationRunner(db, failingMigrations);

      // Apply migration 1 successfully first.
      runner.up(1);
      expect(runner.applied()).toHaveLength(1);

      // Migration 2 should throw and leave the DB as-is.
      expect(() => runner.up(1)).toThrow("migration 2 failed intentionally");

      // Only version 1 should be in _migrations.
      expect(runner.applied()).toHaveLength(1);
      expect(runner.applied()[0].version).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // 10. Transaction rollback: if down() throws, DB is unchanged
  // -------------------------------------------------------------------------
  describe("transaction rollback on down() failure", () => {
    it("reverts down() if the module throws", () => {
      createTempTable(db, "items");

      const migrations: Map<number, MigrationModule> = new Map([
        [1, makeColumnMigration("add col_a", "items", "col_a")],
        [
          2,
          {
            description: "add col_b",
            up(db) {
              db.exec("ALTER TABLE items ADD COLUMN col_b TEXT DEFAULT NULL");
            },
            down(_db) {
              // Simulates a buggy rollback so we can verify transaction safety.
              throw new Error("down migration 2 failed intentionally");
            },
          },
        ],
      ]);

      const runner = new MigrationRunner(db, migrations);
      runner.up();
      expect(runner.applied()).toHaveLength(2);

      // down() on migration 2 throws — the DELETE should be rolled back.
      expect(() => runner.down()).toThrow("down migration 2 failed intentionally");

      // Both migrations must still be recorded as applied.
      expect(runner.applied()).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // 11. down(0) throws
  // -------------------------------------------------------------------------
  describe("down(0) validation", () => {
    it("throws when steps is 0", () => {
      const runner = new MigrationRunner(db, new Map());
      expect(() => runner.down(0)).toThrow("steps must be a positive integer");
    });
  });

  // -------------------------------------------------------------------------
  // 12. _migrations table bootstrap
  // -------------------------------------------------------------------------
  describe("constructor / table bootstrap", () => {
    it("creates _migrations table on a fresh DB", () => {
      new MigrationRunner(db, new Map());

      const tables = (
        db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'").all()
      ) as Array<{ name: string }>;

      expect(tables).toHaveLength(1);
    });

    it("created table has version, name, and applied_at columns", () => {
      new MigrationRunner(db, new Map());

      const cols = (db.pragma("table_info(_migrations)")) as Array<{ name: string }>;
      const colNames = cols.map((c) => c.name);

      expect(colNames).toContain("version");
      expect(colNames).toContain("name");
      expect(colNames).toContain("applied_at");
    });
  });

  // -------------------------------------------------------------------------
  // 13. name column migration for legacy _migrations tables
  // -------------------------------------------------------------------------
  describe("legacy _migrations table (no name column)", () => {
    it("adds name column when _migrations exists without it", () => {
      // Simulate a pre-existing legacy table (no name column).
      db.exec(`
        CREATE TABLE _migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      db.exec("INSERT INTO _migrations (version) VALUES (1)");

      // Constructor should patch the table without throwing.
      new MigrationRunner(db, new Map());

      const cols = (db.pragma("table_info(_migrations)")) as Array<{ name: string }>;
      const colNames = cols.map((c) => c.name);
      expect(colNames).toContain("name");

      // Existing row should have the default empty string for name.
      const row = db.prepare("SELECT name FROM _migrations WHERE version = 1").get() as {
        name: string;
      };
      expect(row.name).toBe("");
    });
  });
});
