import { randomUUID } from "crypto";
import type Database from "better-sqlite3";
import type { Thread, ThreadMode, ThreadStatus } from "../models.js";

interface ThreadRow {
  id: string;
  workspace_id: string;
  title: string;
  status: string;
  mode: string;
  worktree_path: string | null;
  branch: string;
  worktree_managed: number;
  issue_number: number | null;
  pr_number: number | null;
  pr_status: string | null;
  session_name: string;
  pid: number | null;
  model: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

function rowToThread(row: ThreadRow): Thread {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    title: row.title,
    status: row.status as ThreadStatus,
    mode: row.mode as ThreadMode,
    worktree_path: row.worktree_path,
    branch: row.branch,
    worktree_managed: row.worktree_managed === 1,
    issue_number: row.issue_number,
    pr_number: row.pr_number,
    pr_status: row.pr_status,
    session_name: row.session_name,
    pid: row.pid,
    model: row.model ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at,
  };
}

const THREAD_COLUMNS =
  "id, workspace_id, title, status, mode, worktree_path, branch, worktree_managed, issue_number, pr_number, pr_status, session_name, pid, model, created_at, updated_at, deleted_at";

export function create(
  db: Database.Database,
  workspaceId: string,
  title: string,
  mode: ThreadMode,
  branch: string,
  worktreeManaged = true,
): Thread {
  const id = randomUUID();
  const now = new Date().toISOString();
  const sessionName = `mcode-${id}`;
  const managedInt = worktreeManaged ? 1 : 0;

  db.prepare(
    "INSERT INTO threads (id, workspace_id, title, status, mode, branch, worktree_managed, session_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, workspaceId, title, "active", mode, branch, managedInt, sessionName, now, now);

  return {
    id,
    workspace_id: workspaceId,
    title,
    status: "active",
    mode,
    worktree_path: null,
    branch,
    worktree_managed: worktreeManaged,
    issue_number: null,
    pr_number: null,
    pr_status: null,
    session_name: sessionName,
    pid: null,
    model: null,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
}

export function findById(
  db: Database.Database,
  id: string,
): Thread | null {
  const row = db
    .prepare(`SELECT ${THREAD_COLUMNS} FROM threads WHERE id = ?`)
    .get(id) as ThreadRow | undefined;

  return row ? rowToThread(row) : null;
}

export function listByWorkspace(
  db: Database.Database,
  workspaceId: string,
  limit = 100,
): Thread[] {
  const clampedLimit = Math.max(1, Math.min(1000, limit));

  const rows = db
    .prepare(
      `SELECT ${THREAD_COLUMNS} FROM threads WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ?`,
    )
    .all(workspaceId, clampedLimit) as ThreadRow[];

  return rows.map(rowToThread);
}

export function updateStatus(
  db: Database.Database,
  id: string,
  status: ThreadStatus,
): boolean {
  const now = new Date().toISOString();
  const result = db
    .prepare("UPDATE threads SET status = ?, updated_at = ? WHERE id = ?")
    .run(status, now, id);

  return result.changes > 0;
}

export function updateWorktreePath(
  db: Database.Database,
  id: string,
  worktreePath: string,
): boolean {
  const now = new Date().toISOString();
  const result = db
    .prepare("UPDATE threads SET worktree_path = ?, updated_at = ? WHERE id = ?")
    .run(worktreePath, now, id);

  return result.changes > 0;
}

export function softDelete(db: Database.Database, id: string): boolean {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      "UPDATE threads SET deleted_at = ?, status = ?, updated_at = ? WHERE id = ?",
    )
    .run(now, "deleted", now, id);

  return result.changes > 0;
}

export function hardDelete(db: Database.Database, id: string): boolean {
  const result = db
    .prepare("DELETE FROM threads WHERE id = ?")
    .run(id);

  return result.changes > 0;
}

export function updateModel(
  db: Database.Database,
  id: string,
  model: string,
): boolean {
  const now = new Date().toISOString();
  const result = db
    .prepare("UPDATE threads SET model = ?, updated_at = ? WHERE id = ?")
    .run(model, now, id);

  return result.changes > 0;
}

export function updateTitle(
  db: Database.Database,
  id: string,
  title: string,
): boolean {
  const now = new Date().toISOString();
  const result = db
    .prepare("UPDATE threads SET title = ?, updated_at = ? WHERE id = ?")
    .run(title, now, id);

  return result.changes > 0;
}
