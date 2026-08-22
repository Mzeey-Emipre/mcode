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

/** Explicit workspace-only Terminal default-profile overrides. */
export const workspaceTerminalPreferences = sqliteTable("workspace_terminal_preferences", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  defaultProfileId: text("default_profile_id").notNull(),
  updatedAt: text("updated_at").notNull().default(timestampDefault),
});

/** Durable process identities used to reap hosted Terminal sessions after a crash. */
export const terminalCleanupLedger = sqliteTable("terminal_cleanup_ledger", {
  sessionId: text("session_id").primaryKey().notNull(),
  hostGeneration: text("host_generation").notNull(),
  rootPid: integer("root_pid").notNull(),
  processGroupId: text("process_group_id").notNull(),
  containment: text("containment", {
    enum: ["job-object", "process-group"],
  }).notNull(),
  createdAt: text("created_at").notNull().default(timestampDefault),
  updatedAt: text("updated_at").notNull().default(timestampDefault),
});

/** Server-only stable identities for registered worktrees in each workspace. */
export const workspaceWorktrees = sqliteTable(
  "workspace_worktrees",
  {
    id: text("id").primaryKey().notNull(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    canonicalPath: text("canonical_path").notNull(),
    label: text("label").notNull(),
    branch: text("branch"),
    baseRef: text("base_ref"),
    managed: integer("managed").notNull().default(0),
    lastSeenAt: text("last_seen_at").notNull().default(timestampDefault),
    stale: integer("stale").notNull().default(0),
  },
  (table) => [
    uniqueIndex("idx_workspace_worktrees_path").on(table.workspaceId, table.canonicalPath),
    index("idx_workspace_worktrees_workspace").on(table.workspaceId, table.stale),
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
    checkoutState: text("checkout_state").notNull().default("named"),
    baseBranch: text("base_branch"),
    issueNumber: integer("issue_number"),
    prNumber: integer("pr_number"),
    prStatus: text("pr_status"),
    createdAt: text("created_at").notNull().default(timestampDefault),
    updatedAt: text("updated_at").notNull().default(timestampDefault),
    deletedAt: text("deleted_at"),
    userCompletedAt: text("user_completed_at"),
    scheduledDeletionAt: text("scheduled_deletion_at"),
    cleanupState: text("cleanup_state"),
    cleanupReason: text("cleanup_reason"),
    model: text("model"),
    worktreeManaged: integer("worktree_managed").notNull().default(1),
    sdkSessionId: text("sdk_session_id"),
    lastContextTokens: integer("last_context_tokens"),
    contextWindow: integer("context_window"),
    provider: text("provider").notNull().default("claude"),
    reasoningLevel: text("reasoning_level"),
    interactionMode: text("interaction_mode"),
    orchestrationMode: text("orchestration_mode"),
    permissionMode: text("permission_mode"),
    parentThreadId: text("parent_thread_id"),
    forkedFromMessageId: text("forked_from_message_id"),
    delegationCoordinatorThreadId: text("delegation_coordinator_thread_id").references((): AnySQLiteColumn => threads.id, { onDelete: "set null" }),
    delegationCreatorTurnId: text("delegation_creator_turn_id"),
    delegationCreatorToolCallId: text("delegation_creator_tool_call_id"),
    delegationCreationKind: text("delegation_creation_kind"),
    createdByIntegrationId: text("created_by_integration_id"),
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
    index("idx_threads_workspace_deleted").on(table.workspaceId, table.deletedAt),
    index("idx_threads_workspace_completed").on(table.workspaceId, table.userCompletedAt),
    index("idx_threads_cleanup_due").on(table.cleanupState, table.scheduledDeletionAt),
    index("idx_threads_workspace_recency").on(table.workspaceId, desc(table.updatedAt)),
    index("idx_threads_status").on(table.status),
    index("idx_threads_parent_thread_id").on(table.parentThreadId),
    index("idx_threads_forked_from_message_id").on(table.forkedFromMessageId),
    index("idx_threads_delegation_coordinator").on(table.delegationCoordinatorThreadId),
    index("idx_threads_created_by_integration").on(table.createdByIntegrationId),
  ],
);

/** Durable human approvals for protected delegated-thread creation mutations. */
export const threadControlApprovals = sqliteTable(
  "thread_control_approvals",
  {
    id: text("id").primaryKey().notNull(),
    threadId: text("thread_id").notNull().references(() => threads.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    prompt: text("prompt").notNull(),
    executionJson: text("execution_json").notNull(),
    placementJson: text("placement_json").notNull(),
    turnId: text("turn_id").notNull(),
    callerId: text("caller_id"),
    sourceThreadId: text("source_thread_id"),
    sourceTurnId: text("source_turn_id"),
    sourceProviderId: text("source_provider_id"),
    operation: text("operation").notNull().default("thread_create_batch"),
    operationPhase: text("operation_phase").notNull().default("pre_provision"),
    status: text("status").notNull().default("pending"),
    processingStartedAt: text("processing_started_at"),
    createdAt: text("created_at").notNull().default(timestampDefault),
    resolvedAt: text("resolved_at"),
  },
  (table) => [
    index("idx_thread_control_approvals_thread").on(table.threadId, table.status),
  ],
);

/** Bounded lifecycle records for thread-control operations. */
export const threadControlAudit = sqliteTable(
  "thread_control_audit",
  {
    id: text("id").primaryKey().notNull(),
    callerId: text("caller_id").notNull(),
    sourceThreadId: text("source_thread_id"),
    workspaceId: text("workspace_id"),
    threadId: text("thread_id"),
    operation: text("operation").notNull(),
    outcome: text("outcome").notNull(),
    createdAt: text("created_at").notNull().default(timestampDefault),
  },
  (table) => [index("idx_thread_control_audit_thread").on(table.threadId, table.createdAt)],
);

/** Durable credentials and server-owned policy for paired external MCP clients. */
export const externalThreadControlPairings = sqliteTable(
  "external_thread_control_pairings",
  {
    pairingId: text("pairing_id").primaryKey().notNull(),
    integrationId: text("integration_id").notNull(),
    credentialHash: text("credential_hash").notNull().unique(),
    workspaceIdsJson: text("workspace_ids_json").notNull().default("[]"),
    scopesJson: text("scopes_json").notNull().default("[]"),
    callsPerMinute: integer("calls_per_minute").notNull(),
    maxActiveThreads: integer("max_active_threads").notNull(),
    status: text("status").notNull().default("active"),
    authorityEpoch: integer("authority_epoch").notNull(),
    createdAt: text("created_at").notNull().default(timestampDefault),
    updatedAt: text("updated_at").notNull().default(timestampDefault),
    replacedByPairingId: text("replaced_by_pairing_id"),
    replacesPairingId: text("replaces_pairing_id"),
  },
  (table) => [
    index("idx_external_thread_control_pairings_integration").on(table.integrationId, table.status),
    uniqueIndex("idx_external_thread_control_active_integration").on(table.integrationId).where(sql`status = 'active'`),
  ],
);

/** Durable replay outcomes and reservations for external MCP deliveries. */
export const externalThreadControlDeliveries = sqliteTable(
  "external_thread_control_deliveries",
  {
    pairingId: text("pairing_id").notNull(),
    authorityEpoch: integer("authority_epoch").notNull(),
    deliveryId: text("delivery_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    status: text("status").notNull().default("in_flight"),
    resultJson: text("result_json"),
    createdAt: text("created_at").notNull().default(timestampDefault),
    updatedAt: text("updated_at").notNull().default(timestampDefault),
    expiresAt: text("expires_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_external_thread_control_delivery_identity").on(
      table.pairingId,
      table.authorityEpoch,
      table.deliveryId,
    ),
    index("idx_external_thread_control_delivery_retention").on(table.pairingId, table.status, table.expiresAt),
  ],
);

export const pullRequestReviewLinks = sqliteTable(
  "pull_request_review_links",
  {
    worktreeId: text("worktree_id").primaryKey().notNull(),
    provider: text("provider").notNull(),
    repositoryNodeId: text("repository_node_id").notNull(),
    pullRequestNumber: integer("pull_request_number").notNull(),
    pullRequestUrl: text("pr_url").notNull(),
    pullRequestState: text("pr_state").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    worktreePath: text("worktree_path").notNull(),
    worktreeManaged: integer("worktree_managed").notNull().default(1),
    headRepositoryNodeId: text("head_repository_node_id").notNull(),
    headRepositoryOwner: text("head_repository_owner").notNull(),
    headRepositoryName: text("head_repository_name").notNull(),
    headRef: text("head_ref").notNull(),
    headOid: text("head_oid").notNull(),
    localBranch: text("local_branch").notNull(),
    pushRemote: text("push_remote").notNull(),
    pushRef: text("push_ref").notNull(),
    managedRemoteName: text("managed_remote_name"),
    primaryThreadId: text("primary_thread_id").references(() => threads.id, {
      onDelete: "set null",
    }),
    createdAt: text("created_at").notNull().default(timestampDefault),
    updatedAt: text("updated_at").notNull().default(timestampDefault),
  },
  (table) => [
    uniqueIndex("idx_pull_request_review_links_identity").on(
      table.provider,
      table.repositoryNodeId,
      table.pullRequestNumber,
    ),
    uniqueIndex("idx_pull_request_review_links_primary_thread").on(
      table.primaryThreadId,
    ),
    index("idx_pull_request_review_links_workspace").on(table.workspaceId),
    index("idx_pull_request_review_links_worktree_path").on(table.worktreePath),
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
    previewAnnotations: text("preview_annotations"),
    mentions: text("mentions"),
    replyToMessageId: text("reply_to_message_id").references((): AnySQLiteColumn => messages.id, { onDelete: "set null" }),
    quotedText: text("quoted_text"),
    /**
     * Model identifier active when this assistant message was produced
     * (e.g. "claude-opus-4-7", "cursor-agent", "gpt-4.1"). Nullable for
     * user messages and for assistant messages persisted before this column
     * existed — the UI falls back gracefully when absent.
     */
    model: text("model"),
    provider: text("provider"),
    originType: text("origin_type").notNull().default("legacy"),
    sourceThreadId: text("source_thread_id"),
    sourceTurnId: text("source_turn_id"),
    sourceProviderId: text("source_provider_id"),
    /**
     * When 1, this message is internal to mcode (e.g. a hidden handoff request
     * on a Cursor parent thread) and must not render in the chat UI. The
     * provider's session state still contains the message; mcode hides only
     * the user-visible rendering.
     */
    isInternal: integer("is_internal").notNull().default(0),
    /** Durable terminal outcome written only by TurnFinalizer. */
    outcome: text("outcome"),
    /** Exact execution identity for retrying an interrupted or errored turn. */
    outcomeExecutionId: text("outcome_execution_id"),
  },
  (table) => [
    index("idx_messages_thread").on(table.threadId),
    index("idx_messages_sequence").on(table.threadId, table.sequence),
  ],
);

/** Durable automatic Setup gate for the first Turn in each managed New worktree. */
export const workspaceEnvironmentSetupGates = sqliteTable("workspace_environment_setup_gates", {
  threadId: text("thread_id").primaryKey().notNull().references(() => threads.id, { onDelete: "cascade" }),
  state: text("state").notNull(),
  attemptId: text("attempt_id"),
  createdAt: text("created_at").notNull().default(timestampDefault),
  updatedAt: text("updated_at").notNull().default(timestampDefault),
});

/** Immutable result rows for automatic Setup attempts. */
export const workspaceEnvironmentAutomaticSetupAttempts = sqliteTable(
  "workspace_environment_automatic_setup_attempts",
  {
    id: text("id").primaryKey().notNull(),
    threadId: text("thread_id").notNull().references(() => threads.id, { onDelete: "cascade" }),
    state: text("state").notNull(),
    reason: text("reason"),
    launchSnapshotJson: text("launch_snapshot_json"),
    outcome: text("outcome"),
    createdAt: text("created_at").notNull().default(timestampDefault),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
    exitCode: integer("exit_code"),
    output: text("output").notNull().default(""),
    outputTruncated: integer("output_truncated", { mode: "boolean" }).notNull().default(false),
  },
  (table) => [index("idx_workspace_environment_automatic_setup_attempts_thread").on(table.threadId, desc(table.createdAt))],
);

/** Durable first-Turn payload and claim state while automatic Setup holds dispatch. */
export const workspaceEnvironmentQueuedTurns = sqliteTable(
  "workspace_environment_queued_turns",
  {
    id: text("id").primaryKey().notNull(),
    threadId: text("thread_id").notNull().unique().references(() => threads.id, { onDelete: "cascade" }),
    messageId: text("message_id").notNull(),
    state: text("state").notNull(),
    submissionJson: text("submission_json").notNull(),
    createdAt: text("created_at").notNull().default(timestampDefault),
    releasedAt: text("released_at"),
    dispatchingAt: text("dispatching_at"),
    dispatchedAt: text("dispatched_at"),
  },
  (table) => [index("idx_workspace_environment_queued_turns_state").on(table.state, table.createdAt)],
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
    displayName: text("display_name"),
    providerAgentKey: text("provider_agent_key"),
    subagentIdentityKey: text("subagent_identity_key"),
    model: text("model"),
    reasoningEffort: text("reasoning_effort"),
    inputSummary: text("input_summary").notNull().default(""),
    outputSummary: text("output_summary").notNull().default(""),
    outputTruncated: integer("output_truncated").notNull().default(0),
    outputTotalBytes: integer("output_total_bytes"),
    outputArtifactPath: text("output_artifact_path"),
    exitCode: integer("exit_code"),
    status: text("status").notNull().default("running"),
    startedAt: text("started_at").notNull().default(timestampDefault),
    completedAt: text("completed_at"),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (table) => [
    index("idx_tool_call_records_message_sort_order").on(table.messageId, table.sortOrder),
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
    index("idx_thought_segments_message_sort_order").on(table.messageId, table.sortOrder),
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
    index("idx_hook_executions_message_sort_order").on(table.messageId, table.sortOrder),
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
    fileEffects: text("file_effects").notNull().default('{"revision":0,"fileCount":0,"additions":0,"deletions":0,"effects":[]}'),
    worktreePath: text("worktree_path"),
    createdAt: text("created_at").notNull().default(timestampDefault),
  },
  (table) => [
    index("idx_turn_snapshots_message").on(table.messageId),
    index("idx_turn_snapshots_thread").on(table.threadId),
  ],
);

/** Canonical runtime-neutral thread records. */
export const canonicalAgentThreads = sqliteTable(
  "canonical_agent_threads",
  {
    id: text("id").primaryKey().notNull().references(() => threads.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    parentThreadId: text("parent_thread_id"),
    rootThreadId: text("root_thread_id").notNull(),
    owningParentThreadId: text("owning_parent_thread_id"),
    providerId: text("provider_id").notNull(),
    providerIdentitiesJson: text("provider_identities_json").notNull().default("[]"),
    activityState: text("activity_state").notNull(),
    conversationRevision: integer("conversation_revision").notNull().default(0),
    rosterRevision: integer("roster_revision").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_canonical_agent_threads_workspace").on(table.workspaceId),
    index("idx_canonical_agent_threads_root").on(table.rootThreadId),
  ],
);

/** Canonical execution-round records. */
export const canonicalAgentTurns = sqliteTable(
  "canonical_agent_turns",
  {
    id: text("id").primaryKey().notNull(),
    threadId: text("thread_id").notNull().references(() => canonicalAgentThreads.id, { onDelete: "cascade" }),
    executionId: text("execution_id").notNull(),
    status: text("status").notNull(),
    triggerJson: text("trigger_json").notNull(),
    permissionMode: text("permission_mode").notNull(),
    providerIdentitiesJson: text("provider_identities_json").notNull().default("[]"),
    startedAt: text("started_at"),
    endedAt: text("ended_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_canonical_agent_turns_execution").on(table.executionId),
    index("idx_canonical_agent_turns_thread").on(table.threadId, table.createdAt),
  ],
);

/** Canonical semantic items stored once under their owning turn. */
export const canonicalAgentItems = sqliteTable(
  "canonical_agent_items",
  {
    id: text("id").primaryKey().notNull(),
    threadId: text("thread_id").notNull().references(() => canonicalAgentThreads.id, { onDelete: "cascade" }),
    turnId: text("turn_id").notNull().references(() => canonicalAgentTurns.id, { onDelete: "cascade" }),
    parentItemId: text("parent_item_id"),
    kind: text("kind").notNull(),
    providerIdentitiesJson: text("provider_identities_json").notNull().default("[]"),
    payloadJson: text("payload_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_canonical_agent_items_turn").on(table.turnId, table.createdAt),
    index("idx_canonical_agent_items_thread").on(table.threadId, table.createdAt),
  ],
);

/** Canonical directional collaboration-delivery records. */
export const canonicalCollaborationActions = sqliteTable(
  "canonical_collaboration_actions",
  {
    id: text("id").primaryKey().notNull(),
    kind: text("kind").notNull(),
    sourceThreadId: text("source_thread_id").notNull(),
    sourceTurnId: text("source_turn_id").notNull(),
    sourceItemId: text("source_item_id").notNull(),
    targetThreadId: text("target_thread_id").notNull(),
    targetTurnId: text("target_turn_id"),
    status: text("status").notNull(),
    deliveryUnknown: integer("delivery_unknown").notNull().default(0),
    providerIdentitiesJson: text("provider_identities_json").notNull().default("[]"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_canonical_collaboration_source").on(table.sourceThreadId, table.createdAt),
    index("idx_canonical_collaboration_target").on(table.targetThreadId, table.createdAt),
  ],
);

/** Accepted canonical events with independent accepted and durable ordering. */
export const canonicalAgentEvents = sqliteTable(
  "canonical_agent_events",
  {
    eventId: text("event_id").primaryKey().notNull(),
    threadId: text("thread_id").notNull().references(() => canonicalAgentThreads.id, { onDelete: "cascade" }),
    turnId: text("turn_id"),
    executionId: text("execution_id").notNull(),
    acceptedSequence: integer("accepted_sequence").notNull(),
    durableRevision: integer("durable_revision").notNull(),
    rosterRevision: integer("roster_revision"),
    envelopeJson: text("envelope_json").notNull(),
    acceptedAt: text("accepted_at").notNull(),
    persistedAt: text("persisted_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_canonical_agent_events_execution_sequence").on(table.executionId, table.acceptedSequence),
    index("idx_canonical_agent_events_thread_revision").on(table.threadId, table.durableRevision),
  ],
);

/** Durable accepted and committed progress for one canonical execution. */
export const canonicalAgentIngestCheckpoints = sqliteTable(
  "canonical_agent_ingest_checkpoints",
  {
    executionId: text("execution_id").primaryKey().notNull(),
    threadId: text("thread_id").notNull().references(() => canonicalAgentThreads.id, { onDelete: "cascade" }),
    turnId: text("turn_id").notNull().references(() => canonicalAgentTurns.id, { onDelete: "cascade" }),
    lastAcceptedSequence: integer("last_accepted_sequence").notNull(),
    lastDurableSequence: integer("last_durable_sequence").notNull(),
    nativeCursorJson: text("native_cursor_json"),
    phase: text("phase").notNull(),
    terminalOutcome: text("terminal_outcome"),
    error: text("error"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("idx_canonical_agent_checkpoints_thread").on(table.threadId, table.updatedAt)],
);

/** Durable cursor for the bounded legacy parent-conversation migration. */
export const canonicalLegacyMigrationCheckpoints = sqliteTable(
  "canonical_legacy_migration_checkpoints",
  {
    version: integer("version").primaryKey().notNull(),
    status: text("status").notNull().default("pending"),
    migratedMessages: integer("migrated_messages").notNull().default(0),
    ambiguousMessages: integer("ambiguous_messages").notNull().default(0),
    updatedAt: text("updated_at").notNull().default(timestampDefault),
    completedAt: text("completed_at"),
  },
);

/** Source-to-canonical provenance for each retained legacy message row. */
export const canonicalLegacyMessageProvenance = sqliteTable(
  "canonical_legacy_message_provenance",
  {
    messageId: text("message_id")
      .primaryKey()
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    migrationVersion: integer("migration_version").notNull(),
    mappingStatus: text("mapping_status").notNull(),
    canonicalThreadId: text("canonical_thread_id"),
    canonicalTurnId: text("canonical_turn_id"),
    canonicalItemId: text("canonical_item_id"),
    reason: text("reason"),
    createdAt: text("created_at").notNull().default(timestampDefault),
  },
  (table) => [
    index("idx_canonical_legacy_message_mapping").on(
      table.mappingStatus,
      table.messageId,
    ),
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
    worktreePath: text("worktree_path"),
    branch: text("branch"),
    kind: text("kind").notNull().default("explicit"),
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

/** Last known provider catalog snapshots, isolated by provider and realized context. */
export const providerCatalogSnapshots = sqliteTable(
  "provider_catalog_snapshots",
  {
    contextKey: text("context_key").primaryKey().notNull(),
    providerId: text("provider_id").notNull(),
    workspaceId: text("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" }),
    cwd: text("cwd"),
    snapshotJson: text("snapshot_json").notNull(),
    updatedAt: text("updated_at").notNull().default(timestampDefault),
  },
  (table) => [
    index("idx_provider_catalog_snapshots_workspace").on(table.workspaceId),
    index("idx_provider_catalog_snapshots_provider").on(table.providerId),
  ],
);

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
    index("idx_plan_question_answers_thread_answered_at").on(table.threadId, table.answeredAt),
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
