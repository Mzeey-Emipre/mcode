/**
 * Thread data access layer.
 * Provides CRUD and lifecycle operations for thread records in SQLite.
 */

import { randomUUID } from "crypto";
import { injectable, inject } from "tsyringe";
import type Database from "better-sqlite3";
import type { Thread, ThreadMode, ThreadStatus, ReasoningLevel, InteractionMode, PermissionMode } from "@mcode/contracts";

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
  sdk_session_id: string | null;
  model: string | null;
  provider: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  last_context_tokens: number | null;
  context_window: number | null;
  reasoning_level: string | null;
  interaction_mode: string | null;
  permission_mode: string | null;
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
    sdk_session_id: row.sdk_session_id,
    model: row.model ?? null,
    provider: row.provider,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at,
    last_context_tokens: row.last_context_tokens ?? null,
    context_window: row.context_window ?? null,
    reasoning_level: (row.reasoning_level ?? null) as ReasoningLevel | null,
    interaction_mode: (row.interaction_mode ?? null) as InteractionMode | null,
    permission_mode: (row.permission_mode ?? null) as PermissionMode | null,
  };
}

const THREAD_COLUMNS =
  "id, workspace_id, title, status, mode, worktree_path, branch, worktree_managed, issue_number, pr_number, pr_status, sdk_session_id, model, provider, created_at, updated_at, deleted_at, last_context_tokens, context_window, reasoning_level, interaction_mode, permission_mode";

/** Repository for thread lifecycle operations against SQLite. */
@injectable()
export class ThreadRepo {
  constructor(@inject("Database") private readonly db: Database.Database) {}

  /** Create a new thread and return the fully-populated record. */
  create(
    workspaceId: string,
    title: string,
    mode: ThreadMode,
    branch: string,
    worktreeManaged = true,
    provider = "claude",
  ): Thread {
    const id = randomUUID();
    const now = new Date().toISOString();
    const managedInt = worktreeManaged ? 1 : 0;

    this.db
      .prepare(
        "INSERT INTO threads (id, workspace_id, title, status, mode, branch, worktree_managed, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        workspaceId,
        title,
        "active",
        mode,
        branch,
        managedInt,
        provider,
        now,
        now,
      );

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
      sdk_session_id: null,
      model: null,
      provider,
      created_at: now,
      updated_at: now,
      deleted_at: null,
      last_context_tokens: null,
      context_window: null,
      reasoning_level: null,
      interaction_mode: null,
      permission_mode: null,
    };
  }

  /** Find a thread by its primary key. Returns null if not found. */
  findById(id: string): Thread | null {
    const row = this.db
      .prepare(`SELECT ${THREAD_COLUMNS} FROM threads WHERE id = ?`)
      .get(id) as ThreadRow | undefined;

    return row ? rowToThread(row) : null;
  }

  /** List non-deleted threads for a workspace, most recent first. */
  listByWorkspace(workspaceId: string, limit = 100): Thread[] {
    const clampedLimit = Math.max(1, Math.min(1000, limit));

    const rows = this.db
      .prepare(
        `SELECT ${THREAD_COLUMNS} FROM threads WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ?`,
      )
      .all(workspaceId, clampedLimit) as ThreadRow[];

    return rows.map(rowToThread);
  }

  /** Update a thread's lifecycle status. Returns true if a row was changed. */
  updateStatus(id: string, status: ThreadStatus): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare("UPDATE threads SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, now, id);

    return result.changes > 0;
  }

  /** Set the worktree filesystem path for a thread. Returns true if a row was changed. */
  updateWorktreePath(id: string, worktreePath: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        "UPDATE threads SET worktree_path = ?, updated_at = ? WHERE id = ?",
      )
      .run(worktreePath, now, id);

    return result.changes > 0;
  }

  /** Soft-delete a thread by setting deleted_at and status to "deleted". */
  softDelete(id: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        "UPDATE threads SET deleted_at = ?, status = ?, updated_at = ? WHERE id = ?",
      )
      .run(now, "deleted", now, id);

    return result.changes > 0;
  }

  /** Permanently remove a thread record from the database. */
  hardDelete(id: string): boolean {
    const result = this.db
      .prepare("DELETE FROM threads WHERE id = ?")
      .run(id);

    return result.changes > 0;
  }

  /** Update the provider associated with a thread. Returns true if a row was changed. */
  updateProvider(id: string, provider: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare("UPDATE threads SET provider = ?, updated_at = ? WHERE id = ?")
      .run(provider, now, id);

    return result.changes > 0;
  }

  /** Update the model associated with a thread. Returns true if a row was changed. */
  updateModel(id: string, model: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare("UPDATE threads SET model = ?, updated_at = ? WHERE id = ?")
      .run(model, now, id);

    return result.changes > 0;
  }

  /** Store the SDK-assigned session ID for later resume. Returns true if a row was changed. */
  updateSdkSessionId(id: string, sdkSessionId: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        "UPDATE threads SET sdk_session_id = ?, updated_at = ? WHERE id = ?",
      )
      .run(sdkSessionId, now, id);

    return result.changes > 0;
  }

  /** Clear the SDK session ID for a thread. Returns true if a row was changed. */
  clearSdkSessionId(id: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        "UPDATE threads SET sdk_session_id = NULL, updated_at = ? WHERE id = ?",
      )
      .run(now, id);

    return result.changes > 0;
  }

  /** Link a GitHub PR to a thread. Returns true if a row was changed. */
  updatePr(id: string, prNumber: number, prStatus: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        "UPDATE threads SET pr_number = ?, pr_status = ?, updated_at = ? WHERE id = ?",
      )
      .run(prNumber, prStatus, now, id);

    return result.changes > 0;
  }

  /** Persist the latest context window usage for a thread. */
  updateContextUsage(id: string, lastContextTokens: number, contextWindow: number): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        "UPDATE threads SET last_context_tokens = ?, context_window = ?, updated_at = ? WHERE id = ?",
      )
      .run(lastContextTokens, contextWindow, now, id);

    return result.changes > 0;
  }

  /** Persist per-thread composer settings (reasoning, mode, permission). */
  updateSettings(
    id: string,
    settings: {
      reasoning_level?: string;
      interaction_mode?: string;
      permission_mode?: string;
    },
  ): boolean {
    const fields: string[] = [];
    const values: unknown[] = [];
    if (settings.reasoning_level !== undefined) {
      fields.push("reasoning_level = ?");
      values.push(settings.reasoning_level);
    }
    if (settings.interaction_mode !== undefined) {
      fields.push("interaction_mode = ?");
      values.push(settings.interaction_mode);
    }
    if (settings.permission_mode !== undefined) {
      fields.push("permission_mode = ?");
      values.push(settings.permission_mode);
    }
    if (fields.length === 0) return false;

    const now = new Date().toISOString();
    fields.push("updated_at = ?");
    values.push(now);

    const result = this.db
      .prepare(`UPDATE threads SET ${fields.join(", ")} WHERE id = ?`)
      .run(...values, id);
    return result.changes > 0;
  }

  /** Update a thread's display title. Returns true if a row was changed. */
  updateTitle(id: string, title: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare("UPDATE threads SET title = ?, updated_at = ? WHERE id = ?")
      .run(title, now, id);

    return result.changes > 0;
  }
}
