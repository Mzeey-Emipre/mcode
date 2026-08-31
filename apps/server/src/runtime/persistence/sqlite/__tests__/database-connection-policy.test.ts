import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDatabase } from "../database.js";

describe("SQLite connection policy", () => {
  let database: Database.Database | undefined;
  let directory: string;
  const originalMigrationsDirectory = process.env.MCODE_DRIZZLE_MIGRATIONS_DIR;

  beforeEach(() => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-connection-policy-"));
    process.env.MCODE_DRIZZLE_MIGRATIONS_DIR = NodePath.join(process.cwd(), "drizzle");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    database?.close();
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
      journalMode: database.pragma("journal_mode", { simple: true }),
      synchronous: database.pragma("synchronous", { simple: true }),
      foreignKeys: database.pragma("foreign_keys", { simple: true }),
      busyTimeout: database.pragma("busy_timeout", { simple: true }),
      cacheSize: database.pragma("cache_size", { simple: true }),
      mmapSize: database.pragma("mmap_size", { simple: true }),
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
    const pragma = vi.spyOn(Database.prototype, "pragma");

    database = openDatabase({ dbPath: NodePath.join(directory, "mcode.db") });

    expect(pragma).toHaveBeenCalledWith("optimize = 0x10002");
    expect(pragma).toHaveBeenCalledWith("optimize");
    expect(pragma.mock.calls.some(([source]) => /^\s*(?:ANALYZE|VACUUM)\b/i.test(source)))
      .toBe(false);
  });

  it("does not repeat schema-change optimization when the schema is current", () => {
    const databasePath = NodePath.join(directory, "mcode.db");
    database = openDatabase({ dbPath: databasePath });
    database.close();
    database = undefined;
    const pragma = vi.spyOn(Database.prototype, "pragma");

    database = openDatabase({ dbPath: databasePath });

    expect(pragma).toHaveBeenCalledWith("optimize = 0x10002");
    expect(pragma).not.toHaveBeenCalledWith("optimize");
  });
});
