import { inject, injectable } from "tsyringe";
import type { Database } from "bun:sqlite";
import {
  ProviderCatalogSnapshotSchema,
  type ProviderCatalogSnapshot,
} from "@mcode/contracts";
import { logger } from "@mcode/shared";

interface ProviderCatalogSnapshotRow {
  snapshot_json: string;
}

const MAX_PERSISTED_CONTEXTS_PER_PROVIDER = 512;

/** Persists bounded provider catalog snapshots by realized discovery context. */
@injectable()
export class ProviderCatalogSnapshotRepo {
  constructor(@inject("Database") private readonly db: Database) {}

  /** Returns one validated snapshot, or null when the row is absent or corrupt. */
  get(contextKey: string): ProviderCatalogSnapshot | null {
    const row = this.db.prepare(
      "SELECT snapshot_json FROM provider_catalog_snapshots WHERE context_key = ?",
    ).get(contextKey) as ProviderCatalogSnapshotRow | undefined;
    if (!row) return null;

    try {
      return ProviderCatalogSnapshotSchema().parse(JSON.parse(row.snapshot_json));
    } catch (error) {
      logger.warn("Ignoring invalid provider catalog snapshot", {
        contextKey,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /** Inserts or replaces a validated snapshot when its workspace still exists. */
  upsert(
    contextKey: string,
    workspaceId: string | undefined,
    cwd: string | undefined,
    snapshot: ProviderCatalogSnapshot,
  ): boolean {
    const validated = ProviderCatalogSnapshotSchema().parse(snapshot);
    return this.db.transaction(() => {
      const result = this.db.prepare(`
        INSERT INTO provider_catalog_snapshots
          (context_key, provider_id, workspace_id, cwd, snapshot_json, updated_at)
        SELECT ?, ?, ?, ?, ?, datetime('now')
        WHERE ? IS NULL OR EXISTS (SELECT 1 FROM workspaces WHERE id = ?)
        ON CONFLICT(context_key) DO UPDATE SET
          provider_id = excluded.provider_id,
          workspace_id = excluded.workspace_id,
          cwd = excluded.cwd,
          snapshot_json = excluded.snapshot_json,
          updated_at = excluded.updated_at
      `).run(
        contextKey,
        validated.providerId,
        workspaceId ?? null,
        cwd ?? null,
        JSON.stringify(validated),
        workspaceId ?? null,
        workspaceId ?? null,
      );
      if (result.changes === 0) return false;
      this.db.prepare(`
        DELETE FROM provider_catalog_snapshots
        WHERE context_key IN (
          SELECT context_key
          FROM provider_catalog_snapshots
          WHERE provider_id = ?
          ORDER BY updated_at DESC, context_key DESC
          LIMIT -1 OFFSET ?
        )
      `).run(validated.providerId, MAX_PERSISTED_CONTEXTS_PER_PROVIDER);
      return true;
    })();
  }
}
