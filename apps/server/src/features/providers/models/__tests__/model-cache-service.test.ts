/**
 * Tests for ModelCacheService — verifies stale-while-revalidate semantics,
 * SQLite hydration at construction time, and write-elision on unchanged
 * model lists.
 */

import "reflect-metadata";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { ModelCacheRepo } from "../persistence/model-cache-repo.js";
import { ModelCacheService } from "../model-cache-service.js";
import type { ProviderModelInfo, IProviderRegistry } from "@mcode/contracts";

function makeProvider(models: ProviderModelInfo[]) {
  return {
    id: "test-provider",
    listModels: vi.fn().mockResolvedValue(models),
    sendTurn: vi.fn(),
    cancelSession: vi.fn(),
    shutdown: vi.fn(),
  };
}

function makeRegistry(
  providers: Map<string, ReturnType<typeof makeProvider> | { id: string }>,
): IProviderRegistry {
  return {
    resolve: (id: string) => {
      const p = providers.get(id);
      if (!p) throw new Error(`No provider: ${id}`);
      return p as never;
    },
    resolveAll: () => [...providers.values()] as never[],
    shutdown: vi.fn(),
  };
}

describe("ModelCacheService", () => {
  let db: Database;
  let repo: ModelCacheRepo;

  beforeEach(() => {
    db = openMemoryDatabase();
    repo = new ModelCacheRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns cached models without calling provider when cache is fresh", async () => {
    const models: ProviderModelInfo[] = [{ id: "m1", name: "Model 1" }];
    repo.upsert("test-provider", models);

    const provider = makeProvider([{ id: "m1", name: "Model 1 Updated" }]);
    const registry = makeRegistry(new Map([["test-provider", provider]]));
    const service = new ModelCacheService(repo, registry);

    const result = await service.listModels("test-provider");
    expect(result).toEqual(models);
    // Provider should NOT have been called because cache is fresh
    expect(provider.listModels).not.toHaveBeenCalled();
  });

  it("fetches from provider when no cache exists", async () => {
    const models: ProviderModelInfo[] = [{ id: "m1", name: "Model 1" }];
    const provider = makeProvider(models);
    const registry = makeRegistry(new Map([["test-provider", provider]]));
    const service = new ModelCacheService(repo, registry);

    const result = await service.listModels("test-provider");
    expect(result).toEqual(models);
    expect(provider.listModels).toHaveBeenCalledTimes(1);
  });

  it("persists fetched models to SQLite", async () => {
    const models: ProviderModelInfo[] = [{ id: "m1", name: "Model 1" }];
    const provider = makeProvider(models);
    const registry = makeRegistry(new Map([["test-provider", provider]]));
    const service = new ModelCacheService(repo, registry);

    await service.listModels("test-provider");

    const cached = repo.get("test-provider");
    expect(cached).not.toBeNull();
    expect(cached!.models).toEqual(models);
  });

  it("loads all cached entries into memory at construction", () => {
    repo.upsert("cursor", [{ id: "c1", name: "Cursor Model" }]);
    repo.upsert("copilot", [{ id: "p1", name: "Copilot Model" }]);

    const registry = makeRegistry(new Map());
    const service = new ModelCacheService(repo, registry);

    // Both should be available from in-memory cache without provider calls
    expect(service.getCached("cursor")).toEqual([{ id: "c1", name: "Cursor Model" }]);
    expect(service.getCached("copilot")).toEqual([{ id: "p1", name: "Copilot Model" }]);
  });

  it("does not write to SQLite when model IDs are unchanged", async () => {
    const models: ProviderModelInfo[] = [
      { id: "m1", name: "Model 1" },
      { id: "m2", name: "Model 2" },
    ];
    repo.upsert("test-provider", models);

    const provider = makeProvider(models);
    const registry = makeRegistry(new Map([["test-provider", provider]]));
    const service = new ModelCacheService(repo, registry);

    // Spy on repo.upsert to confirm it's not called when IDs match
    const upsertSpy = vi.spyOn(repo, "upsert");

    // Force a refresh
    await service.refreshProvider("test-provider");

    // The provider was called, but since IDs match, upsert should not run
    expect(provider.listModels).toHaveBeenCalledTimes(1);
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it("updates SQLite when provider returns different model IDs", async () => {
    repo.upsert("test-provider", [{ id: "old", name: "Old" }]);

    const newModels: ProviderModelInfo[] = [{ id: "new", name: "New" }];
    const provider = makeProvider(newModels);
    const registry = makeRegistry(new Map([["test-provider", provider]]));
    const service = new ModelCacheService(repo, registry);

    await service.refreshProvider("test-provider");

    const cached = repo.get("test-provider");
    expect(cached!.models).toEqual(newModels);
  });

  it("invalidate clears memory and SQLite so the next read refetches", async () => {
    repo.upsert("cursor", [{ id: "c1", name: "Cached" }]);
    const fresh: ProviderModelInfo[] = [{ id: "c2", name: "Fresh" }];
    const provider = makeProvider(fresh);
    const registry = makeRegistry(new Map([["cursor", provider]]));
    const service = new ModelCacheService(repo, registry);

    expect(service.getCached("cursor")).toEqual([{ id: "c1", name: "Cached" }]);

    service.invalidate("cursor");

    expect(service.getCached("cursor")).toBeUndefined();
    expect(repo.get("cursor")).toBeNull();

    const result = await service.listModels("cursor");
    expect(result).toEqual(fresh);
    expect(provider.listModels).toHaveBeenCalledTimes(1);
  });

  it("invalidate during in-flight refresh does not repopulate cache", async () => {
    let resolveList!: (value: ProviderModelInfo[]) => void;
    const listPromise = new Promise<ProviderModelInfo[]>((resolve) => {
      resolveList = resolve;
    });
    const stale: ProviderModelInfo[] = [{ id: "stale", name: "Stale" }];
    const provider = {
      id: "cursor",
      listModels: vi.fn().mockReturnValue(listPromise),
      sendTurn: vi.fn(),
      cancelSession: vi.fn(),
      shutdown: vi.fn(),
    };
    repo.upsert("cursor", [{ id: "seed", name: "Seed" }]);
    const registry = makeRegistry(new Map([["cursor", provider]]));
    const service = new ModelCacheService(repo, registry);

    expect(service.getCached("cursor")).toEqual([{ id: "seed", name: "Seed" }]);

    const refreshDone = service.refreshProvider("cursor");

    service.invalidate("cursor");

    expect(service.getCached("cursor")).toBeUndefined();
    expect(repo.get("cursor")).toBeNull();

    resolveList(stale);
    await refreshDone;

    expect(service.getCached("cursor")).toBeUndefined();
    expect(repo.get("cursor")).toBeNull();
    expect(provider.listModels).toHaveBeenCalledTimes(1);
  });

  it("throws when fetching from a provider that does not implement listModels", async () => {
    const provider = {
      id: "no-list",
      sendTurn: vi.fn(),
      cancelSession: vi.fn(),
      shutdown: vi.fn(),
    };
    const registry = makeRegistry(new Map([["no-list", provider]]));
    const service = new ModelCacheService(repo, registry);

    await expect(service.listModels("no-list")).rejects.toThrow();
  });
});
