import { createHash } from "crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, resolveElectronNativeBinding } from "../database.js";

const MIGRATIONS_THROUGH_0041 = "0041_index_completed_thread_cleanup";
const SUBAGENT_IDENTITY_MIGRATION = "0042_supreme_terrax";
const MESSAGE_OUTCOME_MIGRATION = "0043_massive_dazzler";
const AUTOMATIC_SETUP_MIGRATION = "0044_small_prodigy";

type JournalEntry = {
  idx: number;
  tag: string;
  when: number;
};

type MigrationJournal = {
  entries: JournalEntry[];
};

function readJournal(directory: string): MigrationJournal {
  return JSON.parse(
    readFileSync(join(directory, "meta", "_journal.json"), "utf8"),
  ) as MigrationJournal;
}

function migrationHash(directory: string, tag: string): string {
  return createHash("sha256")
    .update(readFileSync(join(directory, `${tag}.sql`), "utf8"))
    .digest("hex");
}

function migrationEntry(directory: string, tag: string): JournalEntry {
  const entry = readJournal(directory).entries.find(
    (candidate) => candidate.tag === tag,
  );
  if (!entry) throw new Error(`Missing migration journal entry: ${tag}`);
  return entry;
}

function copyMigrationsThrough(
  sourceDirectory: string,
  destinationDirectory: string,
  lastTag: string,
): void {
  const journal = readJournal(sourceDirectory);
  const cutoff = journal.entries.findIndex((entry) => entry.tag === lastTag);
  if (cutoff === -1) throw new Error(`Missing migration journal entry: ${lastTag}`);

  const entries = journal.entries.slice(0, cutoff + 1);
  mkdirSync(join(destinationDirectory, "meta"), { recursive: true });
  writeFileSync(
    join(destinationDirectory, "meta", "_journal.json"),
    JSON.stringify({ ...journal, entries }),
  );
  for (const entry of entries) {
    copyFileSync(
      join(sourceDirectory, `${entry.tag}.sql`),
      join(destinationDirectory, `${entry.tag}.sql`),
    );
  }
}

function columnNames(db: Database.Database, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  ).map((column) => column.name);
}

function migrationsFolderForDrizzle(directory: string): string {
  return resolve(directory).replace(/\\/g, "/");
}

describe("successful database migration recovery", () => {
  let directory: string;
  let databasePath: string;
  const originalMigrationsDirectory = process.env.MCODE_DRIZZLE_MIGRATIONS_DIR;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "mcode-migration-success-"));
    databasePath = join(directory, "mcode.db");
    process.env.MCODE_DRIZZLE_MIGRATIONS_DIR = join(process.cwd(), "drizzle");
  });

  afterEach(() => {
    if (originalMigrationsDirectory === undefined) {
      delete process.env.MCODE_DRIZZLE_MIGRATIONS_DIR;
    } else {
      process.env.MCODE_DRIZZLE_MIGRATIONS_DIR = originalMigrationsDirectory;
    }
    rmSync(directory, { recursive: true, force: true });
  });

  it("keeps five generations and preserves public text identifiers", () => {
    const originalDatabase = new Database(databasePath, {
      nativeBinding: resolveElectronNativeBinding(),
    });
    originalDatabase.exec("CREATE TABLE records (id TEXT PRIMARY KEY)");
    originalDatabase
      .prepare("INSERT INTO records (id) VALUES (?)")
      .run("thread-public-id");
    originalDatabase.close();

    for (let generation = 0; generation < 7; generation++) {
      const upgradedDatabase = openDatabase({ dbPath: databasePath });
      expect(upgradedDatabase.prepare("SELECT id FROM records").get()).toEqual({
        id: "thread-public-id",
      });
      upgradedDatabase.close();
    }

    const generations = readdirSync(directory).filter(
      (name) => name.startsWith("mcode.db.bak-") && !name.endsWith("-wal"),
    );
    expect(generations).toHaveLength(5);
  });

  it("creates the complete automatic Setup lifecycle in one migration", () => {
    const database = openDatabase({ dbPath: databasePath });
    try {
      expect(readJournal(join(process.cwd(), "drizzle")).entries.filter(
        (entry) => entry.tag.startsWith("0044_"),
      )).toEqual([migrationEntry(join(process.cwd(), "drizzle"), AUTOMATIC_SETUP_MIGRATION)]);
      expect(columnNames(database, "workspace_environment_automatic_setup_attempts")).toEqual(expect.arrayContaining([
        "launch_snapshot_json",
        "outcome",
        "exit_code",
        "output",
        "output_truncated",
      ]));
      expect(columnNames(database, "workspace_environment_queued_turns")).toContain("dispatched_at");
      expect(database.prepare("SELECT created_at FROM __drizzle_migrations WHERE hash = ?").all(
        migrationHash(join(process.cwd(), "drizzle"), AUTOMATIC_SETUP_MIGRATION),
      )).toEqual([{
        created_at: migrationEntry(join(process.cwd(), "drizzle"), AUTOMATIC_SETUP_MIGRATION).when,
      }]);
    } finally {
      database.close();
    }
  });

  it("upgrades a 0041 database that the legacy fallback already patched", () => {
    const currentMigrationsDirectory = join(process.cwd(), "drizzle");
    const previousMigrationsDirectory = join(directory, "drizzle-through-0041");
    copyMigrationsThrough(
      currentMigrationsDirectory,
      previousMigrationsDirectory,
      MIGRATIONS_THROUGH_0041,
    );

    process.env.MCODE_DRIZZLE_MIGRATIONS_DIR = previousMigrationsDirectory;
    const previousDatabase = openDatabase({ dbPath: databasePath });
    try {
      expect(columnNames(previousDatabase, "tool_call_records")).toContain(
        "subagent_identity_key",
      );
      expect(previousDatabase.prepare(
        "SELECT MAX(created_at) AS created_at FROM __drizzle_migrations",
      ).get()).toEqual({
        created_at: migrationEntry(previousMigrationsDirectory, MIGRATIONS_THROUGH_0041).when,
      });
    } finally {
      previousDatabase.close();
    }

    const stagedDatabase = openDatabase({ dbPath: databasePath });
    stagedDatabase.close();

    process.env.MCODE_DRIZZLE_MIGRATIONS_DIR = currentMigrationsDirectory;
    const upgradedDatabase = openDatabase({ dbPath: databasePath });
    try {
      const identityMigration = migrationEntry(
        currentMigrationsDirectory,
        SUBAGENT_IDENTITY_MIGRATION,
      );
      const identityMigrationRows = upgradedDatabase
        .prepare("SELECT created_at FROM __drizzle_migrations WHERE hash = ?")
        .all(migrationHash(currentMigrationsDirectory, SUBAGENT_IDENTITY_MIGRATION));
      expect(identityMigrationRows).toEqual([{ created_at: identityMigration.when }]);
      expect(columnNames(upgradedDatabase, "messages")).toEqual(
        expect.arrayContaining(["outcome", "outcome_execution_id"]),
      );
      const outcomeMigrationRows = upgradedDatabase
        .prepare("SELECT created_at FROM __drizzle_migrations WHERE hash = ?")
        .all(migrationHash(currentMigrationsDirectory, MESSAGE_OUTCOME_MIGRATION));
      expect(outcomeMigrationRows).toEqual([{
        created_at: migrationEntry(currentMigrationsDirectory, MESSAGE_OUTCOME_MIGRATION).when,
      }]);
    } finally {
      upgradedDatabase.close();
    }
  });

  it("upgrades an unpatched 0041 database", () => {
    const currentMigrationsDirectory = join(process.cwd(), "drizzle");
    const previousMigrationsDirectory = join(directory, "drizzle-through-0041");
    copyMigrationsThrough(
      currentMigrationsDirectory,
      previousMigrationsDirectory,
      MIGRATIONS_THROUGH_0041,
    );

    const previousDatabase = new Database(databasePath, {
      nativeBinding: resolveElectronNativeBinding(),
    });
    try {
      migrate(drizzle(previousDatabase), {
        migrationsFolder: migrationsFolderForDrizzle(previousMigrationsDirectory),
      });
      expect(columnNames(previousDatabase, "tool_call_records")).not.toContain(
        "subagent_identity_key",
      );
      expect(previousDatabase.prepare(
        "SELECT MAX(created_at) AS created_at FROM __drizzle_migrations",
      ).get()).toEqual({
        created_at: migrationEntry(previousMigrationsDirectory, MIGRATIONS_THROUGH_0041).when,
      });
    } finally {
      previousDatabase.close();
    }

    const upgradedDatabase = openDatabase({ dbPath: databasePath });
    try {
      const identityMigration = migrationEntry(
        currentMigrationsDirectory,
        SUBAGENT_IDENTITY_MIGRATION,
      );
      const identityMigrationRows = upgradedDatabase
        .prepare("SELECT created_at FROM __drizzle_migrations WHERE hash = ?")
        .all(migrationHash(currentMigrationsDirectory, SUBAGENT_IDENTITY_MIGRATION));
      expect(identityMigrationRows).toEqual([{ created_at: identityMigration.when }]);
      expect(columnNames(upgradedDatabase, "tool_call_records")).toContain(
        "subagent_identity_key",
      );
      expect(columnNames(upgradedDatabase, "messages")).toEqual(
        expect.arrayContaining(["outcome", "outcome_execution_id"]),
      );
      const outcomeMigrationRows = upgradedDatabase
        .prepare("SELECT created_at FROM __drizzle_migrations WHERE hash = ?")
        .all(migrationHash(currentMigrationsDirectory, MESSAGE_OUTCOME_MIGRATION));
      expect(outcomeMigrationRows).toEqual([{
        created_at: migrationEntry(currentMigrationsDirectory, MESSAGE_OUTCOME_MIGRATION).when,
      }]);
    } finally {
      upgradedDatabase.close();
    }
  });
});
