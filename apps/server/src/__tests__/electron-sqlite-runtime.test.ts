import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "../store/database";

describe("Electron SQLite test runtime", () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
  });

  it("runs in Electron Node and opens an in-memory database", () => {
    expect(process.versions.electron).toBeDefined();

    db = openMemoryDatabase();

    expect(db.prepare("SELECT 1 AS value").get()).toEqual({ value: 1 });
  });
});
