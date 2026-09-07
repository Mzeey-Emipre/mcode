import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { Database } from "bun:sqlite";
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

  it("restores a usable WAL database and clears failed-migration sidecars", () => {
    const seed = new Database(databasePath, { strict: true });
    seed.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE records (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      INSERT INTO records (id, body) VALUES ('thread-public-id', 'preserved body');
    `);
    seed.close();
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
            tag: "0000_broken",
            breakpoints: true,
          },
        ],
      }),
    );
    NodeFS.writeFileSync(
      NodePath.join(migrationsDirectory, "0000_broken.sql"),
      "CREATE TABLE partially_migrated (id INTEGER);\n--> statement-breakpoint\nSELECT FROM;",
    );
    process.env.MCODE_DRIZZLE_MIGRATIONS_DIR = migrationsDirectory;

    expect(() => openDatabase({ dbPath: databasePath })).toThrow();
    expect(NodeFS.existsSync(`${databasePath}-shm`)).toBe(false);

    const restored = new Database(databasePath, { readonly: true, strict: true });
    expect(restored.query("SELECT id, body FROM records").get()).toEqual({
      id: "thread-public-id",
      body: "preserved body",
    });
    expect(restored.query("SELECT name FROM sqlite_master WHERE name = 'partially_migrated'").get()).toBeNull();
    restored.close(true);
    expect(
      NodeFS.readdirSync(directory).some((name) => name.startsWith("mcode.db.bak-")),
    ).toBe(true);
  });
});
