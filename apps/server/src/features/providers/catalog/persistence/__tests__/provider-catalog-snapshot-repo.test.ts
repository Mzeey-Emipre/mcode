import "reflect-metadata";
import { afterEach, describe, expect, it } from "vitest";
import type { Database } from "bun:sqlite";
import type { ProviderCatalogSnapshot } from "@mcode/contracts";
import { openMemoryDatabase } from "../../../../../runtime/persistence/sqlite/database.js";
import { ProviderCatalogSnapshotRepo } from "../provider-catalog-snapshot-repo.js";

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
  let db: Database | undefined;

  afterEach(() => db?.close());

  function openCatalogDatabase(): Database {
    const database = openMemoryDatabase();
    const insertWorkspace = database.prepare(
      "INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)",
    );
    insertWorkspace.run("workspace-1", "Workspace 1", "C:/repo");
    insertWorkspace.run("workspace-2", "Workspace 2", "C:/other");
    return database;
  }

  it("persists snapshots by provider and realized catalog context", () => {
    db = openCatalogDatabase();
    const firstProcess = new ProviderCatalogSnapshotRepo(db);
    firstProcess.upsert("codex:workspace:workspace-1:C:/repo", "workspace-1", "C:/repo", SNAPSHOT);

    const restartedProcess = new ProviderCatalogSnapshotRepo(db);

    expect(restartedProcess.get("codex:workspace:workspace-1:C:/repo")).toEqual(SNAPSHOT);
    expect(restartedProcess.get("codex:workspace:workspace-2:C:/other")).toBeNull();
  });

  it("rejects malformed persisted payloads without affecting other contexts", () => {
    db = openCatalogDatabase();
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
    db = openCatalogDatabase();
    const repo = new ProviderCatalogSnapshotRepo(db);
    repo.upsert("old", "workspace-1", "C:/repo", SNAPSHOT);
    db.prepare(
      "UPDATE provider_catalog_snapshots SET updated_at = ? WHERE context_key = ?",
    ).run("2000-01-01T00:00:00.000Z", "old");

    expect(repo.get("old")).toEqual(SNAPSHOT);
  });

  it("deletes workspace snapshots when their workspace is deleted", () => {
    db = openCatalogDatabase();
    const repo = new ProviderCatalogSnapshotRepo(db);
    repo.upsert("workspace-snapshot", "workspace-1", "C:/repo", SNAPSHOT);

    db.prepare("DELETE FROM workspaces WHERE id = ?").run("workspace-1");

    expect(repo.get("workspace-snapshot")).toBeNull();
  });

  it("does not recreate a snapshot after its workspace is deleted", () => {
    db = openCatalogDatabase();
    const repo = new ProviderCatalogSnapshotRepo(db);
    db.prepare("DELETE FROM workspaces WHERE id = ?").run("workspace-1");

    const persisted = repo.upsert(
      "deleted-workspace",
      "workspace-1",
      "C:/repo",
      SNAPSHOT,
    );

    expect(persisted).toBe(false);
    expect(repo.get("deleted-workspace")).toBeNull();
  });
});
