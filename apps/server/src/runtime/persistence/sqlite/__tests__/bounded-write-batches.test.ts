import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runBoundedWriteBatches } from "../bounded-write-batches.js";
import { openMemoryDatabase, resolveElectronNativeBinding } from "../database.js";

describe("runBoundedWriteBatches", () => {
  it("commits bounded batches and yields only after each transaction closes", async () => {
    const db = openMemoryDatabase();
    db.exec("CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    const insert = db.prepare("INSERT OR IGNORE INTO records (id, value) VALUES (?, ?)");
    const clock = [0, 0, 1, 2, 10, 10, 11, 12, 20, 20, 21, 22];
    const yieldControl = vi.fn(async () => {
      expect(db.inTransaction).toBe(false);
    });

    const result = await runBoundedWriteBatches({
      db,
      items: [
        { id: 1, value: "aa" },
        { id: 2, value: "bb" },
        { id: 3, value: "cccc" },
        { id: 4, value: "dd" },
      ],
      limits: { maxRows: 2, maxBytes: 4, maxElapsedMs: 5 },
      byteLength: (item) => Buffer.byteLength(item.value),
      write: (item) => insert.run(item.id, item.value),
      now: () => clock.shift() ?? 22,
      yieldControl,
    });

    expect(result).toEqual({ batches: 3, rows: 4, bytes: 10 });
    expect(yieldControl).toHaveBeenCalledTimes(2);
    expect(db.prepare("SELECT id, value FROM records ORDER BY id").all()).toEqual([
      { id: 1, value: "aa" },
      { id: 2, value: "bb" },
      { id: 3, value: "cccc" },
      { id: 4, value: "dd" },
    ]);
  });

  it("resumes from a partial idempotent write without duplicates or gaps", async () => {
    const db = openMemoryDatabase();
    db.exec("CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    const insert = db.prepare("INSERT OR IGNORE INTO records (id, value) VALUES (?, ?)");
    const items = [1, 2, 3, 4].map((id) => ({ id, value: `value-${id}` }));
    let writes = 0;

    await expect(runBoundedWriteBatches({
      db,
      items,
      limits: { maxRows: 2, maxBytes: 100, maxElapsedMs: 100 },
      byteLength: (item) => Buffer.byteLength(item.value),
      write: (item) => {
        writes += 1;
        if (writes === 3) throw new Error("interrupted");
        insert.run(item.id, item.value);
      },
    })).rejects.toThrow("interrupted");

    expect(db.prepare("SELECT id FROM records ORDER BY id").all()).toEqual([
      { id: 1 },
      { id: 2 },
    ]);

    await runBoundedWriteBatches({
      db,
      items,
      limits: { maxRows: 2, maxBytes: 100, maxElapsedMs: 100 },
      byteLength: (item) => Buffer.byteLength(item.value),
      write: (item) => insert.run(item.id, item.value),
    });

    expect(db.prepare("SELECT id FROM records ORDER BY id").all()).toEqual([
      { id: 1 },
      { id: 2 },
      { id: 3 },
      { id: 4 },
    ]);
  });

  it("rejects one row that exceeds the byte limit before a transaction opens", async () => {
    const db = openMemoryDatabase();

    await expect(runBoundedWriteBatches({
      db,
      items: ["oversized"],
      limits: { maxRows: 1, maxBytes: 4, maxElapsedMs: 5 },
      byteLength: (item) => Buffer.byteLength(item),
      write: vi.fn(),
    })).rejects.toThrow("exceeds the 4-byte batch limit");

    expect(db.inTransaction).toBe(false);
  });

  it("counts physical row cost and fixed transaction overhead", async () => {
    const db = openMemoryDatabase();
    const committedRows: number[] = [];

    const result = await runBoundedWriteBatches({
      db,
      items: [2, 2, 2],
      limits: { maxRows: 5, maxBytes: 100, maxElapsedMs: 100 },
      rowCount: (rows) => rows,
      batchOverheadRows: 1,
      batchOverheadBytes: 1,
      byteLength: () => 1,
      write: vi.fn(),
      onBatchCommitted: (batch) => committedRows.push(batch.rows),
    });

    expect(result).toEqual({ batches: 2, rows: 8, bytes: 5 });
    expect(committedRows).toEqual([5, 3]);
  });

  it("rolls back the active batch when the lock timeout expires", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mcode-write-lock-"));
    const databasePath = join(directory, "locked.sqlite");
    const nativeBinding = resolveElectronNativeBinding();
    const lockOwner = new Database(databasePath, { nativeBinding });
    const writer = new Database(databasePath, { nativeBinding });

    try {
      lockOwner.exec("CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
      writer.pragma("busy_timeout = 10");
      const insert = writer.prepare("INSERT INTO records (id, value) VALUES (?, ?)");
      lockOwner.exec("BEGIN EXCLUSIVE");

      await expect(runBoundedWriteBatches({
        db: writer,
        items: [{ id: 1, value: "blocked" }],
        limits: { maxRows: 1, maxBytes: 100, maxElapsedMs: 100 },
        byteLength: (item) => Buffer.byteLength(item.value),
        write: (item) => insert.run(item.id, item.value),
      })).rejects.toMatchObject({ code: "SQLITE_BUSY" });

      expect(writer.inTransaction).toBe(false);
      lockOwner.exec("ROLLBACK");
      expect(writer.prepare("SELECT id FROM records").all()).toEqual([]);
    } finally {
      if (lockOwner.inTransaction) lockOwner.exec("ROLLBACK");
      writer.close();
      lockOwner.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rolls back the active batch when SQLite reports a full disk", async () => {
    const db = new Database(":memory:", { nativeBinding: resolveElectronNativeBinding() });

    try {
      db.pragma("page_size = 512");
      db.exec("CREATE TABLE records (id INTEGER PRIMARY KEY, value BLOB NOT NULL)");
      const pageCount = db.pragma("page_count", { simple: true }) as number;
      db.pragma(`max_page_count = ${pageCount}`);
      const insert = db.prepare("INSERT INTO records (id, value) VALUES (?, zeroblob(?))");

      await expect(runBoundedWriteBatches({
        db,
        items: [{ id: 1, bytes: 4_096 }],
        limits: { maxRows: 1, maxBytes: 8_192, maxElapsedMs: 100 },
        byteLength: (item) => item.bytes,
        write: (item) => insert.run(item.id, item.bytes),
      })).rejects.toMatchObject({ code: "SQLITE_FULL" });

      expect(db.inTransaction).toBe(false);
      expect(db.prepare("SELECT id FROM records").all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
