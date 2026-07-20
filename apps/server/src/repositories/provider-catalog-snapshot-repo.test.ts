import "reflect-metadata";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { ProviderCatalogSnapshot } from "@mcode/contracts";
import { openMemoryDatabase } from "../store/database.js";
import { ProviderCatalogSnapshotRepo } from "./provider-catalog-snapshot-repo.js";

const SNAPSHOT: ProviderCatalogSnapshot = {
  providerId: "codex",
  context: { scope: "workspace", workspaceId: "workspace-1" },
  freshness: { status: "fresh", fetchedAt: "2026-07-20T12:00:00.000Z" },
  diagnostics: [],
  entries: [{
    kind: "skill",
    identity: { providerId: "codex", kind: "skill", nativeId: "review" },
    name: "review",
    description: "Review changes",
    source: "user",
  }],
  selectableAgents: [],
};

describe("ProviderCatalogSnapshotRepo", () => {
  let db: Database.Database | undefined;

  afterEach(() => db?.close());

  it("persists snapshots by provider and realized catalog context", () => {
    db = openMemoryDatabase();
    const firstProcess = new ProviderCatalogSnapshotRepo(db);
    firstProcess.upsert("codex:workspace:workspace-1:C:/repo", "workspace-1", "C:/repo", SNAPSHOT);

    const restartedProcess = new ProviderCatalogSnapshotRepo(db);

    expect(restartedProcess.get("codex:workspace:workspace-1:C:/repo")).toEqual(SNAPSHOT);
    expect(restartedProcess.get("codex:workspace:workspace-2:C:/other")).toBeNull();
  });

  it("rejects malformed persisted payloads without affecting other contexts", () => {
    db = openMemoryDatabase();
    const repo = new ProviderCatalogSnapshotRepo(db);
    repo.upsert("valid", "workspace-1", "C:/repo", SNAPSHOT);
    db.prepare(`
      INSERT INTO provider_catalog_snapshots
        (context_key, provider_id, workspace_id, cwd, snapshot_json)
      VALUES (?, ?, ?, ?, ?)
    `).run("invalid", "codex", "workspace-2", "C:/other", "{}");

    expect(repo.get("invalid")).toBeNull();
    expect(repo.get("valid")).toEqual(SNAPSHOT);
  });

  it("does not expire an otherwise valid snapshot because of its age", () => {
    db = openMemoryDatabase();
    const repo = new ProviderCatalogSnapshotRepo(db);
    repo.upsert("old", "workspace-1", "C:/repo", SNAPSHOT);
    db.prepare(
      "UPDATE provider_catalog_snapshots SET updated_at = ? WHERE context_key = ?",
    ).run("2000-01-01T00:00:00.000Z", "old");

    expect(repo.get("old")).toEqual(SNAPSHOT);
  });
});
