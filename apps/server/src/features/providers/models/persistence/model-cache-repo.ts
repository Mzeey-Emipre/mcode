/**
 * Model cache data access layer.
 * Provides CRUD operations for the `provider_model_cache` SQLite table,
 * which persists per-provider model lists across app restarts.
 */

import { inject, injectable } from "tsyringe";
import type Database from "better-sqlite3";
import type { ProviderModelInfo } from "@mcode/contracts";

/** A cached model list row from `provider_model_cache`. */
export interface CachedModelEntry {
  providerId: string;
  models: ProviderModelInfo[];
  fetchedAt: string;
  modelCount: number;
}

/** Row shape for the `provider_model_cache` table. */
interface CacheRow {
  provider_id: string;
  models_json: string;
  fetched_at: string;
  model_count: number;
}

/** Data access for the `provider_model_cache` SQLite table. */
@injectable()
export class ModelCacheRepo {
  constructor(@inject("Database") private readonly db: Database.Database) {}

  /** Read cached models for a provider. Returns null if no cache entry exists. */
  get(providerId: string): CachedModelEntry | null {
    const row = this.db
      .prepare(
        "SELECT provider_id, models_json, fetched_at, model_count FROM provider_model_cache WHERE provider_id = ?",
      )
      .get(providerId) as CacheRow | undefined;

    if (!row) return null;

    return {
      providerId: row.provider_id,
      models: JSON.parse(row.models_json) as ProviderModelInfo[],
      fetchedAt: row.fetched_at,
      modelCount: row.model_count,
    };
  }

  /** Read all cached provider entries. Used at startup to pre-populate memory. */
  getAll(): CachedModelEntry[] {
    const rows = this.db
      .prepare(
        "SELECT provider_id, models_json, fetched_at, model_count FROM provider_model_cache",
      )
      .all() as CacheRow[];

    return rows.map((row) => ({
      providerId: row.provider_id,
      models: JSON.parse(row.models_json) as ProviderModelInfo[],
      fetchedAt: row.fetched_at,
      modelCount: row.model_count,
    }));
  }

  /** Insert or replace cached models for a provider. */
  upsert(providerId: string, models: ProviderModelInfo[]): void {
    this.db
      .prepare(
        `INSERT INTO provider_model_cache (provider_id, models_json, fetched_at, model_count)
         VALUES (?, ?, datetime('now'), ?)
         ON CONFLICT(provider_id) DO UPDATE SET
           models_json = excluded.models_json,
           fetched_at  = excluded.fetched_at,
           model_count = excluded.model_count`,
      )
      .run(providerId, JSON.stringify(models), models.length);
  }

  /** Remove cached models for a provider (e.g. when provider is disabled). */
  delete(providerId: string): void {
    this.db
      .prepare("DELETE FROM provider_model_cache WHERE provider_id = ?")
      .run(providerId);
  }
}
