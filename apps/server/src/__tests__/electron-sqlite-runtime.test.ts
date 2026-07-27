import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "../store/database";
import { openElectronMemoryDatabase } from "./electron-sqlite.js";

describe("Electron SQLite test runtime", () => {
  let db: Database.Database | undefined;
  const binding = process.env.BETTER_SQLITE3_BINDING;

  afterEach(() => {
    db?.close();
    db = undefined;
    if (binding === undefined) delete process.env.BETTER_SQLITE3_BINDING;
    else process.env.BETTER_SQLITE3_BINDING = binding;
  });

  it("runs in Electron Node and opens an in-memory database", () => {
    expect(process.versions.electron).toBeDefined();

    db = openMemoryDatabase();

    expect(db.prepare("SELECT 1 AS value").get()).toEqual({ value: 1 });
  });

  it("opens direct test databases with the Electron binding", () => {
    db = openElectronMemoryDatabase();

    expect(db.prepare("SELECT 1 AS value").get()).toEqual({ value: 1 });
  });

  it("rejects a missing native binding before loading SQLite", () => {
    delete process.env.BETTER_SQLITE3_BINDING;

    expect(() => openMemoryDatabase()).toThrow("BETTER_SQLITE3_BINDING must be");
  });

  it("rejects a Node-native binding path before loading SQLite", () => {
    process.env.BETTER_SQLITE3_BINDING = binding?.replace(
      "better_sqlite3.electron.node",
      "better_sqlite3.node",
    );

    expect(() => openMemoryDatabase()).toThrow("workspace Electron binding");
  });

  it("rejects an unexpected native binding path before loading SQLite", () => {
    process.env.BETTER_SQLITE3_BINDING = "C:/unexpected/better_sqlite3.electron.node";

    expect(() => openMemoryDatabase()).toThrow("workspace Electron binding");
  });
});
