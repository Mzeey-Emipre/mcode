import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "../database.js";

describe("database migration recovery", () => {
  let directory: string;
  let databasePath: string;
  let migrationsDirectory: string;
  const originalMigrationsDirectory = process.env.MCODE_DRIZZLE_MIGRATIONS_DIR;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "mcode-migration-recovery-"));
    databasePath = join(directory, "mcode.db");
    migrationsDirectory = join(directory, "drizzle");
    mkdirSync(join(migrationsDirectory, "meta"), { recursive: true });
  });

  afterEach(() => {
    if (originalMigrationsDirectory === undefined) {
      delete process.env.MCODE_DRIZZLE_MIGRATIONS_DIR;
    } else {
      process.env.MCODE_DRIZZLE_MIGRATIONS_DIR = originalMigrationsDirectory;
    }
    rmSync(directory, { recursive: true, force: true });
  });

  it("restores the usable database when a migration fails", () => {
    const originalBytes = Buffer.from("usable generation");
    writeFileSync(databasePath, originalBytes);
    writeFileSync(
      join(migrationsDirectory, "meta", "_journal.json"),
      JSON.stringify({
        version: "7",
        dialect: "sqlite",
        entries: [
          {
            idx: 0,
            version: "6",
            when: 1,
            tag: "0000_missing",
            breakpoints: true,
          },
        ],
      }),
    );
    process.env.MCODE_DRIZZLE_MIGRATIONS_DIR = migrationsDirectory;

    expect(() => openDatabase({ dbPath: databasePath })).toThrow();

    expect(readFileSync(databasePath)).toEqual(originalBytes);
    expect(
      readdirSync(directory).some((name) => name.startsWith("mcode.db.bak-")),
    ).toBe(true);
  });
});
