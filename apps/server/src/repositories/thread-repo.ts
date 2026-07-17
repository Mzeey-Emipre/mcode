/**
 * Thread data access layer.
 * Provides CRUD and lifecycle operations for thread records in SQLite.
 */

import { randomUUID } from "crypto";
import { injectable, inject } from "tsyringe";
import type Database from "better-sqlite3";
import type { Thread, RecentThread, ThreadMode, ThreadStatus, ReasoningLevel, InteractionMode, OrchestrationMode, PermissionMode, ContextWindowMode } from "@mcode/contracts";

interface ThreadRow {
  id: string;
  workspace_id: string;
  title: string;
  status: string;
  mode: string;
  worktree_path: string | null;
  branch: string;
  checkout_state: string;
  base_branch: string | null;
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
  orchestration_mode: string | null;
  permission_mode: string | null;
  context_window_mode: string | null;
    thinking: number | null;
    codex_fast_mode: number | null;
    copilot_agent: string | null;
  default_open_in_app: string | null;
  parent_thread_id: string | null;
  forked_from_message_id: string | null;
  last_compact_summary: string | null;
  has_file_changes: number;
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
    checkout_state: row.checkout_state === "branchless" ? "branchless" : "named",
    base_branch: row.base_branch ?? null,
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
    orchestration_mode: (row.orchestration_mode ?? null) as OrchestrationMode | null,
    permission_mode: (row.permission_mode ?? null) as PermissionMode | null,
    context_window_mode:
      (row.context_window_mode ?? null) as ContextWindowMode | null,
    thinking: row.thinking == null ? null : row.thinking === 1,
    codex_fast_mode:
      row.codex_fast_mode == null ? null : row.codex_fast_mode === 1,
    copilot_agent: (row.copilot_agent ?? null) as string | null,
    default_open_in_app: row.default_open_in_app ?? null,
    parent_thread_id: row.parent_thread_id,
    forked_from_message_id: row.forked_from_message_id,
    last_compact_summary: row.last_compact_summary,
    has_file_changes: row.has_file_changes === 1,
  };
}

const THREAD_COLUMNS =
  "id, workspace_id, title, status, mode, worktree_path, branch, checkout_state, base_branch, worktree_managed, issue_number, pr_number, pr_status, sdk_session_id, model, provider, created_at, updated_at, deleted_at, last_context_tokens, context_window, reasoning_level, interaction_mode, orchestration_mode, permission_mode, context_window_mode, thinking, codex_fast_mode, copilot_agent, default_open_in_app, parent_thread_id, forked_from_message_id, last_compact_summary, has_file_changes";

/** Maximum active sibling paths considered during one worktree ownership decision. */
export const MAX_ACTIVE_WORKTREE_OWNERSHIP_PATHS = 512;

/** Bounded active sibling paths used for canonical filesystem identity checks. */
export interface ActiveWorktreePathSet {
  paths: string[];
  truncated: boolean;
}

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
    lineage?: {
      parentThreadId: string;
      forkedFromMessageId: string;
    },
    checkoutState: "named" | "branchless" = "named",
    baseBranch: string | null = null,
  ): Thread {
    const id = randomUUID();
    const now = new Date().toISOString();
    const managedInt = worktreeManaged ? 1 : 0;

    this.db
      .prepare(
        "INSERT INTO threads (id, workspace_id, title, status, mode, branch, checkout_state, base_branch, worktree_managed, provider, parent_thread_id, forked_from_message_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        workspaceId,
        title,
        "active",
        mode,
        branch,
        checkoutState,
        baseBranch,
        managedInt,
        provider,
        lineage?.parentThreadId ?? null,
        lineage?.forkedFromMessageId ?? null,
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
      checkout_state: checkoutState,
      base_branch: baseBranch,
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
      orchestration_mode: null,
      permission_mode: null,
      context_window_mode: null,
      thinking: null,
      codex_fast_mode: null,
      copilot_agent: null,
      default_open_in_app: null,
      parent_thread_id: lineage?.parentThreadId ?? null,
      forked_from_message_id: lineage?.forkedFromMessageId ?? null,
      last_compact_summary: null,
      has_file_changes: false,
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

  /**
   * List the most recently active non-deleted threads across all workspaces,
   * joined with the parent workspace's name + path. Used by the landing's
   * "Recent threads" section to surface continuation candidates regardless of
   * which workspace is currently active.
   *
   * Sorted by `updated_at` (last activity), not `created_at`, so a long-lived
   * thread with recent traffic outranks a freshly-created idle one.
   */
  listRecent(limit = 12): RecentThread[] {
    const clampedLimit = Math.max(1, Math.min(50, limit));

    const rows = this.db
      .prepare(
        `SELECT ${THREAD_COLUMNS.split(", ").map((c) => `t.${c}`).join(", ")},
                w.name AS workspace_name, w.path AS workspace_path
         FROM threads t
         JOIN workspaces w ON w.id = t.workspace_id
         WHERE t.deleted_at IS NULL
         ORDER BY t.updated_at DESC
         LIMIT ?`,
      )
      .all(clampedLimit) as Array<ThreadRow & { workspace_name: string; workspace_path: string }>;

    return rows.map((row) => ({
      ...rowToThread(row),
      workspace_name: row.workspace_name,
      workspace_path: row.workspace_path,
    }));
  }

  /** Search non-deleted threads across title, project, provider, and checkout metadata. */
  search(opts: {
    query: string;
    filters?: { status?: string[]; provider?: string[] };
    sort?: { field: "updated_at" | "created_at" | "title"; direction: "asc" | "desc" };
    limit?: number;
  }): { threads: Thread[]; workspaces: { id: string; name: string; path: string }[] } {
    const clampedLimit = Math.max(1, Math.min(200, opts.limit ?? 100));
    const conditions: string[] = ["t.deleted_at IS NULL"];
    const params: unknown[] = [];

    if (opts.query) {
      const escapedQuery = opts.query.replace(/[%_]/g, "\\$&");
      const pattern = `%${escapedQuery}%`;
      conditions.push(`(
        t.title LIKE ? ESCAPE '\\' COLLATE NOCASE OR
        w.name LIKE ? ESCAPE '\\' COLLATE NOCASE OR
        w.path LIKE ? ESCAPE '\\' COLLATE NOCASE OR
        t.provider LIKE ? ESCAPE '\\' COLLATE NOCASE OR
        t.branch LIKE ? ESCAPE '\\' COLLATE NOCASE OR
        COALESCE(t.worktree_path, '') LIKE ? ESCAPE '\\' COLLATE NOCASE
      )`);
      params.push(pattern, pattern, pattern, pattern, pattern, pattern);
    }

    if (opts.filters?.status?.length) {
      const placeholders = opts.filters.status.map(() => "?").join(", ");
      conditions.push(`t.status IN (${placeholders})`);
      params.push(...opts.filters.status);
    }

    if (opts.filters?.provider?.length) {
      const placeholders = opts.filters.provider.map(() => "?").join(", ");
      conditions.push(`t.provider IN (${placeholders})`);
      params.push(...opts.filters.provider);
    }

    const sortField = opts.sort?.field ?? "updated_at";
    const sortDir = opts.sort?.direction ?? "desc";
    const ALLOWED_SORT_FIELDS = new Set(["updated_at", "created_at", "title"]);
    const ALLOWED_SORT_DIRS = new Set(["asc", "desc"]);
    if (!ALLOWED_SORT_FIELDS.has(sortField) || !ALLOWED_SORT_DIRS.has(sortDir)) {
      throw new Error(`Invalid sort parameters: ${sortField} ${sortDir}`);
    }
    const orderBy = `t.${sortField} ${sortDir.toUpperCase()}`;

    const threadCols = THREAD_COLUMNS.split(", ").map((c) => `t.${c}`).join(", ");
    const sql = `
      SELECT ${threadCols}, w.id AS w_id, w.name AS w_name, w.path AS w_path
      FROM threads t
      JOIN workspaces w ON w.id = t.workspace_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY ${orderBy}
      LIMIT ?
    `;
    params.push(clampedLimit);

    const rows = this.db.prepare(sql).all(...params) as Array<
      ThreadRow & { w_id: string; w_name: string; w_path: string }
    >;

    const threads = rows.map((row) => rowToThread(row));
    const workspaceMap = new Map<string, { id: string; name: string; path: string }>();
    for (const row of rows) {
      if (!workspaceMap.has(row.w_id)) {
        workspaceMap.set(row.w_id, { id: row.w_id, name: row.w_name, path: row.w_path });
      }
    }

    return { threads, workspaces: [...workspaceMap.values()] };
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

  /** Mark a thread as a named-branch checkout after creating a branch in place. */
  updateCheckoutToNamedBranch(id: string, branch: string): Thread | null {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        "UPDATE threads SET branch = ?, checkout_state = 'named', updated_at = ? WHERE id = ?",
      )
      .run(branch, now, id);
    if (result.changes === 0) return null;
    return this.findById(id);
  }

  /**
   * Persist an externally observed checkout state for a worktree thread.
   * Clears stale PR metadata only when the branch or checkout discriminator changed.
   */
  updateCheckoutFromHead(
    id: string,
    branch: string,
    checkoutState: "named" | "branchless",
    baseBranch: string | null,
  ): { thread: Thread; changed: boolean } | null {
    const current = this.findById(id);
    if (!current) return null;

    const changed =
      current.branch !== branch || current.checkout_state !== checkoutState;
    const nextBaseBranch =
      checkoutState === "named" && current.checkout_state === "branchless" && baseBranch === null
        ? current.base_branch
        : baseBranch;
    if (
      !changed &&
      current.base_branch === nextBaseBranch
    ) {
      return { thread: current, changed: false };
    }

    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE threads
         SET branch = ?,
             checkout_state = ?,
             base_branch = ?,
             pr_number = CASE WHEN ? THEN NULL ELSE pr_number END,
             pr_status = CASE WHEN ? THEN NULL ELSE pr_status END,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(branch, checkoutState, nextBaseBranch, changed ? 1 : 0, changed ? 1 : 0, now, id);

    const thread = this.findById(id);
    return thread ? { thread, changed } : null;
  }

  /** Soft-delete a thread by setting deleted_at and status to "deleted". */
  softDelete(id: string): boolean {
    const now = new Date().toISOString();
    return this.db.transaction(() => {
      const result = this.db
        .prepare(
          "UPDATE threads SET deleted_at = ?, status = ?, updated_at = ? WHERE id = ?",
        )
        .run(now, "deleted", now, id);
      if (result.changes > 0) {
        this.db.prepare(
          "UPDATE pull_request_review_links SET primary_thread_id = NULL, updated_at = ? WHERE primary_thread_id = ?",
        ).run(now, id);
      }
      return result.changes > 0;
    })();
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

  /** Persist the latest context window usage for a thread.
   * Always updates last_context_tokens. Only updates context_window when provided. */
  updateContextUsage(id: string, lastContextTokens: number, contextWindow?: number): boolean {
    const now = new Date().toISOString();
    if (contextWindow !== undefined) {
      const result = this.db
        .prepare(
          "UPDATE threads SET last_context_tokens = ?, context_window = ?, updated_at = ? WHERE id = ?",
        )
        .run(lastContextTokens, contextWindow, now, id);
      return result.changes > 0;
    }
    const result = this.db
      .prepare(
        "UPDATE threads SET last_context_tokens = ?, updated_at = ? WHERE id = ?",
      )
      .run(lastContextTokens, now, id);
    return result.changes > 0;
  }

  /** Persist per-thread composer settings (reasoning, mode, permission, copilot agent). */
  updateSettings(
    id: string,
    settings: {
      reasoning_level?: string;
      interaction_mode?: string;
      orchestration_mode?: string;
      permission_mode?: string;
      context_window_mode?: ContextWindowMode | null;
      thinking?: boolean | null;
      codex_fast_mode?: boolean | null;
      copilot_agent?: string | null;
      default_open_in_app?: string | null;
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
    if (settings.orchestration_mode !== undefined) {
      fields.push("orchestration_mode = ?");
      values.push(settings.orchestration_mode);
    }
    if (settings.permission_mode !== undefined) {
      fields.push("permission_mode = ?");
      values.push(settings.permission_mode);
    }
    if (settings.context_window_mode !== undefined) {
      fields.push("context_window_mode = ?");
      // null clears the override so the thread inherits from settings.
      values.push(settings.context_window_mode);
    }
    if (settings.thinking !== undefined) {
      fields.push("thinking = ?");
      // SQLite has no native boolean — store 0/1 to match the column convention.
      // null clears the override so the thread inherits from settings.
      values.push(settings.thinking == null ? null : settings.thinking ? 1 : 0);
    }
    if (settings.codex_fast_mode !== undefined) {
      fields.push("codex_fast_mode = ?");
      values.push(
        settings.codex_fast_mode == null ? null : settings.codex_fast_mode ? 1 : 0,
      );
    }
    if (settings.copilot_agent !== undefined) {
      fields.push("copilot_agent = ?");
      values.push(settings.copilot_agent);
    }
    if (settings.default_open_in_app !== undefined) {
      fields.push("default_open_in_app = ?");
      // null clears the override so the thread inherits the global default.
      values.push(settings.default_open_in_app);
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

  /** Persist the latest compaction summary for a thread. Overwrites any previous value. */
  updateCompactSummary(threadId: string, summary: string): void {
    this.db
      .prepare("UPDATE threads SET last_compact_summary = ?, updated_at = ? WHERE id = ?")
      .run(summary, new Date().toISOString(), threadId);
  }

  /**
   * Count active (non-deleted) threads for each workspace id in the list.
   * Returns a Map keyed by workspace id. Workspace ids with no active threads are omitted.
   */
  countActiveByWorkspaceIds(ids: string[]): Map<string, number> {
    if (ids.length === 0) return new Map();
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db.prepare(
      `SELECT workspace_id AS id, COUNT(*) AS n
       FROM threads
       WHERE workspace_id IN (${placeholders}) AND deleted_at IS NULL
       GROUP BY workspace_id`,
    ).all(...ids) as { id: string; n: number }[];
    return new Map(rows.map((r) => [r.id, r.n]));
  }

  /** Set lineage fields on a thread. Used when thread creation is handled by ThreadService. */
  updateLineage(id: string, parentThreadId: string, forkedFromMessageId: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare("UPDATE threads SET parent_thread_id = ?, forked_from_message_id = ?, updated_at = ? WHERE id = ?")
      .run(parentThreadId, forkedFromMessageId, now, id);
    return result.changes > 0;
  }

  /**
   * Find all threads in a workspace that have a worktree_path set (both active and deleted).
   * Used during workspace deletion to know which threads need filesystem cleanup.
   */
  findWorktreeThreadsByWorkspace(workspaceId: string): Thread[] {
    const rows = this.db
      .prepare(
        `SELECT ${THREAD_COLUMNS} FROM threads WHERE workspace_id = ? AND worktree_path IS NOT NULL`,
      )
      .all(workspaceId) as ThreadRow[];
    return rows.map(rowToThread);
  }

  /**
   * List ALL threads for a workspace regardless of deletion status.
   * Used during workspace hard-delete reconciliation.
   */
  listAllByWorkspace(workspaceId: string): Thread[] {
    const rows = this.db
      .prepare(
        `SELECT ${THREAD_COLUMNS} FROM threads WHERE workspace_id = ?`,
      )
      .all(workspaceId) as ThreadRow[];
    return rows.map(rowToThread);
  }

  /**
   * Nullify parent_thread_id and forked_from_message_id on threads in OTHER workspaces
   * that reference threads in the given workspace. Prevents dangling references
   * when a workspace is deleted.
   */
  nullifyExternalLineage(workspaceId: string): number {
    const result = this.db
      .prepare(
        `UPDATE threads SET parent_thread_id = NULL, forked_from_message_id = NULL, updated_at = ?
         WHERE parent_thread_id IN (SELECT id FROM threads WHERE workspace_id = ?)
         AND workspace_id != ?`,
      )
      .run(new Date().toISOString(), workspaceId, workspaceId);
    return result.changes;
  }

  /**
   * Count active (non-deleted) threads on a given branch in the same workspace,
   * excluding a specific thread. Used to decide whether a branch is safe to delete.
   */
  countActiveByBranch(threadId: string, branch: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM threads
         WHERE workspace_id = (SELECT workspace_id FROM threads WHERE id = ?)
         AND branch = ?
         AND id != ?
         AND deleted_at IS NULL`,
      )
      .get(threadId, branch, threadId) as { count: number };
    return row.count;
  }

  /** List bounded active sibling worktree paths for canonical ownership checks. */
  listActiveSiblingWorktreePaths(
    threadId: string,
    limit = MAX_ACTIVE_WORKTREE_OWNERSHIP_PATHS,
  ): ActiveWorktreePathSet {
    const boundedLimit = Math.max(
      1,
      Math.min(MAX_ACTIVE_WORKTREE_OWNERSHIP_PATHS, Math.trunc(limit)),
    );
    const rows = this.db
      .prepare(
        `SELECT worktree_path
         FROM threads
         WHERE workspace_id = (SELECT workspace_id FROM threads WHERE id = ?)
         AND id != ?
         AND deleted_at IS NULL
         AND worktree_path IS NOT NULL
         LIMIT ?`,
      )
      .all(threadId, threadId, boundedLimit + 1) as Array<{ worktree_path: string }>;
    return {
      paths: rows.slice(0, boundedLimit).map((row) => row.worktree_path),
      truncated: rows.length > boundedLimit,
    };
  }
}
