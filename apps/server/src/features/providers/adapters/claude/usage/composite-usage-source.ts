import type { QuotaCategory } from "@mcode/contracts";
import type { IUsageSource } from "@mcode/shared/usage";

const CACHE_TTL_MS = 90_000;

interface CacheEntry {
  result: QuotaCategory[];
  expiresAt: number;
}

/**
 * Walks an ordered list of usage sources and returns the first non-null
 * result. Successful results are cached for 90 seconds; null results
 * are not cached so transient failures recover quickly on the next call.
 */
export class CompositeUsageSource implements IUsageSource {
  readonly id = "claude.composite";
  private cache: CacheEntry | null = null;
  private inflight: Promise<QuotaCategory[] | null> | null = null;
  // Incremented by invalidate() so any in-flight promise that resolves after
  // an invalidation can detect the staleness and skip writing to the cache.
  private generation = 0;

  /** @param sources Ordered list of sources; earlier sources take priority. */
  constructor(private readonly sources: IUsageSource[]) {}

  /** True when at least one source in the chain reports available. */
  async isAvailable(): Promise<boolean> {
    for (const source of this.sources) {
      try {
        if (await source.isAvailable()) return true;
      } catch {
        // Source threw — treat as unavailable and continue to next source.
      }
    }
    return false;
  }

  /**
   * Clears the result cache and bumps the generation counter so any
   * outstanding in-flight promise cannot repopulate the cache with
   * pre-invalidation data. Call before emitting QuotaUpdate.
   */
  invalidate(): void {
    this.cache = null;
    this.generation++;
  }

  /** Returns the first non-null result from the chain, cached for 90s. Concurrent calls share one in-flight request. */
  async fetch(): Promise<QuotaCategory[] | null> {
    if (this.cache && this.cache.expiresAt > Date.now()) {
      return this.cache.result;
    }
    if (this.inflight) return this.inflight;

    const gen = this.generation;
    this.inflight = (async () => {
      for (const source of this.sources) {
        try {
          const result = await source.fetch();
          if (result !== null) {
            // Only write to cache if no invalidate() occurred while we were
            // awaiting the network round-trip.
            if (this.generation === gen) {
              this.cache = { result, expiresAt: Date.now() + CACHE_TTL_MS };
            }
            return result;
          }
        } catch {
          // Source threw — continue to next source in the fallback chain.
        }
      }
      return null;
    })().finally(() => {
      this.inflight = null;
    });

    return this.inflight;
  }
}
