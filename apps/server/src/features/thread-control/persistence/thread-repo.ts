/**
 * Thread data access layer.
 * Provides CRUD and lifecycle operations for thread records in SQLite.
 */

import { randomUUID } from "crypto";
import { injectable, inject } from "tsyringe";
import type Database from "better-sqlite3";
import { ReasoningLevelSchema } from "@mcode/contracts";
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
  user_completed_at: string | null;
  scheduled_deletion_at: string | null;
  cleanup_state: string | null;
  cleanup_reason: string | null;
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

function canonicalChildVisibilityClause(alias: string): string {
  return `NOT EXISTS (
    SELECT 1
    FROM canonical_agent_threads canonical_child
    WHERE canonical_child.id = ${alias}.id
      AND canonical_child.parent_thread_id IS NOT NULL
  )`;
}

const CANONICAL_CHILD_DELETE_BATCH_SIZE = 64;

/** Persisted delegation provenance attached to a destination thread. */
export interface ThreadDelegationLineageRecord {
  coordinatorThreadId: string | null;
  creatorTurnId: string | null;
  creatorToolCallId: string | null;
  creationKind: "thread_delegation" | null;
}

/** Normalizes legacy reasoning values and rejects corrupted persisted state at the DB boundary. */
function parseStoredReasoningLevel(value: string | null): ReasoningLevel | null {
  if (value === null) return null;
  const parsed = ReasoningLevelSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const CLEANUP_STATES = new Set(["queued", "running", "retrying", "blocked"]);

function parseCleanupState(value: string | null): Thread["cleanup_state"] {
  return CLEANUP_STATES.has(value ?? "")
    ? value as NonNullable<Thread["cleanup_state"]>
    : null;
}

function rowToThread(row: ThreadRow): Thread {
  return {
    ...rowToThreadIdentity(row),
    ...rowToThreadLifecycle(row),
    ...rowToThreadPreferences(row),
    ...rowToThreadProviderSettings(row),
  };
}

function rowToThreadIdentity(row: ThreadRow): Pick<Thread,
  "id" | "workspace_id" | "title" | "status" | "mode" | "worktree_path" | "branch"
  | "checkout_state" | "base_branch" | "worktree_managed" | "issue_number" | "pr_number"
  | "pr_status" | "sdk_session_id" | "model" | "provider" | "created_at" | "updated_at"
> {
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
  };
}

function rowToThreadLifecycle(row: ThreadRow): Pick<Thread,
  "deleted_at" | "user_completed_at" | "scheduled_deletion_at" | "cleanup_state" | "cleanup_reason"
  | "last_context_tokens" | "context_window" | "parent_thread_id" | "forked_from_message_id"
  | "last_compact_summary" | "has_file_changes"
> {
  return {
    deleted_at: row.deleted_at,
    user_completed_at: row.user_completed_at,
    scheduled_deletion_at: row.scheduled_deletion_at,
    cleanup_state: parseCleanupState(row.cleanup_state),
    cleanup_reason: row.cleanup_reason,
    last_context_tokens: row.last_context_tokens ?? null,
    context_window: row.context_window ?? null,
    parent_thread_id: row.parent_thread_id,
    forked_from_message_id: row.forked_from_message_id,
    last_compact_summary: row.last_compact_summary,
    has_file_changes: row.has_file_changes === 1,
  };
}

function rowToThreadPreferences(row: ThreadRow): Pick<Thread,
  "reasoning_level" | "interaction_mode" | "orchestration_mode" | "permission_mode" | "context_window_mode"
> {
  return {
    reasoning_level: parseStoredReasoningLevel(row.reasoning_level),
    interaction_mode: (row.interaction_mode ?? null) as InteractionMode | null,
    orchestration_mode: (row.orchestration_mode ?? null) as OrchestrationMode | null,
    permission_mode: (row.permission_mode ?? null) as PermissionMode | null,
    context_window_mode:
      (row.context_window_mode ?? null) as ContextWindowMode | null,
  };
}

function rowToThreadProviderSettings(row: ThreadRow): Pick<Thread,
  "thinking" | "codex_fast_mode" | "copilot_agent" | "default_open_in_app"
> {
  return {
    thinking: row.thinking == null ? null : row.thinking === 1,
    codex_fast_mode:
      row.codex_fast_mode == null ? null : row.codex_fast_mode === 1,
    copilot_agent: (row.copilot_agent ?? null) as string | null,
    default_open_in_app: row.default_open_in_app ?? null,
  };
}

const THREAD_COLUMNS =
  "id, workspace_id, title, status, mode, worktree_path, branch, checkout_state, base_branch, worktree_managed, issue_number, pr_number, pr_status, sdk_session_id, model, provider, created_at, updated_at, deleted_at, user_completed_at, scheduled_deletion_at, cleanup_state, cleanup_reason, last_context_tokens, context_window, reasoning_level, interaction_mode, orchestration_mode, permission_mode, context_window_mode, thinking, codex_fast_mode, copilot_agent, default_open_in_app, parent_thread_id, forked_from_message_id, last_compact_summary, has_file_changes";

type ThreadCreateLineage = {
  parentThreadId: string;
  forkedFromMessageId: string;
};

type ThreadCreateRecordInput = {
  id: string;
  workspaceId: string;
  title: string;
  mode: ThreadMode;
  branch: string;
  worktreeManaged: boolean;
  provider: string;
  lineage: ThreadCreateLineage | undefined;
  checkoutState: "named" | "branchless";
  baseBranch: string | null;
  now: string;
};

function createThreadRecord(input: ThreadCreateRecordInput): Thread {
  return {
    id: input.id,
    workspace_id: input.workspaceId,
    title: input.title,
    status: "active",
    mode: input.mode,
    worktree_path: null,
    branch: input.branch,
    checkout_state: input.checkoutState,
    base_branch: input.baseBranch,
    worktree_managed: input.worktreeManaged,
    issue_number: null,
    pr_number: null,
    pr_status: null,
    sdk_session_id: null,
    model: null,
    provider: input.provider,
    created_at: input.now,
    updated_at: input.now,
    deleted_at: null,
    user_completed_at: null,
    scheduled_deletion_at: null,
    cleanup_state: null,
    cleanup_reason: null,
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
    parent_thread_id: input.lineage?.parentThreadId ?? null,
    forked_from_message_id: input.lineage?.forkedFromMessageId ?? null,
    last_compact_summary: null,
    has_file_changes: false,
  };
}

type ThreadSearchOptions = {
  query: string;
  filters?: { status?: string[]; provider?: string[] };
  workspaceIds?: string[];
  excludeThreadId?: string;
  createdByIntegrationId?: string;
  sort?: { field: "updated_at" | "created_at" | "title"; direction: "asc" | "desc" };
  limit?: number;
};

function appendSearchQuery(conditions: string[], params: unknown[], query: string): void {
  if (!query) return;
  const escapedQuery = query.replace(/[%_]/g, "\\$&");
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

function appendArraySearchFilter(
  conditions: string[],
  params: unknown[],
  column: "status" | "provider" | "workspace_id",
  values: string[] | undefined,
): void {
  if (!values?.length) return;
  const placeholders = values.map(() => "?").join(", ");
  conditions.push(`t.${column} IN (${placeholders})`);
  params.push(...values);
}

function appendSearchValue(
  conditions: string[],
  params: unknown[],
  condition: string,
  value: string | undefined,
): void {
  if (value === undefined) return;
  conditions.push(condition);
  params.push(value);
}

function resolveSearchOrder(sort: ThreadSearchOptions["sort"]): string {
  const sortField = sort?.field ?? "updated_at";
  const sortDirection = sort?.direction ?? "desc";
  const validFields = new Set(["updated_at", "created_at", "title"]);
  const validDirections = new Set(["asc", "desc"]);
  if (!validFields.has(sortField) || !validDirections.has(sortDirection)) {
    throw new Error(`Invalid sort parameters: ${sortField} ${sortDirection}`);
  }
  return sortField === "updated_at" && sortDirection === "desc"
    ? "t.updated_at DESC, t.id ASC"
    : `t.${sortField} ${sortDirection.toUpperCase()}`;
}

function createSearchResult(
  rows: Array<ThreadRow & { w_id: string; w_name: string; w_path: string }>,
): { threads: Thread[]; workspaces: { id: string; name: string; path: string }[] } {
  const workspaceMap = new Map<string, { id: string; name: string; path: string }>();
  for (const row of rows) {
    if (!workspaceMap.has(row.w_id)) {
      workspaceMap.set(row.w_id, { id: row.w_id, name: row.w_name, path: row.w_path });
    }
  }
  return { threads: rows.map(rowToThread), workspaces: [...workspaceMap.values()] };
}

function resolveNextBaseBranch(
  current: Thread,
  checkoutState: "named" | "branchless",
  baseBranch: string | null,
): string | null {
  return checkoutState === "named" && current.checkout_state === "branchless" && baseBranch === null
    ? current.base_branch
    : baseBranch;
}

function appendThreadSetting<T>(
  fields: string[],
  values: unknown[],
  column: string,
  value: T | undefined,
  serialize: (value: T) => unknown = (entry) => entry,
): void {
  if (value === undefined) return;
  fields.push(`${column} = ?`);
  values.push(serialize(value));
}

function serializeBooleanOverride(value: boolean | null): number | null {
  return value == null ? null : value ? 1 : 0;
}

/** Maximum active sibling paths considered during one worktree ownership decision. */
export const MAX_ACTIVE_WORKTREE_OWNERSHIP_PATHS = 512;

/** Bounded active sibling paths used for canonical filesystem identity checks. */
export interface ActiveWorktreePathSet {
  paths: string[];
  truncated: boolean;
}

/** Completion timestamps used to calculate retention deadlines. */
export interface CompletedThreadRetentionRecord {
  id: string;
  userCompletedAt: string;
  scheduledDeletionAt: string | null;
}

/** Compare-and-set update for one completed thread's deletion deadline. */
export interface CompletedThreadDeadlineUpdate extends CompletedThreadRetentionRecord {
  nextScheduledDeletionAt: string | null;
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

    return createThreadRecord({
      id,
      workspaceId,
      title,
      mode,
      branch,
      worktreeManaged,
      provider,
      lineage,
      checkoutState,
      baseBranch,
      now,
    });
  }

  /** Find a thread by its primary key, optionally constrained to one external owner. */
  findById(id: string, options: { createdByIntegrationId?: string } = {}): Thread | null {
    const ownershipClause = options.createdByIntegrationId === undefined
      ? ""
      : " AND created_by_integration_id = ?";
    const row = this.db
      .prepare(`SELECT ${THREAD_COLUMNS} FROM threads WHERE id = ?${ownershipClause}`)
      .get(id, ...(options.createdByIntegrationId === undefined ? [] : [options.createdByIntegrationId])) as ThreadRow | undefined;

    return row ? rowToThread(row) : null;
  }

  /** List non-deleted threads for a workspace, most recent first. */
  listByWorkspace(workspaceId: string, limit = 100): Thread[] {
    const clampedLimit = Math.max(1, Math.min(1000, limit));

    const rows = this.db
      .prepare(
        `SELECT ${THREAD_COLUMNS} FROM threads
         WHERE workspace_id = ?
           AND deleted_at IS NULL
           AND ${canonicalChildVisibilityClause("threads")}
         ORDER BY created_at DESC LIMIT ?`,
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
           AND t.user_completed_at IS NULL
           AND ${canonicalChildVisibilityClause("t")}
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
  search(opts: ThreadSearchOptions): { threads: Thread[]; workspaces: { id: string; name: string; path: string }[] } {
    const clampedLimit = Math.max(1, Math.min(200, opts.limit ?? 100));
    const conditions: string[] = [
      "t.deleted_at IS NULL",
      "w.deleted_at IS NULL",
      canonicalChildVisibilityClause("t"),
    ];
    const params: unknown[] = [];

    appendSearchQuery(conditions, params, opts.query);
    appendArraySearchFilter(conditions, params, "status", opts.filters?.status);
    appendArraySearchFilter(conditions, params, "provider", opts.filters?.provider);
    appendArraySearchFilter(conditions, params, "workspace_id", opts.workspaceIds);
    if (opts.excludeThreadId) appendSearchValue(conditions, params, "t.id != ?", opts.excludeThreadId);
    appendSearchValue(conditions, params, "t.created_by_integration_id = ?", opts.createdByIntegrationId);

    const orderBy = resolveSearchOrder(opts.sort);

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

    return createSearchResult(rows);
  }

  /** Update a thread's lifecycle status. Returns true if a row was changed. */
  updateStatus(id: string, status: ThreadStatus): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare("UPDATE threads SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, now, id);

    return result.changes > 0;
  }

  /** Persist the first user-completion timestamp and its deletion deadline. */
  complete(id: string, completedAt: string, scheduledDeletionAt: string | null): Thread | null {
    this.db.prepare(
      `UPDATE threads
       SET user_completed_at = COALESCE(user_completed_at, ?),
           scheduled_deletion_at = CASE
             WHEN user_completed_at IS NULL THEN ?
             ELSE scheduled_deletion_at
           END,
           updated_at = CASE WHEN user_completed_at IS NULL THEN ? ELSE updated_at END
       WHERE id = ? AND deleted_at IS NULL`,
    ).run(completedAt, scheduledDeletionAt, completedAt, id);
    return this.findById(id);
  }

  /** List one bounded page of completed threads for retention-policy calculation. */
  listCompletedRetentionRecords(
    afterId: string | null = null,
    limit = 100,
  ): CompletedThreadRetentionRecord[] {
    const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const rows = this.db.prepare(
      `SELECT id, user_completed_at, scheduled_deletion_at
       FROM threads
       WHERE user_completed_at IS NOT NULL
         AND deleted_at IS NULL
         AND (? IS NULL OR id > ?)
       ORDER BY id
       LIMIT ?`,
    ).all(afterId, afterId, boundedLimit) as Array<{
      id: string;
      user_completed_at: string;
      scheduled_deletion_at: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      userCompletedAt: row.user_completed_at,
      scheduledDeletionAt: row.scheduled_deletion_at,
    }));
  }

  /** Apply deadline changes only while each completion record still matches its source state. */
  updateCompletedThreadDeadlines(updates: readonly CompletedThreadDeadlineUpdate[]): Thread[] {
    if (updates.length === 0) return [];
    const update = this.db.prepare(
      `UPDATE threads
       SET scheduled_deletion_at = ?,
           cleanup_state = CASE WHEN cleanup_state = 'blocked' THEN 'blocked' ELSE NULL END,
           cleanup_reason = CASE WHEN cleanup_state = 'blocked' THEN cleanup_reason ELSE NULL END
       WHERE id = ?
         AND user_completed_at = ?
         AND scheduled_deletion_at IS ?
         AND deleted_at IS NULL
         AND cleanup_state IS NOT 'running'`,
    );
    const apply = this.db.transaction(() => {
      const changedIds: string[] = [];
      for (const entry of updates) {
        const result = update.run(
          entry.nextScheduledDeletionAt,
          entry.id,
          entry.userCompletedAt,
          entry.scheduledDeletionAt,
        );
        if (result.changes > 0) changedIds.push(entry.id);
      }
      for (const id of changedIds) {
        this.db.prepare(
          "DELETE FROM cleanup_jobs WHERE thread_id = ? AND kind = 'retention'",
        ).run(id);
      }
      return changedIds;
    });
    return apply()
      .map((id) => this.findById(id))
      .filter((thread): thread is Thread => thread !== null);
  }

  /** Clear user-completion metadata in one transaction-safe statement. */
  reopen(id: string, reopenedAt = new Date().toISOString()): Thread | null {
    return this.db.transaction(() => {
      const result = this.db.prepare(
        `UPDATE threads
         SET user_completed_at = NULL,
             scheduled_deletion_at = NULL,
             cleanup_state = NULL,
             cleanup_reason = NULL,
             updated_at = CASE WHEN user_completed_at IS NULL THEN updated_at ELSE ? END
         WHERE id = ?
           AND deleted_at IS NULL
           AND cleanup_state IS NOT 'running'
           AND NOT (
             cleanup_state = 'blocked'
             AND EXISTS (
               SELECT 1 FROM cleanup_jobs
               WHERE cleanup_jobs.thread_id = threads.id
                 AND cleanup_jobs.kind = 'retention'
             )
           )`,
      ).run(reopenedAt, id);
      if (result.changes === 0) return null;
      this.db.prepare("DELETE FROM cleanup_jobs WHERE thread_id = ? AND kind = 'retention'").run(id);
      return this.findById(id);
    })();
  }

  /** Claim one queued retention cleanup immediately before destructive work starts. */
  claimRetentionCleanup(id: string, nowIso: string): Thread | null {
    const result = this.db.prepare(
      `UPDATE threads
       SET cleanup_state = 'running', cleanup_reason = NULL
       WHERE id = ?
         AND deleted_at IS NULL
         AND user_completed_at IS NOT NULL
         AND scheduled_deletion_at IS NOT NULL
         AND scheduled_deletion_at <= ?
         AND cleanup_state IN ('queued', 'retrying', 'running')`,
    ).run(id, nowIso);
    return result.changes > 0 ? this.findById(id) : null;
  }

  /** Clear a stale queued state after its deadline or completion state changed. */
  releaseRetentionCleanup(id: string): void {
    this.db.prepare(
      `UPDATE threads
       SET cleanup_state = NULL, cleanup_reason = NULL
       WHERE id = ? AND cleanup_state IN ('queued', 'retrying')`,
    ).run(id);
  }

  /** Persist a user-safe terminal reason while retaining the completed thread. */
  blockRetentionCleanup(id: string, reason: string): Thread | null {
    this.db.prepare(
      `UPDATE threads
       SET cleanup_state = 'blocked', cleanup_reason = ?
       WHERE id = ? AND deleted_at IS NULL AND user_completed_at IS NOT NULL`,
    ).run(reason.slice(0, 240), id);
    return this.findById(id);
  }

  /** Return a failed retention cleanup to the persisted retry queue. */
  retryRetentionCleanup(id: string, reason: string): Thread | null {
    this.db.prepare(
      `UPDATE threads
       SET cleanup_state = CASE
             WHEN cleanup_state = 'running' THEN 'running'
             ELSE 'retrying'
           END,
           cleanup_reason = ?
       WHERE id = ? AND deleted_at IS NULL AND user_completed_at IS NOT NULL`,
    ).run(reason.slice(0, 240), id);
    return this.findById(id);
  }

  /** Check whether blocked finalization still owns a persisted retention job. */
  hasRetentionCleanupJob(id: string): boolean {
    const row = this.db.prepare(
      "SELECT 1 AS found FROM cleanup_jobs WHERE thread_id = ? AND kind = 'retention' LIMIT 1",
    ).get(id) as { found: number } | undefined;
    return row?.found === 1;
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

  /** Clear a thread's persisted worktree path after its managed checkout is removed. */
  clearWorktreePath(id: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare("UPDATE threads SET worktree_path = NULL, updated_at = ? WHERE id = ?")
      .run(now, id);

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
    const nextBaseBranch = resolveNextBaseBranch(current, checkoutState, baseBranch);
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
        this.db.prepare(
          "UPDATE threads SET delegation_coordinator_thread_id = NULL, updated_at = ? WHERE delegation_coordinator_thread_id = ? AND workspace_id != (SELECT workspace_id FROM threads WHERE id = ?)",
        ).run(now, id, id);
      }
      return result.changes > 0;
    })();
  }

  /** Permanently remove a thread record from the database. */
  hardDelete(id: string): boolean {
    return this.db.transaction(() => {
      this.db.exec(`
        DROP TABLE IF EXISTS canonical_thread_delete_queue;
        CREATE TEMP TABLE canonical_thread_delete_queue (
          id TEXT PRIMARY KEY NOT NULL,
          child_cursor TEXT
        )
      `);
      const enqueue = this.db.prepare(
        "INSERT OR IGNORE INTO canonical_thread_delete_queue (id, child_cursor) VALUES (?, NULL)",
      );
      enqueue.run(id);
      const selectBatch = this.db.prepare(`
        SELECT id, child_cursor
        FROM canonical_thread_delete_queue
        ORDER BY id
        LIMIT ?
      `);
      const selectChildren = this.db.prepare(`
        SELECT id
        FROM threads
        WHERE parent_thread_id = ?
          AND (? IS NULL OR id > ?)
        ORDER BY id
        LIMIT ?
      `);
      const deleteActions = this.db.prepare(`
        DELETE FROM canonical_collaboration_actions
        WHERE source_thread_id = ? OR target_thread_id = ?
      `);
      const deleteThread = this.db.prepare("DELETE FROM threads WHERE id = ?");
      const dequeue = this.db.prepare("DELETE FROM canonical_thread_delete_queue WHERE id = ?");
      const updateCursor = this.db.prepare(
        "UPDATE canonical_thread_delete_queue SET child_cursor = ? WHERE id = ?",
      );
      let deletedRoot = false;
      while (true) {
        const batch = selectBatch.all(CANONICAL_CHILD_DELETE_BATCH_SIZE) as Array<{
          id: string;
          child_cursor: string | null;
        }>;
        if (batch.length === 0) break;
        for (const row of batch) {
          const children = selectChildren.all(
            row.id,
            row.child_cursor,
            row.child_cursor,
            CANONICAL_CHILD_DELETE_BATCH_SIZE,
          ) as Array<{ id: string }>;
          for (const child of children) enqueue.run(child.id);
          if (children.length === CANONICAL_CHILD_DELETE_BATCH_SIZE) {
            updateCursor.run(children[children.length - 1]!.id, row.id);
            continue;
          }
          deleteActions.run(row.id, row.id);
          const result = deleteThread.run(row.id);
          deletedRoot ||= row.id === id && result.changes > 0;
          dequeue.run(row.id);
        }
      }
      return deletedRoot;
    })();
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
    appendThreadSetting(fields, values, "reasoning_level", settings.reasoning_level);
    appendThreadSetting(fields, values, "interaction_mode", settings.interaction_mode);
    appendThreadSetting(fields, values, "orchestration_mode", settings.orchestration_mode);
    appendThreadSetting(fields, values, "permission_mode", settings.permission_mode);
    appendThreadSetting(fields, values, "context_window_mode", settings.context_window_mode);
    appendThreadSetting(fields, values, "thinking", settings.thinking, serializeBooleanOverride);
    appendThreadSetting(fields, values, "codex_fast_mode", settings.codex_fast_mode, serializeBooleanOverride);
    appendThreadSetting(fields, values, "copilot_agent", settings.copilot_agent);
    appendThreadSetting(fields, values, "default_open_in_app", settings.default_open_in_app);
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
       WHERE workspace_id IN (${placeholders})
         AND deleted_at IS NULL
         AND user_completed_at IS NULL
         AND ${canonicalChildVisibilityClause("threads")}
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

  /** Persist delegation provenance after a delegated thread is created. */
  updateDelegationLineage(
    id: string,
    lineage: {
      coordinatorThreadId: string;
      creatorTurnId: string;
      creatorToolCallId: string;
      creationKind: "thread_delegation";
      integrationId?: string;
    },
  ): boolean {
    const result = this.db
      .prepare(
        "UPDATE threads SET delegation_coordinator_thread_id = ?, delegation_creator_turn_id = ?, delegation_creator_tool_call_id = ?, delegation_creation_kind = ?, created_by_integration_id = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        lineage.coordinatorThreadId,
        lineage.creatorTurnId,
        lineage.creatorToolCallId,
        lineage.creationKind,
        lineage.integrationId ?? null,
        new Date().toISOString(),
        id,
      );
    return result.changes > 0;
  }

  /** Read persisted delegation provenance without exposing raw database columns. */
  findDelegationLineage(id: string): ThreadDelegationLineageRecord | null {
    const row = this.db.prepare(
      "SELECT delegation_coordinator_thread_id, delegation_creator_turn_id, delegation_creator_tool_call_id, delegation_creation_kind FROM threads WHERE id = ?",
    ).get(id) as {
      delegation_coordinator_thread_id: string | null;
      delegation_creator_turn_id: string | null;
      delegation_creator_tool_call_id: string | null;
      delegation_creation_kind: string | null;
    } | undefined;
    if (!row) return null;
    return {
      coordinatorThreadId: row.delegation_coordinator_thread_id,
      creatorTurnId: row.delegation_creator_turn_id,
      creatorToolCallId: row.delegation_creator_tool_call_id,
      creationKind: row.delegation_creation_kind === "thread_delegation" ? "thread_delegation" : null,
    };
  }

  /** List non-deleted delegated children for one coordinator thread. */
  listDelegationChildren(coordinatorThreadId: string): Array<{
    thread: Thread;
    lineage: ThreadDelegationLineageRecord;
  }> {
    const rows = this.db.prepare(
      `SELECT ${THREAD_COLUMNS},
              t.delegation_coordinator_thread_id,
              t.delegation_creator_turn_id,
              t.delegation_creator_tool_call_id,
              t.delegation_creation_kind
       FROM threads t
       WHERE t.deleted_at IS NULL AND t.delegation_coordinator_thread_id = ?
       ORDER BY t.updated_at DESC, t.id ASC`,
    ).all(coordinatorThreadId) as Array<ThreadRow & {
      delegation_coordinator_thread_id: string | null;
      delegation_creator_turn_id: string | null;
      delegation_creator_tool_call_id: string | null;
      delegation_creation_kind: string | null;
    }>;
    return rows.flatMap((row) => {
      if (
        row.delegation_creation_kind !== "thread_delegation"
        || !row.delegation_coordinator_thread_id
        || !row.delegation_creator_turn_id
        || !row.delegation_creator_tool_call_id
      ) return [];
      return [{
        thread: rowToThread(row),
        lineage: {
          coordinatorThreadId: row.delegation_coordinator_thread_id,
          creatorTurnId: row.delegation_creator_turn_id,
          creatorToolCallId: row.delegation_creator_tool_call_id,
          creationKind: "thread_delegation" as const,
        },
      }];
    });
  }

  /** Persist ownership for a thread created by a paired external integration. */
  updateExternalCreator(id: string, integrationId: string): boolean {
    return this.db.prepare(
      "UPDATE threads SET created_by_integration_id = ?, updated_at = ? WHERE id = ?",
    ).run(integrationId, new Date().toISOString(), id).changes > 0;
  }

  /** Count active capacity owned by one paired external integration. */
  countActiveByIntegration(integrationId: string): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS count
       FROM threads
       WHERE created_by_integration_id = ?
         AND deleted_at IS NULL
         AND status IN ('active', 'paused')
         AND ${canonicalChildVisibilityClause("threads")}`,
    ).get(integrationId) as { count: number };
    return row.count;
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
        `UPDATE threads SET parent_thread_id = NULL, forked_from_message_id = NULL, delegation_coordinator_thread_id = NULL, updated_at = ?
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
         AND deleted_at IS NULL
         AND ${canonicalChildVisibilityClause("threads")}`,
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
