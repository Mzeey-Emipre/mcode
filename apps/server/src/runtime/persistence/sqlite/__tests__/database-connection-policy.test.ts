import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDatabase } from "../database.js";

describe("SQLite connection policy", () => {
  let database: Database | undefined;
  let directory: string;
  const originalMigrationsDirectory = process.env.MCODE_DRIZZLE_MIGRATIONS_DIR;

  beforeEach(() => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-connection-policy-"));
    process.env.MCODE_DRIZZLE_MIGRATIONS_DIR = NodePath.join(process.cwd(), "drizzle");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    database?.close(true);
    database = undefined;
    if (originalMigrationsDirectory === undefined) {
      delete process.env.MCODE_DRIZZLE_MIGRATIONS_DIR;
    } else {
      process.env.MCODE_DRIZZLE_MIGRATIONS_DIR = originalMigrationsDirectory;
    }
    NodeFS.rmSync(directory, { recursive: true, force: true });
  });

  it("opens a file-backed database with the durable active policy", () => {
    database = openDatabase({ dbPath: NodePath.join(directory, "mcode.db") });

    expect({
      journalMode: pragmaValue(database, "journal_mode"),
      synchronous: pragmaValue(database, "synchronous"),
      foreignKeys: pragmaValue(database, "foreign_keys"),
      busyTimeout: pragmaValue(database, "busy_timeout"),
      cacheSize: pragmaValue(database, "cache_size"),
      mmapSize: pragmaValue(database, "mmap_size"),
    }).toEqual({
      journalMode: "wal",
      synchronous: 2,
      foreignKeys: 1,
      busyTimeout: 5_000,
      cacheSize: -2_048,
      mmapSize: 0,
    });
  });

  it("runs bounded optimization when the database opens and its schema changes", () => {
    const run = vi.spyOn(Database.prototype, "run");

    database = openDatabase({ dbPath: NodePath.join(directory, "mcode.db") });

    expect(run).toHaveBeenCalledWith("PRAGMA optimize = 0x10002");
    expect(run).toHaveBeenCalledWith("PRAGMA optimize");
    expect(run.mock.calls.some(([source]) => /^\s*(?:ANALYZE|VACUUM)\b/i.test(String(source))))
      .toBe(false);
  });

  it("does not repeat schema-change optimization when the schema is current", () => {
    const databasePath = NodePath.join(directory, "mcode.db");
    database = openDatabase({ dbPath: databasePath });
    database.close(true);
    database = undefined;
    const run = vi.spyOn(Database.prototype, "run");

    database = openDatabase({ dbPath: databasePath });

    expect(run).toHaveBeenCalledWith("PRAGMA optimize = 0x10002");
    expect(run).not.toHaveBeenCalledWith("PRAGMA optimize");
  });
});

function pragmaValue(database: Database, name: string): unknown {
  const row = database.query(`PRAGMA ${name}`).get() as Record<string, unknown>;
  return row[name === "busy_timeout" ? "timeout" : name];
}
