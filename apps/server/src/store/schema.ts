/**
 * Drizzle ORM schema for the Mcode SQLite database (single source of truth).
 * Edit here and run `bun run db:generate` to emit SQL migrations.
 */

import { sql } from "drizzle-orm";
import { asc, desc } from "drizzle-orm";
import { type AnySQLiteColumn, index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const timestampDefault = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

export const workspaces = sqliteTable(
  "workspaces",
  {
    id: text("id").primaryKey().notNull(),
    name: text("name").notNull(),
    path: text("path").notNull().unique(),
    providerConfig: text("provider_config").notNull().default("{}"),
    createdAt: text("created_at").notNull().default(timestampDefault),
    updatedAt: text("updated_at").notNull().default(timestampDefault),
    pinned: integer("pinned").notNull().default(0),
    lastOpenedAt: integer("last_opened_at"),
    sortOrder: integer("sort_order").notNull().default(0),
    isGitRepo: integer("is_git_repo").notNull().default(1),
    deletedAt: text("deleted_at"),
  },
  (table) => [
    index("idx_workspaces_sort_order").on(asc(table.sortOrder)),
    index("idx_workspaces_pinned_last_opened").on(
      desc(table.pinned),
      desc(table.lastOpenedAt),
    ),
  ],
);

export const threads = sqliteTable(
  "threads",
  {
    id: text("id").primaryKey().notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    status: text("status").notNull().default("active"),
    mode: text("mode").notNull().default("direct"),
    worktreePath: text("worktree_path"),
    branch: text("branch").notNull(),
    issueNumber: integer("issue_number"),
    prNumber: integer("pr_number"),
    prStatus: text("pr_status"),
    createdAt: text("created_at").notNull().default(timestampDefault),
    updatedAt: text("updated_at").notNull().default(timestampDefault),
    deletedAt: text("deleted_at"),
    model: text("model"),
    worktreeManaged: integer("worktree_managed").notNull().default(1),
    sdkSessionId: text("sdk_session_id"),
    lastContextTokens: integer("last_context_tokens"),
    contextWindow: integer("context_window"),
    provider: text("provider").notNull().default("claude"),
    reasoningLevel: text("reasoning_level"),
    interactionMode: text("interaction_mode"),
    permissionMode: text("permission_mode"),
    parentThreadId: text("parent_thread_id"),
    forkedFromMessageId: text("forked_from_message_id"),
    lastCompactSummary: text("last_compact_summary"),
    copilotAgent: text("copilot_agent"),
    contextWindowMode: text("context_window_mode"),
    thinking: integer("thinking"),
    /**
     * Codex-only: 1 = request `serviceTier: priority` (the "Fast" tier), 0 = standard, null = inherit global
     * `settings.provider.codex.fastMode`.
     */
    codexFastMode: integer("codex_fast_mode"),
    /** Thread-scoped default open-in app id (ADR-0005 tier 1); null = no override. */
    defaultOpenInApp: text("default_open_in_app"),
    hasFileChanges: integer("has_file_changes").notNull().default(0),
  },
  (table) => [
    index("idx_threads_workspace").on(table.workspaceId),
    index("idx_threads_status").on(table.status),
    index("idx_threads_parent_thread_id").on(table.parentThreadId),
    index("idx_threads_forked_from_message_id").on(table.forkedFromMessageId),
  ],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey().notNull(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: text("content").notNull(),
    toolCalls: text("tool_calls"),
    filesChanged: text("files_changed"),
    costUsd: real("cost_usd"),
    tokensUsed: integer("tokens_used"),
    timestamp: text("timestamp").notNull().default(timestampDefault),
    sequence: integer("sequence").notNull(),
    attachments: text("attachments"),
    replyToMessageId: text("reply_to_message_id").references((): AnySQLiteColumn => messages.id, { onDelete: "set null" }),
    quotedText: text("quoted_text"),
    /**
     * Model identifier active when this assistant message was produced
     * (e.g. "claude-opus-4-7", "cursor-agent", "gpt-4.1"). Nullable for
     * user messages and for assistant messages persisted before this column
     * existed — the UI falls back gracefully when absent.
     */
    model: text("model"),
    /**
     * When 1, this message is internal to mcode (e.g. a hidden handoff request
     * on a Cursor parent thread) and must not render in the chat UI. The
     * provider's session state still contains the message; mcode hides only
     * the user-visible rendering.
     */
    isInternal: integer("is_internal").notNull().default(0),
  },
  (table) => [
    index("idx_messages_thread").on(table.threadId),
    index("idx_messages_sequence").on(table.threadId, table.sequence),
  ],
);

export const toolCallRecords = sqliteTable(
  "tool_call_records",
  {
    id: text("id").primaryKey().notNull(),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    parentToolCallId: text("parent_tool_call_id"),
    toolName: text("tool_name").notNull(),
    inputSummary: text("input_summary").notNull().default(""),
    outputSummary: text("output_summary").notNull().default(""),
    outputTruncated: integer("output_truncated").notNull().default(0),
    outputTotalBytes: integer("output_total_bytes"),
    outputArtifactPath: text("output_artifact_path"),
    status: text("status").notNull().default("running"),
    startedAt: text("started_at").notNull().default(timestampDefault),
    completedAt: text("completed_at"),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (table) => [
    index("idx_tool_call_records_message").on(table.messageId),
    index("idx_tool_call_records_parent").on(table.parentToolCallId),
  ],
);

export const thoughtSegments = sqliteTable(
  "thought_segments",
  {
    id: text("id").primaryKey().notNull(),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    startedAt: text("started_at").notNull().default(timestampDefault),
    endedAt: text("ended_at"),
    sortOrder: integer("sort_order").notNull().default(0),
    /**
     * Non-zero when this segment is the assistant's final user-facing response
     * (set by the provider stream tag or the persistTurn suffix-match safeguard).
     * The client suppresses rendering these as ThoughtBlock rows to avoid
     * duplicating text that already appears in the assistant message body.
     */
    isFinalResponse: integer("is_final_response").notNull().default(0),
  },
  (table) => [
    index("idx_thought_segments_message").on(table.messageId),
  ],
);

export const hookExecutions = sqliteTable(
  "hook_executions",
  {
    id: text("id").primaryKey().notNull(),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    hookName: text("hook_name").notNull(),
    toolName: text("tool_name"),
    phase: text("phase").notNull(),
    payload: text("payload").notNull().default("{}"),
    durationMs: integer("duration_ms"),
    didBlock: integer("did_block").notNull().default(0),
    startedAt: text("started_at").notNull().default(timestampDefault),
    endedAt: text("ended_at"),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (table) => [
    index("idx_hook_executions_message").on(table.messageId),
  ],
);

export const turnSnapshots = sqliteTable(
  "turn_snapshots",
  {
    id: text("id").primaryKey().notNull(),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    refBefore: text("ref_before").notNull(),
    refAfter: text("ref_after").notNull(),
    filesChanged: text("files_changed").notNull().default("[]"),
    worktreePath: text("worktree_path"),
    createdAt: text("created_at").notNull().default(timestampDefault),
  },
  (table) => [
    index("idx_turn_snapshots_message").on(table.messageId),
    index("idx_turn_snapshots_thread").on(table.threadId),
  ],
);

/** Persisted AI-generated diff summaries, one per thread. */
export const diffSummaries = sqliteTable(
  "diff_summaries",
  {
    id: text("id").primaryKey().notNull(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    turnCount: integer("turn_count").notNull(),
    lastTurnId: text("last_turn_id"),
    model: text("model").notNull(),
    createdAt: text("created_at").notNull().default(timestampDefault),
  },
  (table) => [uniqueIndex("idx_diff_summaries_thread").on(table.threadId)],
);

export const threadTasks = sqliteTable("thread_tasks", {
  threadId: text("thread_id")
    .primaryKey()
    .notNull()
    .references(() => threads.id, { onDelete: "cascade" }),
  tasksJson: text("tasks_json").notNull(),
  updatedAt: text("updated_at").notNull().default(timestampDefault),
});

export const cleanupJobs = sqliteTable(
  "cleanup_jobs",
  {
    id: text("id").primaryKey().notNull(),
    threadId: text("thread_id").notNull().unique(),
    workspacePath: text("workspace_path").notNull(),
    worktreePath: text("worktree_path").notNull(),
    branch: text("branch"),
    attempts: integer("attempts").notNull().default(0),
    nextRetryAt: integer("next_retry_at").notNull().default(0),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_cleanup_jobs_retry").on(
      table.nextRetryAt,
      table.attempts,
      table.createdAt,
    ),
  ],
);

export const providerModelCache = sqliteTable("provider_model_cache", {
  providerId: text("provider_id").primaryKey().notNull(),
  modelsJson: text("models_json").notNull(),
  fetchedAt: text("fetched_at").notNull().default(timestampDefault),
  modelCount: integer("model_count").notNull().default(0),
});

export const planQuestionAnswers = sqliteTable(
  "plan_question_answers",
  {
    assistantMessageId: text("assistant_message_id")
      .primaryKey()
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    answeredAt: text("answered_at").notNull().default(timestampDefault),
  },
  (table) => [
    index("idx_plan_question_answers_thread").on(table.threadId),
  ],
);

export const plans = sqliteTable(
  "plans",
  {
    id: text("id").primaryKey().notNull(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    version: integer("version").notNull().default(1),
    title: text("title").notNull(),
    contentMd: text("content_md").notNull(),
    sectionsJson: text("sections_json"),
    changeSummary: text("change_summary"),
    status: text("status").notNull().default("draft"),
    createdAt: text("created_at").notNull().default(timestampDefault),
  },
  (table) => [
    index("idx_plans_thread").on(table.threadId),
    index("idx_plans_thread_version").on(table.threadId, table.version),
  ],
);
