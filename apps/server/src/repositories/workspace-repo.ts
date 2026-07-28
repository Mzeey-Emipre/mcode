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
  is_git_repo: number;
  created_at: string;
  updated_at: string;
  pinned: number;
  last_opened_at: number | null;
  sort_order: number;
  deleted_at: string | null;
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
    is_git_repo: row.is_git_repo === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
    pinned: row.pinned === 1,
    last_opened_at: row.last_opened_at ?? null,
    sort_order: row.sort_order,
    deleted_at: row.deleted_at ?? null,
  };
}

/** Repository for workspace CRUD operations against SQLite. */
@injectable()
export class WorkspaceRepo {
  constructor(@inject("Database") private readonly db: Database.Database) {}

  /** Create a new workspace and return the fully-populated record. */
  create(name: string, path: string, isGitRepo = true): Workspace {
    const id = randomUUID();
    const now = new Date().toISOString();

    const trx = this.db.transaction(() => {
      // Evict a soft-deleted row occupying this path only if it has no remaining
      // child threads (i.e. async cleanup already finished). If threads still
      // exist the CleanupWorker will hard-delete the workspace once done.
      const stale = this.db
        .prepare("SELECT id FROM workspaces WHERE path = ? AND deleted_at IS NOT NULL")
        .get(path) as { id: string } | undefined;
      if (stale) {
        const threadCount = this.db
          .prepare("SELECT COUNT(*) AS n FROM threads WHERE workspace_id = ?")
          .get(stale.id) as { n: number };
        if (threadCount.n === 0) {
          this.db.prepare("DELETE FROM workspaces WHERE id = ?").run(stale.id);
        }
      }
      this.db
        .prepare("UPDATE workspaces SET sort_order = sort_order + 1")
        .run();
      this.db
        .prepare(
          "INSERT INTO workspaces (id, name, path, is_git_repo, created_at, updated_at, sort_order) VALUES (?, ?, ?, ?, ?, ?, 0)",
        )
        .run(id, name, path, isGitRepo ? 1 : 0, now, now);
    });
    trx();

    return {
      id,
      name,
      path,
      provider_config: {},
      is_git_repo: isGitRepo,
      created_at: now,
      updated_at: now,
      pinned: false,
      last_opened_at: null,
      sort_order: 0,
      deleted_at: null,
    };
  }

  /** Move an existing workspace to the top of the sidebar (sort_order 0). */
  prependToSortOrder(id: string): void {
    const row = this.db
      .prepare("SELECT sort_order FROM workspaces WHERE id = ?")
      .get(id) as { sort_order: number } | undefined;
    if (!row || row.sort_order === 0) return;

    const trx = this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE workspaces SET sort_order = sort_order + 1 WHERE sort_order < ?",
        )
        .run(row.sort_order);
      this.db.prepare("UPDATE workspaces SET sort_order = 0 WHERE id = ?").run(id);
    });
    trx();
  }

  /**
   * Reorder a workspace to a zero-based index in the current sort_order ordering.
   * Rebuilds sequential sort_order values to handle duplicates from legacy migrations.
   */
  reorderToIndex(id: string, newIndex: number): void {
    const rows = this.db
      .prepare(
        "SELECT id FROM workspaces ORDER BY sort_order ASC, id ASC",
      )
      .all() as Array<{ id: string }>;

    const oldIdx = rows.findIndex((r) => r.id === id);
    if (oldIdx < 0) return;

    const n = rows.length;
    const idx = Math.max(0, Math.min(newIndex, n - 1));
    if (oldIdx === idx) return;

    const ids = rows.map((r) => r.id);
    const [moved] = ids.splice(oldIdx, 1);
    ids.splice(idx, 0, moved!);

    const stmt = this.db.prepare(
      "UPDATE workspaces SET sort_order = ? WHERE id = ?",
    );
    const trx = this.db.transaction(() => {
      for (let i = 0; i < ids.length; i++) {
        stmt.run(i, ids[i]);
      }
    });
    trx();
  }

  /** Find a workspace by its primary key. Returns null if not found or soft-deleted. */
  findById(id: string): Workspace | null {
    const row = this.db
      .prepare(
        "SELECT id, name, path, provider_config, is_git_repo, created_at, updated_at, pinned, last_opened_at, sort_order, deleted_at FROM workspaces WHERE id = ? AND deleted_at IS NULL",
      )
      .get(id) as WorkspaceRow | undefined;

    return row ? rowToWorkspace(row) : null;
  }

  /** Find a workspace by its filesystem path. Returns null if not found or soft-deleted. */
  findByPath(path: string): Workspace | null {
    const row = this.db
      .prepare(
        "SELECT id, name, path, provider_config, is_git_repo, created_at, updated_at, pinned, last_opened_at, sort_order, deleted_at FROM workspaces WHERE path = ? AND deleted_at IS NULL",
      )
      .get(path) as WorkspaceRow | undefined;

    return row ? rowToWorkspace(row) : null;
  }

  /** List all non-deleted workspaces ordered by ascending sidebar sort_order. */
  listAll(): Workspace[] {
    const rows = this.db
      .prepare(
        "SELECT id, name, path, provider_config, is_git_repo, created_at, updated_at, pinned, last_opened_at, sort_order, deleted_at FROM workspaces WHERE deleted_at IS NULL ORDER BY sort_order ASC, id ASC",
      )
      .all() as WorkspaceRow[];

    return rows.map(rowToWorkspace);
  }

  /** Search registered non-deleted workspaces by name or repository path. */
  search(query: string, limit: number): Workspace[] {
    const normalized = query.trim();
    if (!normalized) {
      return this.db.prepare(
        "SELECT id, name, path, provider_config, is_git_repo, created_at, updated_at, pinned, last_opened_at, sort_order, deleted_at FROM workspaces WHERE deleted_at IS NULL ORDER BY last_opened_at DESC NULLS LAST, updated_at DESC, id ASC LIMIT ?",
      ).all(limit).map((row) => rowToWorkspace(row as WorkspaceRow));
    }
    const pattern = `%${normalized.replace(/[\\%_]/g, "\\$&")}%`;
    return this.db.prepare(
      "SELECT id, name, path, provider_config, is_git_repo, created_at, updated_at, pinned, last_opened_at, sort_order, deleted_at FROM workspaces WHERE deleted_at IS NULL AND (name LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\') ORDER BY last_opened_at DESC NULLS LAST, updated_at DESC, id ASC LIMIT ?",
    ).all(pattern, pattern, limit).map((row) => rowToWorkspace(row as WorkspaceRow));
  }

  /** Rename a non-deleted workspace and return its updated record. */
  rename(id: string, name: string): Workspace | null {
    const result = this.db
      .prepare("UPDATE workspaces SET name = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
      .run(name, new Date().toISOString(), id);
    return result.changes > 0 ? this.findById(id) : null;
  }

  /** Set the pinned flag for a workspace. Pinned workspaces always sort above recents. */
  setPinned(id: string, pinned: boolean): void {
    this.db.prepare("UPDATE workspaces SET pinned = ? WHERE id = ?").run(pinned ? 1 : 0, id);
  }

  /** Update last_opened_at to now without touching updated_at. Used to track recency separately from edits. */
  touchLastOpened(id: string): void {
    this.db.prepare("UPDATE workspaces SET last_opened_at = ? WHERE id = ?").run(Date.now(), id);
  }

  /** Clear last_opened_at and pinned, removing the workspace from the recents/pinned list. */
  removeRecent(id: string): void {
    this.db.prepare("UPDATE workspaces SET last_opened_at = NULL, pinned = 0 WHERE id = ?").run(id);
  }

  /** Soft-delete a workspace by setting deleted_at. Returns true if a row was changed. */
  softDelete(id: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare("UPDATE workspaces SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
      .run(now, now, id);
    return result.changes > 0;
  }

  /** Permanently remove a workspace and all its children (via FK cascade). */
  hardDelete(id: string): boolean {
    const result = this.db
      .prepare("DELETE FROM workspaces WHERE id = ?")
      .run(id);
    return result.changes > 0;
  }

  /** Find all workspaces currently in the soft-deleted (deleting) state. */
  findDeleting(): Array<{ id: string; path: string; deletedAt: string }> {
    return this.db
      .prepare("SELECT id, path, deleted_at AS deletedAt FROM workspaces WHERE deleted_at IS NOT NULL")
      .all() as Array<{ id: string; path: string; deletedAt: string }>;
  }

  /** Find a single soft-deleted workspace by path. O(1) lookup for finalization. */
  findDeletingByPath(path: string): { id: string; path: string; deletedAt: string } | null {
    const row = this.db
      .prepare("SELECT id, path, deleted_at AS deletedAt FROM workspaces WHERE path = ? AND deleted_at IS NOT NULL")
      .get(path) as { id: string; path: string; deletedAt: string } | undefined;
    return row ?? null;
  }

  /** Find a workspace by ID regardless of deletion status. Used during cleanup. */
  findByIdIncludeDeleted(id: string): Workspace | null {
    const row = this.db
      .prepare(
        "SELECT id, name, path, provider_config, is_git_repo, created_at, updated_at, pinned, last_opened_at, sort_order, deleted_at FROM workspaces WHERE id = ?",
      )
      .get(id) as WorkspaceRow | undefined;
    return row ? rowToWorkspace(row) : null;
  }

  /** Bump updated_at to the current time so the workspace sorts to the top of the recent list. */
  touch(id: string): void {
    this.db
      .prepare("UPDATE workspaces SET updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  }

  /** Update the is_git_repo flag (e.g. after the user runs `git init`). */
  setIsGitRepo(id: string, isGitRepo: boolean): void {
    this.db
      .prepare("UPDATE workspaces SET is_git_repo = ? WHERE id = ?")
      .run(isGitRepo ? 1 : 0, id);
  }
}
