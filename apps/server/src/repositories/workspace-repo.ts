/**
 * Workspace data access layer.
 * Provides CRUD operations for workspace records in SQLite.
 */

import { randomUUID } from "crypto";
import { injectable, inject } from "tsyringe";
import type Database from "better-sqlite3";
import type { Workspace } from "@mcode/contracts";

interface WorkspaceRow {
  id: string;
  name: string;
  path: string;
  provider_config: string;
  created_at: string;
  updated_at: string;
}

function rowToWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    provider_config: JSON.parse(row.provider_config) as Record<
      string,
      unknown
    >,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Repository for workspace CRUD operations against SQLite. */
@injectable()
export class WorkspaceRepo {
  constructor(@inject("Database") private readonly db: Database.Database) {}

  /** Create a new workspace and return the fully-populated record. */
  create(name: string, path: string): Workspace {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, name, path, now, now);

    return {
      id,
      name,
      path,
      provider_config: {},
      created_at: now,
      updated_at: now,
    };
  }

  /** Find a workspace by its primary key. Returns null if not found. */
  findById(id: string): Workspace | null {
    const row = this.db
      .prepare(
        "SELECT id, name, path, provider_config, created_at, updated_at FROM workspaces WHERE id = ?",
      )
      .get(id) as WorkspaceRow | undefined;

    return row ? rowToWorkspace(row) : null;
  }

  /** Find a workspace by its filesystem path. Returns null if not found. */
  findByPath(path: string): Workspace | null {
    const row = this.db
      .prepare(
        "SELECT id, name, path, provider_config, created_at, updated_at FROM workspaces WHERE path = ?",
      )
      .get(path) as WorkspaceRow | undefined;

    return row ? rowToWorkspace(row) : null;
  }

  /** List all workspaces ordered by most recently updated first. */
  listAll(): Workspace[] {
    const rows = this.db
      .prepare(
        "SELECT id, name, path, provider_config, created_at, updated_at FROM workspaces ORDER BY updated_at DESC",
      )
      .all() as WorkspaceRow[];

    return rows.map(rowToWorkspace);
  }

  /** Delete a workspace by ID. Returns true if a row was removed. */
  remove(id: string): boolean {
    const result = this.db
      .prepare("DELETE FROM workspaces WHERE id = ?")
      .run(id);

    return result.changes > 0;
  }
}
