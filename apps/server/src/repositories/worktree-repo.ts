import { randomUUID } from "node:crypto";
import { injectable, inject } from "tsyringe";
import type Database from "better-sqlite3";

/** Number of days to retain a stale worktree registration for identity revival. */
export const STALE_WORKTREE_RETENTION_DAYS = 30;
const STALE_WORKTREE_RETENTION_MS = STALE_WORKTREE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** Worktree metadata safe to expose outside the server. */
export interface RegisteredWorktree {
  worktreeId: string;
  label: string;
  branch?: string;
  baseRef?: string;
}

/** Server-side worktree registration input. */
export interface RegisteredWorktreeInput {
  canonicalPath: string;
  label: string;
  branch?: string;
  baseRef?: string;
  managed: boolean;
}

/** Server-only worktree registration including its canonical path and ownership. */
export interface InternalRegisteredWorktree extends RegisteredWorktree {
  workspaceId: string;
  canonicalPath: string;
  managed: boolean;
}

/** Repository for stable workspace-scoped worktree identities. */
@injectable()
export class WorktreeRepo {
  constructor(@inject("Database") private readonly db: Database.Database) {}

  /** Reconcile current Git registrations and return opaque display metadata. */
  reconcile(workspaceId: string, worktrees: readonly RegisteredWorktreeInput[]): RegisteredWorktree[] {
    const now = new Date();
    const lastSeenAt = now.toISOString();
    const staleCutoff = new Date(now.getTime() - STALE_WORKTREE_RETENTION_MS).toISOString();
    const run = this.db.transaction(() => {
      this.db.prepare("UPDATE workspace_worktrees SET stale = 1 WHERE workspace_id = ?").run(workspaceId);
      const upsert = this.db.prepare(
        "INSERT INTO workspace_worktrees (id, workspace_id, canonical_path, label, branch, base_ref, managed, last_seen_at, stale) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0) ON CONFLICT(workspace_id, canonical_path) DO UPDATE SET label = excluded.label, branch = excluded.branch, base_ref = excluded.base_ref, managed = excluded.managed, last_seen_at = excluded.last_seen_at, stale = 0",
      );
      for (const worktree of worktrees) {
        upsert.run(randomUUID(), workspaceId, worktree.canonicalPath, worktree.label, worktree.branch ?? null, worktree.baseRef ?? null, worktree.managed ? 1 : 0, lastSeenAt);
      }
      this.db.prepare("DELETE FROM workspace_worktrees WHERE workspace_id = ? AND stale = 1 AND last_seen_at < ?").run(workspaceId, staleCutoff);
    });
    run();
    return this.list(workspaceId);
  }

  /** List only current worktrees, never their canonical filesystem paths. */
  list(workspaceId: string): RegisteredWorktree[] {
    return this.db.prepare(
      "SELECT id AS worktreeId, label, branch, base_ref AS baseRef FROM workspace_worktrees WHERE workspace_id = ? AND stale = 0 ORDER BY label COLLATE NOCASE, id",
    ).all(workspaceId).map((row) => {
      const value = row as { worktreeId: string; label: string; branch: string | null; baseRef: string | null };
      return {
        worktreeId: value.worktreeId,
        label: value.label,
        ...(value.branch ? { branch: value.branch } : {}),
        ...(value.baseRef ? { baseRef: value.baseRef } : {}),
      };
    });
  }

  /** Resolve one current opaque worktree only within the supplied workspace. */
  findCurrentById(workspaceId: string, worktreeId: string): InternalRegisteredWorktree | null {
    const row = this.db.prepare(
      "SELECT id AS worktreeId, workspace_id AS workspaceId, canonical_path AS canonicalPath, label, branch, base_ref AS baseRef, managed FROM workspace_worktrees WHERE workspace_id = ? AND id = ? AND stale = 0",
    ).get(workspaceId, worktreeId) as {
      worktreeId: string;
      workspaceId: string;
      canonicalPath: string;
      label: string;
      branch: string | null;
      baseRef: string | null;
      managed: number;
    } | undefined;
    if (!row) return null;
    return {
      worktreeId: row.worktreeId,
      workspaceId: row.workspaceId,
      canonicalPath: row.canonicalPath,
      label: row.label,
      managed: row.managed === 1,
      ...(row.branch ? { branch: row.branch } : {}),
      ...(row.baseRef ? { baseRef: row.baseRef } : {}),
    };
  }

  /** Register one newly provisioned worktree without invalidating sibling registrations. */
  register(workspaceId: string, worktree: RegisteredWorktreeInput): RegisteredWorktree {
    const id = randomUUID();
    this.db.prepare(
      "INSERT INTO workspace_worktrees (id, workspace_id, canonical_path, label, branch, base_ref, managed, last_seen_at, stale) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0) ON CONFLICT(workspace_id, canonical_path) DO UPDATE SET label = excluded.label, branch = excluded.branch, base_ref = excluded.base_ref, managed = excluded.managed, last_seen_at = excluded.last_seen_at, stale = 0",
    ).run(
      id,
      workspaceId,
      worktree.canonicalPath,
      worktree.label,
      worktree.branch ?? null,
      worktree.baseRef ?? null,
      worktree.managed ? 1 : 0,
      new Date().toISOString(),
    );
    const row = this.db.prepare(
      "SELECT id AS worktreeId, label, branch, base_ref AS baseRef FROM workspace_worktrees WHERE workspace_id = ? AND canonical_path = ?",
    ).get(workspaceId, worktree.canonicalPath) as {
      worktreeId: string;
      label: string;
      branch: string | null;
      baseRef: string | null;
    };
    return {
      worktreeId: row.worktreeId,
      label: row.label,
      ...(row.branch ? { branch: row.branch } : {}),
      ...(row.baseRef ? { baseRef: row.baseRef } : {}),
    };
  }
}
