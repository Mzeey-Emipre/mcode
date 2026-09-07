import { afterEach, describe, expect, it } from "vitest";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { PtyHostCleanupLedger } from "../terminal-cleanup-ledger.js";

const SESSION_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SESSION_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

async function openLedgerTestDatabase(): Promise<Database> {
  if (!process.versions.electron) {
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(":memory:");
    database.exec(`
      CREATE TABLE terminal_cleanup_ledger (
        session_id TEXT PRIMARY KEY NOT NULL,
        host_generation TEXT NOT NULL,
        root_pid INTEGER NOT NULL,
        process_group_id TEXT NOT NULL,
        containment TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    return {
      prepare: (sql: string) => database.prepare(sql),
      transaction: <Result>(action: () => Result) => () => {
        database.exec("BEGIN");
        try {
          const result = action();
          database.exec("COMMIT");
          return result;
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      },
      close: () => database.close(),
    } as unknown as Database;
  }
  return openMemoryDatabase();
}

describe("PtyHostCleanupLedger", () => {
  let db: Database | null = null;

  afterEach(() => {
    db?.close();
    db = null;
  });

  it("persists bounded process identity until the matching generation removes it", async () => {
    db = await openLedgerTestDatabase();
    const ledger = new PtyHostCleanupLedger(db, 2);
    ledger.record({
      sessionId: SESSION_A,
      hostGeneration: "1",
      rootPid: 101,
      processGroupId: "job-101",
      containment: "job-object",
    });

    const reopened = new PtyHostCleanupLedger(db, 2);
    expect(reopened.forGeneration("1")).toEqual([
      expect.objectContaining({
        sessionId: SESSION_A,
        hostGeneration: "1",
        rootPid: 101,
        processGroupId: "job-101",
        containment: "job-object",
      }),
    ]);
    expect(reopened.remove(SESSION_A, "2")).toBe(false);
    expect(reopened.remove(SESSION_A, "1")).toBe(true);
    expect(reopened.list()).toEqual([]);
  });

  it("rejects stale session generations and records above the configured bound", async () => {
    db = await openLedgerTestDatabase();
    const ledger = new PtyHostCleanupLedger(db, 2);
    ledger.record({
      sessionId: SESSION_A,
      hostGeneration: "1",
      rootPid: 101,
      processGroupId: "101",
      containment: "process-group",
    });

    expect(() =>
      ledger.record({
        sessionId: SESSION_A,
        hostGeneration: "2",
        rootPid: 201,
        processGroupId: "201",
        containment: "process-group",
      }),
    ).toThrow(/generation/i);
    expect(() =>
      ledger.record({
        sessionId: SESSION_A,
        hostGeneration: "1",
        rootPid: 201,
        processGroupId: "201",
        containment: "process-group",
      }),
    ).toThrow(/process identity/i);

    ledger.record({
      sessionId: SESSION_B,
      hostGeneration: "1",
      rootPid: 102,
      processGroupId: "102",
      containment: "process-group",
    });
    expect(() =>
      ledger.record({
        sessionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        hostGeneration: "1",
        rootPid: 103,
        processGroupId: "103",
        containment: "process-group",
      }),
    ).toThrow(/limit/i);
  });
});
