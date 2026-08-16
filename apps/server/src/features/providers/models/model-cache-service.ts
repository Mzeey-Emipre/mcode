/**
 * Centralized model cache that sits between the WS router and providers.
 *
 * On construction, synchronously loads all cached model lists from SQLite into
 * memory so RPC responses are instant from the very first call. Stale entries
 * are served immediately while a background refresh fetches fresh data
 * (stale-while-revalidate). Cache writes are elided when the model ID set is
 * unchanged so we avoid pointless SQLite churn.
 */

import { inject, injectable } from "tsyringe";
import { logger } from "@mcode/shared";
import type { ProviderModelInfo, IProviderRegistry } from "@mcode/contracts";
import { ModelCacheRepo } from "../../../repositories/model-cache-repo.js";

/** How long a cached entry is considered "fresh" (no background refresh). */
const CACHE_FRESH_MS = 60 * 60 * 1000; // 1 hour

/**
 * Parse a SQLite `datetime('now')` string as UTC. SQLite returns
 * `YYYY-MM-DD HH:MM:SS` in UTC with no timezone marker; the JS `Date`
 * constructor interprets that format as local time, which would shift
 * cached timestamps by the host TZ offset. We normalize to ISO-UTC.
 */
function parseSqliteUtc(value: string): number {
  // ISO 8601 with explicit UTC marker
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(value)) {
    return new Date(value).getTime();
  }
  return new Date(value.replace(" ", "T") + "Z").getTime();
}

/**
 * Stale-while-revalidate model list cache backed by SQLite for persistence
 * and an in-memory map for instant reads.
 */
@injectable()
export class ModelCacheService {
  /** In-memory cache: provider ID -> model list. */
  private memoryCache = new Map<string, ProviderModelInfo[]>();

  /** Timestamps of last successful fetch per provider (epoch ms). */
  private fetchedAt = new Map<string, number>();

  /** In-flight refresh promises to coalesce concurrent fetches. */
  private inflight = new Map<string, Promise<ProviderModelInfo[]>>();

  /**
   * Increments when `invalidate` runs so a refresh that started earlier cannot
   * repopulate SQLite or memory after the cache was cleared.
   */
  private generation = new Map<string, number>();

  constructor(
    @inject(ModelCacheRepo) private repo: ModelCacheRepo,
    @inject("IProviderRegistry") private registry: IProviderRegistry,
  ) {
    // Wrap in try/catch: a single corrupt JSON row in `provider_model_cache`
    // would otherwise crash the DI container at boot. We prefer an empty
    // in-memory cache (which forces a fresh fetch) over a hard failure.
    try {
      this.loadFromSqlite();
    } catch (err) {
      logger.warn("Failed to load model cache from SQLite", { err: String(err) });
    }
  }

  /**
   * Synchronously loads all cached entries from SQLite into memory.
   * Called once at construction time so cached data is available before
   * any RPC arrives.
   */
  private loadFromSqlite(): void {
    const entries = this.repo.getAll();
    for (const entry of entries) {
      this.memoryCache.set(entry.providerId, entry.models);
      this.fetchedAt.set(entry.providerId, parseSqliteUtc(entry.fetchedAt));
    }
    if (entries.length > 0) {
      logger.info("Model cache loaded from SQLite", {
        providers: entries.map((e) => e.providerId).join(", "),
        totalModels: entries.reduce((sum, e) => sum + e.modelCount, 0),
      });
    }
  }

  /**
   * Returns the model list for a provider. Serves cached data immediately
   * if available. If the cache is stale (older than CACHE_FRESH_MS), the
   * stale data is still returned but a background refresh is kicked off.
   * If no cache exists, fetches synchronously from the provider.
   */
  async listModels(providerId: string): Promise<ProviderModelInfo[]> {
    const cached = this.memoryCache.get(providerId);
    const lastFetch = this.fetchedAt.get(providerId) ?? 0;
    const age = Date.now() - lastFetch;

    if (cached) {
      if (age > CACHE_FRESH_MS) {
        // Fire-and-forget: caller gets stale data immediately, fresh data
        // lands on next call.
        void this.refreshProvider(providerId).catch((err) => {
          logger.warn("Background model refresh failed", { providerId, err: String(err) });
        });
      }
      return cached;
    }

    // No cache: fetch synchronously and block until we have data.
    return this.refreshProvider(providerId);
  }

  /** Read-only access to the in-memory cache. Returns undefined if not cached. */
  getCached(providerId: string): ProviderModelInfo[] | undefined {
    return this.memoryCache.get(providerId);
  }

  /**
   * Drops persisted and in-memory entries for a provider so the next model list
   * fetch runs against the live CLI or SDK again.
   */
  invalidate(providerId: string): void {
    this.generation.set(providerId, (this.generation.get(providerId) ?? 0) + 1);
    this.inflight.delete(providerId);
    this.memoryCache.delete(providerId);
    this.fetchedAt.delete(providerId);
    this.repo.delete(providerId);
  }

  /**
   * Fetches models from the provider, updates both in-memory and SQLite caches.
   * Coalesces concurrent calls for the same provider so we never issue
   * duplicate requests in flight.
   */
  async refreshProvider(providerId: string): Promise<ProviderModelInfo[]> {
    const existing = this.inflight.get(providerId);
    if (existing) return existing;

    const promise = this.doRefresh(providerId);
    this.inflight.set(providerId, promise);

    try {
      return await promise;
    } finally {
      this.inflight.delete(providerId);
    }
  }

  /**
   * Refreshes all providers that support model listing.
   * Called on WS connect to ensure the cache stays warm.
   */
  async refreshAll(): Promise<void> {
    const providers = this.registry.resolveAll();
    const promises = providers.map((p) =>
      this.refreshProvider(p.id).catch((err) => {
        logger.warn("Model refresh failed", { providerId: p.id, err: String(err) });
      }),
    );
    await Promise.allSettled(promises);
  }

  private async doRefresh(providerId: string): Promise<ProviderModelInfo[]> {
    const genAtStart = this.generation.get(providerId) ?? 0;
    const provider = this.registry.resolve(providerId as never);
    const models = await provider.listModels();

    if ((this.generation.get(providerId) ?? 0) !== genAtStart) {
      return models;
    }

    const now = Date.now();

    // Compare ID sets: the model array is rewritten by providers (ordering and
    // metadata can drift) but if the ID set is identical, nothing meaningful
    // changed and we skip the SQLite write.
    const oldModels = this.memoryCache.get(providerId);
    const changed = !oldModels || !this.sameModelIds(oldModels, models);

    this.memoryCache.set(providerId, models);
    this.fetchedAt.set(providerId, now);

    if (changed) {
      this.repo.upsert(providerId, models);
      logger.info("Model cache updated", {
        providerId,
        modelCount: models.length,
      });
    }

    return models;
  }

  /** Compares two model lists by sorted IDs to detect set changes. */
  private sameModelIds(a: ProviderModelInfo[], b: ProviderModelInfo[]): boolean {
    if (a.length !== b.length) return false;
    const sortedA = a.map((m) => m.id).sort();
    const sortedB = b.map((m) => m.id).sort();
    return sortedA.every((id, i) => id === sortedB[i]);
  }
}
