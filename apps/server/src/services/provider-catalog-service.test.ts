import "reflect-metadata";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type {
  ProviderCatalogChange,
  ProviderCatalogRequest,
  ProviderCatalogSnapshot,
} from "@mcode/contracts";
import { openMemoryDatabase } from "../store/database.js";
import { ProviderCatalogSnapshotRepo } from "../repositories/provider-catalog-snapshot-repo.js";
import {
  ProviderCatalogService,
  providerCatalogContextKey,
} from "./provider-catalog-service.js";

const REQUEST: ProviderCatalogRequest = {
  providerId: "codex",
  workspaceId: "workspace-1",
};
const CACHED: ProviderCatalogSnapshot = {
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

describe("ProviderCatalogService", () => {
  let db: Database.Database | undefined;

  afterEach(() => db?.close());

  function createService(): {
    repo: ProviderCatalogSnapshotRepo;
    service: ProviderCatalogService;
  } {
    db = openMemoryDatabase();
    const repo = new ProviderCatalogSnapshotRepo(db);
    return { repo, service: new ProviderCatalogService(repo) };
  }

  it("returns a stale persisted snapshot before background refresh completes", async () => {
    const { repo, service } = createService();
    const key = providerCatalogContextKey(REQUEST, "C:/repo");
    repo.upsert(key, "workspace-1", "C:/repo", CACHED);
    let finishRefresh!: (snapshot: ProviderCatalogSnapshot) => void;
    const refresh = new Promise<ProviderCatalogSnapshot>((resolve) => { finishRefresh = resolve; });

    const immediate = service.request({
      request: REQUEST,
      context: CACHED.context,
      cwd: "C:/repo",
      refresh: () => refresh,
    });

    expect(immediate.entries).toEqual(CACHED.entries);
    expect(immediate.freshness).toMatchObject({ status: "stale" });

    const changed = new Promise<ProviderCatalogChange>((resolve) => service.onChanged(resolve));
    finishRefresh({
      ...CACHED,
      freshness: { status: "fresh", fetchedAt: "2026-07-20T13:00:00.000Z" },
      entries: [
        { ...CACHED.entries[0], description: "Review the current changes" },
        {
          kind: "skill",
          identity: { providerId: "codex", kind: "skill", nativeId: "ship" },
          name: "ship",
          description: "Ship changes",
          source: "project",
        },
      ],
    });

    await expect(changed).resolves.toMatchObject({
      request: REQUEST,
      additions: [expect.objectContaining({ name: "ship" })],
      updates: [expect.objectContaining({ name: "review" })],
      removals: [],
      freshness: { status: "fresh" },
    });
    expect(repo.get(key)?.entries).toHaveLength(2);
  });

  it("retains cached entries and records a scoped diagnostic after refresh failure", async () => {
    const { repo, service } = createService();
    const key = providerCatalogContextKey(REQUEST, "C:/repo");
    repo.upsert(key, "workspace-1", "C:/repo", CACHED);
    const changed = new Promise<ProviderCatalogChange>((resolve) => service.onChanged(resolve));

    service.request({
      request: REQUEST,
      context: CACHED.context,
      cwd: "C:/repo",
      refresh: async () => ({
        ...CACHED,
        entries: [],
        freshness: {
          status: "stale",
          fetchedAt: CACHED.freshness.fetchedAt,
          reason: "Codex Skill discovery failed.",
        },
        diagnostics: [{
          severity: "warning",
          code: "source-unavailable",
          message: "Codex Skills are temporarily unavailable for this catalog context.",
        }],
      }),
    });

    await expect(changed).resolves.toMatchObject({
      additions: [],
      updates: [],
      removals: [],
      diagnostics: [expect.objectContaining({ code: "source-unavailable" })],
    });
    expect(repo.get(key)?.entries).toEqual(CACHED.entries);
  });

  it("uses the workspace snapshot provisionally for a realized worktree context", () => {
    const { repo, service } = createService();
    const workspaceKey = providerCatalogContextKey(REQUEST, "C:/repo");
    repo.upsert(workspaceKey, "workspace-1", "C:/repo", CACHED);
    const worktreeRequest = { ...REQUEST, threadId: "thread-1" };

    const immediate = service.request({
      request: worktreeRequest,
      context: { scope: "workspace", workspaceId: "workspace-1", threadId: "thread-1" },
      cwd: "C:/repo/.worktrees/thread-1",
      fallbackCwd: "C:/repo",
      refresh: () => new Promise(() => undefined),
    });

    expect(immediate.context).toEqual({
      scope: "workspace",
      workspaceId: "workspace-1",
      threadId: "thread-1",
    });
    expect(immediate.entries).toEqual(CACHED.entries);
    expect(immediate.freshness.status).toBe("stale");
  });
});
