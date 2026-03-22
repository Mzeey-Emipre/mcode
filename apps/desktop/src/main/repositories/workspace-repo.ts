import { randomUUID } from "crypto";
import type Database from "better-sqlite3";
import type { Workspace } from "../models.js";

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
    provider_config: JSON.parse(row.provider_config) as Record<string, unknown>,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function create(
  db: Database.Database,
  name: string,
  path: string,
): Workspace {
  const id = randomUUID();
  const now = new Date().toISOString();

  db.prepare(
    "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, name, path, now, now);

  return {
    id,
    name,
    path,
    provider_config: {},
    created_at: now,
    updated_at: now,
  };
}

export function findById(
  db: Database.Database,
  id: string,
): Workspace | null {
  const row = db
    .prepare(
      "SELECT id, name, path, provider_config, created_at, updated_at FROM workspaces WHERE id = ?",
    )
    .get(id) as WorkspaceRow | undefined;

  return row ? rowToWorkspace(row) : null;
}

export function findByPath(
  db: Database.Database,
  path: string,
): Workspace | null {
  const row = db
    .prepare(
      "SELECT id, name, path, provider_config, created_at, updated_at FROM workspaces WHERE path = ?",
    )
    .get(path) as WorkspaceRow | undefined;

  return row ? rowToWorkspace(row) : null;
}

export function listAll(db: Database.Database): Workspace[] {
  const rows = db
    .prepare(
      "SELECT id, name, path, provider_config, created_at, updated_at FROM workspaces ORDER BY updated_at DESC",
    )
    .all() as WorkspaceRow[];

  return rows.map(rowToWorkspace);
}

export function remove(db: Database.Database, id: string): boolean {
  const result = db
    .prepare("DELETE FROM workspaces WHERE id = ?")
    .run(id);

  return result.changes > 0;
}
