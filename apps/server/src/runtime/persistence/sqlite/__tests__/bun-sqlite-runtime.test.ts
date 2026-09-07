import { afterEach, describe, expect, it } from "vitest";
import type { Database } from "bun:sqlite";

import { openMemoryDatabase } from "../database.js";

describe("Bun SQLite test runtime", () => {
  let db: Database | undefined;

  afterEach(() => {
    db?.close(true);
    db = undefined;
  });

  it("opens the application database through Bun and rejects an unbound named parameter", () => {
    expect(process.versions.bun).toBeDefined();

    db = openMemoryDatabase();
    db.exec("CREATE TABLE runtime_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");

    expect(() => db!.prepare("INSERT INTO runtime_probe (value) VALUES ($value)").run({}))
      .toThrow(Error);
    db.prepare("INSERT INTO runtime_probe (value) VALUES ($value)").run({ value: "stored" });
    expect(db.query("SELECT value FROM runtime_probe").get()).toEqual({ value: "stored" });
  });
});
