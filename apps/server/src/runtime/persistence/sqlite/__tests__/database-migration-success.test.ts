import { mkdtempSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, resolveElectronNativeBinding } from "../database.js";

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
});
