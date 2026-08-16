import "reflect-metadata";
import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import type {
  ProviderCatalogChange,
  ProviderCatalogRequest,
  ProviderCatalogSnapshot,
} from "@mcode/contracts";
import { openMemoryDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { ProviderCatalogSnapshotRepo } from "../persistence/provider-catalog-snapshot-repo.js";
import {
  ProviderCatalogService,
  providerCatalogContextKey,
} from "../provider-catalog-service.js";

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
    db.prepare("INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)")
      .run("workspace-1", "Workspace 1", "C:/repo");
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
          providerId: "codex",
          context: CACHED.context,
          sourceKind: "appServerSkills",
          rejectedSource: "skills/list",
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

  it("reconciles confirmed custom prompts while a Skill source remains stale", async () => {
    const { repo, service } = createService();
    const key = providerCatalogContextKey(REQUEST, "C:/repo");
    const releasePrompt = {
      kind: "customPrompt" as const,
      identity: { providerId: "codex" as const, kind: "customPrompt" as const, nativeId: "release" },
      name: "prompts:release",
      description: "Release v1",
    };
    const removedPrompt = {
      kind: "customPrompt" as const,
      identity: { providerId: "codex" as const, kind: "customPrompt" as const, nativeId: "removed" },
      name: "prompts:removed",
      description: "Removed prompt",
    };
    repo.upsert(key, "workspace-1", "C:/repo", {
      ...CACHED,
      entries: [...CACHED.entries, releasePrompt, removedPrompt],
    });
    const changed = new Promise<ProviderCatalogChange>((resolve) => service.onChanged(resolve));

    service.request({
      request: REQUEST,
      context: CACHED.context,
      cwd: "C:/repo",
      refresh: async () => ({
        snapshot: {
          ...CACHED,
          entries: [
            { ...releasePrompt, description: "Release v2" },
            {
              kind: "customPrompt",
              identity: { providerId: "codex", kind: "customPrompt", nativeId: "added" },
              name: "prompts:added",
              description: "Added prompt",
            },
          ],
          freshness: {
            status: "stale",
            fetchedAt: CACHED.freshness.fetchedAt,
            reason: "Codex Skill discovery failed.",
          },
        },
        confirmedEntryKinds: ["customPrompt"],
      }),
    });

    await expect(changed).resolves.toMatchObject({
      additions: [expect.objectContaining({ name: "prompts:added" })],
      updates: [expect.objectContaining({ description: "Release v2" })],
      removals: [expect.objectContaining({ nativeId: "removed" })],
    });
    expect(repo.get(key)?.entries).toEqual([
      CACHED.entries[0],
      { ...releasePrompt, description: "Release v2" },
      expect.objectContaining({ name: "prompts:added" }),
    ]);
  });

  it("drops a delayed refresh after its workspace is deleted", async () => {
    const { repo, service } = createService();
    const key = providerCatalogContextKey(REQUEST, "C:/repo");
    let finishRefresh!: (snapshot: ProviderCatalogSnapshot) => void;
    const refresh = new Promise<ProviderCatalogSnapshot>((resolve) => {
      finishRefresh = resolve;
    });
    const persist = vi.spyOn(repo, "upsert");
    const changes: ProviderCatalogChange[] = [];
    service.onChanged((change) => changes.push(change));

    service.request({
      request: REQUEST,
      context: CACHED.context,
      cwd: "C:/repo",
      refresh: () => refresh,
    });
    db?.prepare("DELETE FROM workspaces WHERE id = ?").run("workspace-1");
    finishRefresh(CACHED);

    await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce());
    expect(persist.mock.results[0]?.value).toBe(false);
    expect(repo.get(key)).toBeNull();
    expect(changes).toEqual([]);
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

  it("tracks every logical request sharing one persisted checkout", async () => {
    const { repo, service } = createService();
    const key = providerCatalogContextKey(REQUEST, "C:/repo");
    repo.upsert(key, "workspace-1", "C:/repo", CACHED);
    const changes: ProviderCatalogChange[] = [];
    service.onChanged((change) => changes.push(change));
    const firstRequest = { ...REQUEST, threadId: "thread-1" };
    const secondRequest = { ...REQUEST, threadId: "thread-2" };
    const initialRefreshes: Array<ReturnType<typeof vi.fn>> = [];
    const cacheRefreshes: Array<ReturnType<typeof vi.fn>> = [];

    for (const request of [firstRequest, secondRequest]) {
      const refresh = vi.fn(async () => CACHED);
      const refreshFromCache = vi.fn(async () => ({
        ...CACHED,
        freshness: { status: "fresh" as const, fetchedAt: "2026-07-20T14:00:00.000Z" },
      }));
      initialRefreshes.push(refresh);
      cacheRefreshes.push(refreshFromCache);
      service.request({
        request,
        context: {
          scope: "workspace",
          workspaceId: "workspace-1",
          threadId: request.threadId,
        },
        cwd: "C:/repo",
        refresh,
        refreshFromCache,
      });
    }
    await vi.waitFor(() => expect(changes).toHaveLength(2));
    expect(initialRefreshes.reduce((total, refresh) => total + refresh.mock.calls.length, 0))
      .toBe(1);
    changes.length = 0;

    service.refreshKnownContexts("codex", "C:/repo");

    await vi.waitFor(() => expect(changes).toHaveLength(2));
    expect(changes.map((change) => change.request.threadId).sort()).toEqual([
      "thread-1",
      "thread-2",
    ]);
    expect(cacheRefreshes.reduce((total, refresh) => total + refresh.mock.calls.length, 0))
      .toBe(1);
  });

  it("queues a native change received during an active refresh", async () => {
    const { repo, service } = createService();
    const key = providerCatalogContextKey(REQUEST, "C:/repo");
    repo.upsert(key, "workspace-1", "C:/repo", CACHED);
    let finishRefresh!: (snapshot: ProviderCatalogSnapshot) => void;
    const initialRefresh = new Promise<ProviderCatalogSnapshot>((resolve) => {
      finishRefresh = resolve;
    });
    const refreshFromCache = vi.fn(async () => ({
      ...CACHED,
      entries: [{ ...CACHED.entries[0], description: "Review after notification" }],
      freshness: { status: "fresh" as const, fetchedAt: "2026-07-20T14:00:00.000Z" },
    }));
    const changes: ProviderCatalogChange[] = [];
    service.onChanged((change) => changes.push(change));

    service.request({
      request: REQUEST,
      context: CACHED.context,
      cwd: "C:/repo",
      refresh: () => initialRefresh,
      refreshFromCache,
    });
    service.refreshKnownContexts("codex", "C:/repo");
    finishRefresh(CACHED);

    await vi.waitFor(() => expect(changes).toHaveLength(2));
    expect(refreshFromCache).toHaveBeenCalledTimes(1);
    expect(changes[1]?.updates).toEqual([
      expect.objectContaining({ description: "Review after notification" }),
    ]);
  });

  it("bounds logical subscribers attached to one physical refresh", async () => {
    const { service } = createService();
    let finishRefresh!: (snapshot: ProviderCatalogSnapshot) => void;
    const refresh = vi.fn(() => new Promise<ProviderCatalogSnapshot>((resolve) => {
      finishRefresh = resolve;
    }));
    const changes: ProviderCatalogChange[] = [];
    const immediate: ProviderCatalogSnapshot[] = [];
    service.onChanged((change) => changes.push(change));

    for (let index = 0; index < 65; index += 1) {
      const request = { ...REQUEST, threadId: `thread-${index}` };
      immediate.push(service.request({
        request,
        context: {
          scope: "workspace",
          workspaceId: "workspace-1",
          threadId: request.threadId,
        },
        cwd: "C:/repo",
        refresh,
      }));
    }
    expect(immediate[64]).toMatchObject({
      diagnostics: [expect.objectContaining({
        code: "source-unavailable",
        message: expect.stringContaining("capacity"),
      })],
      freshness: { status: "stale", reason: expect.stringContaining("capacity") },
    });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    finishRefresh(CACHED);

    await vi.waitFor(() => expect(changes).toHaveLength(64));
    expect(changes.some((change) => change.request.threadId === "thread-0")).toBe(true);
    expect(changes.some((change) => change.request.threadId === "thread-64")).toBe(false);
  });

  it("bounds concurrent physical catalog refreshes", async () => {
    const { service } = createService();
    const refresh = vi.fn(() => new Promise<ProviderCatalogSnapshot>(() => undefined));
    const immediate: ProviderCatalogSnapshot[] = [];

    for (let index = 0; index < 65; index += 1) {
      immediate.push(service.request({
        request: { ...REQUEST, threadId: `thread-${index}` },
        context: {
          scope: "workspace",
          workspaceId: "workspace-1",
          threadId: `thread-${index}`,
        },
        cwd: `C:/repo-${index}`,
        refresh,
      }));
    }

    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(64));
    expect(immediate[64]).toMatchObject({
      diagnostics: [expect.objectContaining({ code: "source-unavailable" })],
      freshness: { status: "stale", reason: expect.stringContaining("capacity") },
    });
  });

  it("admits a new context after evicting the oldest completed context", async () => {
    const { service } = createService();
    const refresh = vi.fn(async () => CACHED);
    const changes: ProviderCatalogChange[] = [];
    service.onChanged((change) => changes.push(change));

    for (let index = 0; index < 64; index += 1) {
      service.request({
        request: { ...REQUEST, threadId: `thread-${index}` },
        context: {
          scope: "workspace",
          workspaceId: "workspace-1",
          threadId: `thread-${index}`,
        },
        cwd: `C:/repo-${index}`,
        refresh,
      });
    }
    await vi.waitFor(() => expect(changes).toHaveLength(64));
    await new Promise<void>((resolve) => { setImmediate(resolve); });

    const next = service.request({
      request: { ...REQUEST, threadId: "thread-64" },
      context: {
        scope: "workspace",
        workspaceId: "workspace-1",
        threadId: "thread-64",
      },
      cwd: "C:/repo-64",
      refresh,
    });

    expect(next.diagnostics).toEqual([]);
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(65));
    await vi.waitFor(() => expect(changes).toHaveLength(65));
  });
});
