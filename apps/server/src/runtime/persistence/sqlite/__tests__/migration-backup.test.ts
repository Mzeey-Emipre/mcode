import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createMigrationBackup,
  pruneMigrationBackups,
  restoreMigrationBackupAfterFailure,
  restoreMigrationBackup,
} from "../migration-backup.js";
import { resolveElectronNativeBinding } from "../database.js";

describe("migration-backup", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mcode-backup-test-"));
    dbPath = join(dir, "mcode.db");
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null for an in-memory DB and creates no files", () => {
    const result = createMigrationBackup(":memory:");
    expect(result).toBeNull();
  });

  it("returns null when the DB file does not exist (first-run install)", () => {
    const result = createMigrationBackup(dbPath);
    expect(result).toBeNull();
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it("rejects a migration before backup creation when five generations cannot fit", () => {
    writeFileSync(dbPath, "1234567890");

    expect(() =>
      createMigrationBackup(dbPath, {
        availableBytes: 49n,
        retainedGenerations: 5,
      }),
    ).toThrow(/requires 50 bytes.*49 bytes available/);

    expect(readdirSync(dir)).toEqual(["mcode.db"]);
  });

  it("requires space for only one new copy when five generations exist", () => {
    writeFileSync(dbPath, "1234567890");
    for (let generation = 1; generation <= 5; generation++) {
      writeFileSync(
        join(dir, `mcode.db.bak-${generation}`),
        `generation ${generation}`,
      );
    }

    const backupPath = createMigrationBackup(dbPath, {
      availableBytes: 10n,
      retainedGenerations: 5,
    });

    expect(backupPath).not.toBeNull();
  });

  it("copies the DB file and a present WAL sidecar", () => {
    writeFileSync(dbPath, "DBCONTENT");
    writeFileSync(`${dbPath}-wal`, "WALCONTENT");

    const backupPath = createMigrationBackup(dbPath);
    expect(backupPath).not.toBeNull();
    expect(readFileSync(backupPath!, "utf-8")).toBe("DBCONTENT");
    expect(readFileSync(`${backupPath}-wal`, "utf-8")).toBe("WALCONTENT");
  });

  it("restores DB content and WAL while clearing stale sidecars", () => {
    writeFileSync(dbPath, "ORIGINAL");
    writeFileSync(`${dbPath}-wal`, "ORIG_WAL");
    const backupPath = createMigrationBackup(dbPath)!;

    // Simulate a failed migration: main file mutated, sidecars dirty.
    writeFileSync(dbPath, "PARTIALLY_MUTATED");
    writeFileSync(`${dbPath}-wal`, "STALE_WAL");
    writeFileSync(`${dbPath}-shm`, "STALE_SHM");

    restoreMigrationBackup(backupPath, dbPath);

    expect(readFileSync(dbPath, "utf-8")).toBe("ORIGINAL");
    expect(readFileSync(`${dbPath}-wal`, "utf-8")).toBe("ORIG_WAL");
    // SHM is regenerable; restore must not leave a stale one in place.
    expect(readdirSync(dir).filter((f) => f.endsWith("-shm"))).toEqual([]);
  });

  it("creates distinct generations when backups share a timestamp", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-09T12:00:00.000Z"));
    writeFileSync(dbPath, "generation one");
    const firstBackup = createMigrationBackup(dbPath)!;

    writeFileSync(dbPath, "generation two");
    const secondBackup = createMigrationBackup(dbPath)!;

    expect(secondBackup).not.toBe(firstBackup);
    expect(readFileSync(firstBackup, "utf-8")).toBe("generation one");
    expect(readFileSync(secondBackup, "utf-8")).toBe("generation two");
  });

  it("restores public text identifiers after a migration failure", () => {
    const originalError = new Error("forced migration failure");
    let database = new Database(dbPath, {
      nativeBinding: resolveElectronNativeBinding(),
    });
    database.exec("CREATE TABLE records (id TEXT PRIMARY KEY)");
    database.prepare("INSERT INTO records (id) VALUES (?)").run("thread-public-id");
    database.close();

    const backupPath = createMigrationBackup(dbPath)!;
    database = new Database(dbPath, {
      nativeBinding: resolveElectronNativeBinding(),
    });
    database.prepare("UPDATE records SET id = ?").run("mutated-id");
    database.close();

    expect(() =>
      restoreMigrationBackupAfterFailure(backupPath, dbPath, originalError),
    ).toThrow(originalError);

    database = new Database(dbPath, {
      nativeBinding: resolveElectronNativeBinding(),
    });
    expect(database.prepare("SELECT id FROM records").get()).toEqual({
      id: "thread-public-id",
    });
    database.close();
  });

  it("reports both the migration and restore failures", () => {
    writeFileSync(dbPath, "usable database");
    const backupPath = createMigrationBackup(dbPath)!;
    const migrationError = new Error("forced migration failure");
    rmSync(backupPath);

    let reportedError: unknown;
    try {
      restoreMigrationBackupAfterFailure(backupPath, dbPath, migrationError);
    } catch (error) {
      reportedError = error;
    }

    expect(reportedError).toBeInstanceOf(AggregateError);
    expect(reportedError).toMatchObject({
      message: "Database migration failed and automatic restore failed.",
      errors: [migrationError, expect.any(Error)],
    });
  });

  it("retains exactly five recent backup generations with their WALs", () => {
    writeFileSync(dbPath, "DB");

    // Author 5 backup pairs with explicit filenames AND explicit, ordered
    // mtimes so the test is robust to filesystem timestamp resolution and
    // does not rely on millisecond-uniqueness inside `createMigrationBackup`.
    const baseTime = Math.floor(Date.now() / 1000);
    const backupNames = [
      "mcode.db.bak-1",
      "mcode.db.bak-2",
      "mcode.db.bak-3",
      "mcode.db.bak-4",
      "mcode.db.bak-5",
      "mcode.db.bak-6",
      "mcode.db.bak-7",
    ];
    backupNames.forEach((name, i) => {
      const path = join(dir, name);
      writeFileSync(path, `db-${i}`);
      writeFileSync(`${path}-wal`, `wal-${i}`);
      const t = baseTime + i;
      utimesSync(path, t, t);
      utimesSync(`${path}-wal`, t, t);
    });

    pruneMigrationBackups(dbPath);

    const remaining = readdirSync(dir)
      .filter((f) => f.startsWith("mcode.db.bak-") && !f.endsWith("-wal"))
      .sort();
    expect(remaining).toEqual([
      "mcode.db.bak-3",
      "mcode.db.bak-4",
      "mcode.db.bak-5",
      "mcode.db.bak-6",
      "mcode.db.bak-7",
    ]);

    const dirContents = readdirSync(dir);
    expect(dirContents).not.toContain("mcode.db.bak-1");
    expect(dirContents).not.toContain("mcode.db.bak-1-wal");
    expect(dirContents).not.toContain("mcode.db.bak-2");
    expect(dirContents).not.toContain("mcode.db.bak-2-wal");
    expect(dirContents).toContain("mcode.db.bak-7-wal");
  });

  it("does nothing when keep is larger than the number of backups", () => {
    writeFileSync(dbPath, "DB");
    createMigrationBackup(dbPath);

    pruneMigrationBackups(dbPath, 10);

    const remaining = readdirSync(dir).filter((f) => f.startsWith("mcode.db.bak-"));
    expect(remaining).toHaveLength(1);
  });

  it("rejects negative keep values", () => {
    expect(() => pruneMigrationBackups(dbPath, -1)).toThrow();
  });
});
