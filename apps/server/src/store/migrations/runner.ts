/**
 * MigrationRunner: manages forward and backward SQLite migrations using
 * pre-loaded migration modules. Takes a Map of version -> module so the
 * runner is fully testable without filesystem coupling.
 */

import type Database from "better-sqlite3";

/** A row from the _migrations tracking table. */
export interface MigrationRecord {
  version: number;
  name: string;
  appliedAt: string;
}

/**
 * Result of a schema consistency check between the applied versions in the DB
 * and the migration modules available in memory.
 */
export interface ValidationResult {
  valid: boolean;
  /** Applied DB versions that have no corresponding migration module. */
  gaps: number[];
  /** Reserved for future file-contiguity checks; always empty for now. */
  missing: number[];
}

/**
 * A single migration module. Each migration must implement both directions so
 * rollback is always possible.
 */
export interface MigrationModule {
  description: string;
  up(db: Database.Database): void;
  down(db: Database.Database): void;
}

/**
 * Reads the _migrations table and maps rows to MigrationRecord shape.
 * Centralises the snake_case -> camelCase mapping in one place.
 */
function rowToRecord(row: { version: number; name: string; applied_at: string }): MigrationRecord {
  return {
    version: row.version,
    name: row.name,
    appliedAt: row.applied_at,
  };
}

/**
 * Orchestrates forward and backward SQLite migrations for a pre-loaded set of
 * migration modules. Owns the _migrations tracking table lifecycle.
 */
export class MigrationRunner {
  constructor(
    private db: Database.Database,
    private migrations: Map<number, MigrationModule>,
  ) {
    this.ensureTable();
  }

  /**
   * Ensures the _migrations table exists with the expected schema. If the
   * table already exists but lacks the `name` column (legacy schema), the
   * column is added via ALTER TABLE so existing data is preserved.
   */
  private ensureTable(): void {
    // Create table with full schema if it does not exist at all.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // If table existed before (without name column), patch it in.
    const columns = this.db.pragma("table_info(_migrations)") as Array<{ name: string }>;
    const hasNameColumn = columns.some((col) => col.name === "name");
    if (!hasNameColumn) {
      this.db.exec("ALTER TABLE _migrations ADD COLUMN name TEXT NOT NULL DEFAULT ''");
    }
  }

  /**
   * Applies pending migrations in ascending version order. Stops after
   * `steps` migrations when provided; applies all pending when omitted.
   */
  up(steps?: number): { applied: number; migrations: MigrationRecord[] } {
    const appliedVersions = new Set(
      (this.db.prepare("SELECT version FROM _migrations").all() as Array<{ version: number }>).map(
        (r) => r.version,
      ),
    );

    const pending = [...this.migrations.entries()]
      .filter(([version]) => !appliedVersions.has(version))
      .sort(([a], [b]) => a - b);

    const toApply = steps !== undefined ? pending.slice(0, steps) : pending;
    const records: MigrationRecord[] = [];

    const insertStmt = this.db.prepare(
      "INSERT INTO _migrations (version, name) VALUES (?, ?)",
    );

    for (const [version, module] of toApply) {
      this.db.transaction(() => {
        module.up(this.db);
        insertStmt.run(version, module.description);
      })();

      const row = this.db
        .prepare("SELECT version, name, applied_at FROM _migrations WHERE version = ?")
        .get(version) as { version: number; name: string; applied_at: string };
      records.push(rowToRecord(row));
    }

    return { applied: records.length, migrations: records };
  }

  /**
   * Reverts the most-recently applied migrations in descending version order.
   * Defaults to rolling back 1 migration when `steps` is omitted.
   */
  down(steps = 1): { reverted: number; migrations: MigrationRecord[] } {
    const appliedRows = this.db
      .prepare("SELECT version, name, applied_at FROM _migrations ORDER BY version DESC")
      .all() as Array<{ version: number; name: string; applied_at: string }>;

    if (appliedRows.length === 0) {
      return { reverted: 0, migrations: [] };
    }

    const toRevert = appliedRows.slice(0, steps);
    const records: MigrationRecord[] = [];

    const deleteStmt = this.db.prepare("DELETE FROM _migrations WHERE version = ?");

    for (const row of toRevert) {
      const module = this.migrations.get(row.version);
      if (!module) {
        throw new Error(
          `Cannot revert migration v${row.version}: no migration module loaded for that version`,
        );
      }

      const record = rowToRecord(row);

      this.db.transaction(() => {
        module.down(this.db);
        deleteStmt.run(row.version);
      })();

      records.push(record);
    }

    return { reverted: records.length, migrations: records };
  }

  /**
   * Returns all pending migrations (in map but not applied), sorted ascending.
   */
  pending(): { version: number; name: string }[] {
    const appliedVersions = new Set(
      (this.db.prepare("SELECT version FROM _migrations").all() as Array<{ version: number }>).map(
        (r) => r.version,
      ),
    );

    return [...this.migrations.entries()]
      .filter(([version]) => !appliedVersions.has(version))
      .sort(([a], [b]) => a - b)
      .map(([version, module]) => ({ version, name: module.description }));
  }

  /**
   * Returns all applied migrations from _migrations, sorted ascending by
   * version.
   */
  applied(): MigrationRecord[] {
    const rows = this.db
      .prepare("SELECT version, name, applied_at FROM _migrations ORDER BY version ASC")
      .all() as Array<{ version: number; name: string; applied_at: string }>;
    return rows.map(rowToRecord);
  }

  /**
   * Checks that every version recorded in _migrations has a corresponding
   * migration module loaded. Versions with no module are reported as `gaps`.
   */
  validate(): ValidationResult {
    const appliedVersions = (
      this.db.prepare("SELECT version FROM _migrations").all() as Array<{ version: number }>
    ).map((r) => r.version);

    const gaps = appliedVersions.filter((v) => !this.migrations.has(v));

    return {
      valid: gaps.length === 0,
      gaps,
      missing: [],
    };
  }
}
