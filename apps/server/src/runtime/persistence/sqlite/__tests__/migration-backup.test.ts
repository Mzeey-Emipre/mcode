import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
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
    dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-backup-test-"));
    dbPath = NodePath.join(dir, "mcode.db");
  });

  afterEach(() => {
    vi.useRealTimers();
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });

  it("returns null for an in-memory DB and creates no files", () => {
    const result = createMigrationBackup(":memory:");
    expect(result).toBeNull();
  });

  it("returns null when the DB file does not exist (first-run install)", () => {
    const result = createMigrationBackup(dbPath);
    expect(result).toBeNull();
    expect(NodeFS.readdirSync(dir)).toHaveLength(0);
  });

  it("rejects a migration before backup creation when five generations cannot fit", () => {
    NodeFS.writeFileSync(dbPath, "1234567890");

    expect(() =>
      createMigrationBackup(dbPath, {
        availableBytes: 49n,
        retainedGenerations: 5,
      }),
    ).toThrow(/requires 50 bytes.*49 bytes available/);

    expect(NodeFS.readdirSync(dir)).toEqual(["mcode.db"]);
  });

  it("requires space for only one new copy when five generations exist", () => {
    NodeFS.writeFileSync(dbPath, "1234567890");
    for (let generation = 1; generation <= 5; generation++) {
      NodeFS.writeFileSync(
        NodePath.join(dir, `mcode.db.bak-${generation}`),
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
    NodeFS.writeFileSync(dbPath, "DBCONTENT");
    NodeFS.writeFileSync(`${dbPath}-wal`, "WALCONTENT");

    const backupPath = createMigrationBackup(dbPath);
    expect(backupPath).not.toBeNull();
    expect(NodeFS.readFileSync(backupPath!, "utf-8")).toBe("DBCONTENT");
    expect(NodeFS.readFileSync(`${backupPath}-wal`, "utf-8")).toBe("WALCONTENT");
  });

  it("restores DB content and WAL while clearing stale sidecars", () => {
    NodeFS.writeFileSync(dbPath, "ORIGINAL");
    NodeFS.writeFileSync(`${dbPath}-wal`, "ORIG_WAL");
    const backupPath = createMigrationBackup(dbPath)!;

    // Simulate a failed migration: main file mutated, sidecars dirty.
    NodeFS.writeFileSync(dbPath, "PARTIALLY_MUTATED");
    NodeFS.writeFileSync(`${dbPath}-wal`, "STALE_WAL");
    NodeFS.writeFileSync(`${dbPath}-shm`, "STALE_SHM");

    restoreMigrationBackup(backupPath, dbPath);

    expect(NodeFS.readFileSync(dbPath, "utf-8")).toBe("ORIGINAL");
    expect(NodeFS.readFileSync(`${dbPath}-wal`, "utf-8")).toBe("ORIG_WAL");
    // SHM is regenerable; restore must not leave a stale one in place.
    expect(NodeFS.readdirSync(dir).filter((f) => f.endsWith("-shm"))).toEqual([]);
  });

  it("creates distinct generations when backups share a timestamp", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-09T12:00:00.000Z"));
    NodeFS.writeFileSync(dbPath, "generation one");
    const firstBackup = createMigrationBackup(dbPath)!;

    NodeFS.writeFileSync(dbPath, "generation two");
    const secondBackup = createMigrationBackup(dbPath)!;

    expect(secondBackup).not.toBe(firstBackup);
    expect(NodeFS.readFileSync(firstBackup, "utf-8")).toBe("generation one");
    expect(NodeFS.readFileSync(secondBackup, "utf-8")).toBe("generation two");
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
    NodeFS.writeFileSync(dbPath, "usable database");
    const backupPath = createMigrationBackup(dbPath)!;
    const migrationError = new Error("forced migration failure");
    NodeFS.rmSync(backupPath);

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
    NodeFS.writeFileSync(dbPath, "DB");

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
      const path = NodePath.join(dir, name);
      NodeFS.writeFileSync(path, `db-${i}`);
      NodeFS.writeFileSync(`${path}-wal`, `wal-${i}`);
      const t = baseTime + i;
      NodeFS.utimesSync(path, t, t);
      NodeFS.utimesSync(`${path}-wal`, t, t);
    });

    pruneMigrationBackups(dbPath);

    const remaining = NodeFS.readdirSync(dir)
      .filter((f) => f.startsWith("mcode.db.bak-") && !f.endsWith("-wal"))
      .sort();
    expect(remaining).toEqual([
      "mcode.db.bak-3",
      "mcode.db.bak-4",
      "mcode.db.bak-5",
      "mcode.db.bak-6",
      "mcode.db.bak-7",
    ]);

    const dirContents = NodeFS.readdirSync(dir);
    expect(dirContents).not.toContain("mcode.db.bak-1");
    expect(dirContents).not.toContain("mcode.db.bak-1-wal");
    expect(dirContents).not.toContain("mcode.db.bak-2");
    expect(dirContents).not.toContain("mcode.db.bak-2-wal");
    expect(dirContents).toContain("mcode.db.bak-7-wal");
  });

  it("does nothing when keep is larger than the number of backups", () => {
    NodeFS.writeFileSync(dbPath, "DB");
    createMigrationBackup(dbPath);

    pruneMigrationBackups(dbPath, 10);

    const remaining = NodeFS.readdirSync(dir).filter((f) => f.startsWith("mcode.db.bak-"));
    expect(remaining).toHaveLength(1);
  });

  it("rejects negative keep values", () => {
    expect(() => pruneMigrationBackups(dbPath, -1)).toThrow();
  });
});
