import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "../database.js";

describe("database migration recovery", () => {
  let directory: string;
  let databasePath: string;
  let migrationsDirectory: string;
  const originalMigrationsDirectory = process.env.MCODE_DRIZZLE_MIGRATIONS_DIR;

  beforeEach(() => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-migration-recovery-"));
    databasePath = NodePath.join(directory, "mcode.db");
    migrationsDirectory = NodePath.join(directory, "drizzle");
    NodeFS.mkdirSync(NodePath.join(migrationsDirectory, "meta"), { recursive: true });
  });

  afterEach(() => {
    if (originalMigrationsDirectory === undefined) {
      delete process.env.MCODE_DRIZZLE_MIGRATIONS_DIR;
    } else {
      process.env.MCODE_DRIZZLE_MIGRATIONS_DIR = originalMigrationsDirectory;
    }
    NodeFS.rmSync(directory, { recursive: true, force: true });
  });

  it("restores the usable database when a migration fails", () => {
    const originalBytes = Buffer.from("usable generation");
    NodeFS.writeFileSync(databasePath, originalBytes);
    NodeFS.writeFileSync(
      NodePath.join(migrationsDirectory, "meta", "_journal.json"),
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

    expect(NodeFS.readFileSync(databasePath)).toEqual(originalBytes);
    expect(
      NodeFS.readdirSync(directory).some((name) => name.startsWith("mcode.db.bak-")),
    ).toBe(true);
  });
});
