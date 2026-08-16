/**
 * Integration test: verifies ModelCacheRepo and ModelCacheService resolve
 * cleanly through the DI container when the standard registration order
 * (Database -> ModelCacheRepo -> IProviderRegistry -> ModelCacheService) is
 * applied. Guards against refactors that would break the wiring done in
 * setupContainer().
 */

import "reflect-metadata";
import { describe, it, expect, afterEach } from "vitest";
import { container } from "tsyringe";
import { openMemoryDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { ModelCacheRepo } from "../persistence/model-cache-repo.js";
import { ModelCacheService } from "../model-cache-service.js";
import type Database from "better-sqlite3";

describe("ModelCacheService DI integration", () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
    container.clearInstances();
  });

  it("resolves ModelCacheService from the container", () => {
    db = openMemoryDatabase();

    container.register("Database", { useValue: db });
    container.registerSingleton(ModelCacheRepo);
    container.register("IProviderRegistry", {
      useValue: {
        resolve: () => ({}) as never,
        resolveAll: () => [],
        shutdown: () => {},
      },
    });
    container.registerSingleton(ModelCacheService);

    const service = container.resolve(ModelCacheService);
    expect(service).toBeInstanceOf(ModelCacheService);
  });

  it("resolves ModelCacheRepo as a singleton", () => {
    db = openMemoryDatabase();
    container.register("Database", { useValue: db });
    container.registerSingleton(ModelCacheRepo);

    const a = container.resolve(ModelCacheRepo);
    const b = container.resolve(ModelCacheRepo);
    expect(a).toBe(b);
  });
});
