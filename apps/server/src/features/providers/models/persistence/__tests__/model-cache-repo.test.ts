import "reflect-metadata";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "../../../../../runtime/persistence/sqlite/database.js";
import { ModelCacheRepo } from "../model-cache-repo.js";

describe("ModelCacheRepo", () => {
  let db: Database.Database;
  let repo: ModelCacheRepo;

  beforeEach(() => {
    db = openMemoryDatabase();
    repo = new ModelCacheRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns null for a provider with no cached data", () => {
    const result = repo.get("cursor");
    expect(result).toBeNull();
  });

  it("stores and retrieves a model list", () => {
    const models = [
      { id: "model-a", name: "Model A" },
      { id: "model-b", name: "Model B", group: "TestGroup" },
    ];
    repo.upsert("cursor", models);

    const result = repo.get("cursor");
    expect(result).not.toBeNull();
    expect(result!.providerId).toBe("cursor");
    expect(result!.models).toEqual(models);
    expect(result!.modelCount).toBe(2);
    expect(typeof result!.fetchedAt).toBe("string");
  });

  it("overwrites existing cache on upsert", () => {
    repo.upsert("cursor", [{ id: "old", name: "Old" }]);
    repo.upsert("cursor", [{ id: "new", name: "New" }]);

    const result = repo.get("cursor");
    expect(result!.models).toEqual([{ id: "new", name: "New" }]);
    expect(result!.modelCount).toBe(1);
  });

  it("returns all cached providers", () => {
    repo.upsert("cursor", [{ id: "m1", name: "M1" }]);
    repo.upsert("copilot", [{ id: "m2", name: "M2" }]);

    const all = repo.getAll();
    expect(all).toHaveLength(2);
    const ids = all.map((r) => r.providerId).sort();
    expect(ids).toEqual(["copilot", "cursor"]);
  });

  it("deletes cache for a provider", () => {
    repo.upsert("cursor", [{ id: "m1", name: "M1" }]);
    repo.delete("cursor");
    expect(repo.get("cursor")).toBeNull();
  });
});
