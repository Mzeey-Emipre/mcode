import type { Database } from "bun:sqlite";
import { inject, injectable } from "tsyringe";
import {
  MessageSchema,
  type HookExecutionRecord,
  type Message,
  type ProviderIdentity,
  type ThoughtSegmentRecord,
  type ToolCallRecord,
} from "@mcode/contracts";

/** Current shape of the legacy parent-conversation migration. */
export const LEGACY_CONVERSATION_MIGRATION_VERSION = 1;
/** One checkpoint never copies more than this many canonical narrative items. */
export const LEGACY_CONVERSATION_MIGRATION_MAX_NARRATIVE_ITEMS = 64;
/** One checkpoint never copies more than this many UTF-8 bytes. */
export const LEGACY_CONVERSATION_MIGRATION_MAX_BYTES = 262_144;
/** Legacy lineage deeper than this bound remains readable but cannot become canonical. */
export const LEGACY_CONVERSATION_MIGRATION_MAX_LINEAGE_DEPTH = 32;

type LegacyMessageRow = {
  id: string;
  thread_id: string;
  role: string;
  content: string;
  tool_calls: string | null;
  files_changed: string | null;
  cost_usd: number | null;
  tokens_used: number | null;
  timestamp: string;
  sequence: number;
  attachments: string | null;
  preview_annotations: string | null;
  mentions: string | null;
  reply_to_message_id: string | null;
  quoted_text: string | null;
  model: string | null;
  provider: string | null;
  origin_type: string;
  is_internal: number;
  workspace_id: string;
  thread_provider: string;
  sdk_session_id: string | null;
  parent_thread_id: string | null;
  permission_mode: string | null;
  thread_created_at: string;
  thread_updated_at: string;
};

type LegacyMessageCandidate = {
  id: string;
  thread_id: string;
  role: string;
  sequence: number;
  source_bytes: number;
  lineage_depth: number | null;
  lineage_provable: number;
};

type MigrationPair = {
  user: LegacyMessageRow;
  assistant: LegacyMessageRow;
};

/** Observable progress from one durable migration checkpoint. */
export interface LegacyConversationMigrationBatchResult {
  processedMessages: number;
  migratedMessages: number;
  ambiguousMessages: number;
  completed: boolean;
}

/** Failure hooks used to prove rollback and post-checkpoint resume behavior. */
export interface LegacyConversationMigrationFailureHooks {
  beforeCheckpoint?: () => void;
  afterCheckpoint?: () => void;
}

function parseNullableJson(value: string | null): unknown | null {
  if (value === null) return null;
  return JSON.parse(value) as unknown;
}

function messageFromLegacyRow(row: LegacyMessageRow): Message {
  return MessageSchema().parse({
    id: row.id,
    thread_id: row.thread_id,
    role: row.role,
    content: row.content,
    tool_calls: parseNullableJson(row.tool_calls),
    files_changed: parseNullableJson(row.files_changed),
    cost_usd: row.cost_usd,
    tokens_used: row.tokens_used,
    timestamp: row.timestamp,
    sequence: row.sequence,
    attachments: parseNullableJson(row.attachments),
    previewAnnotations: parseNullableJson(row.preview_annotations),
    mentions: parseNullableJson(row.mentions),
    reply_to_message_id: row.reply_to_message_id,
    quoted_text: row.quoted_text,
    model: row.model,
    is_internal: row.is_internal === 1,
    legacyProvenance: {
      source: "messages",
      migrationVersion: LEGACY_CONVERSATION_MIGRATION_VERSION,
      mapping: "canonical",
    },
  });
}

/** Migrates provable legacy parent turns while retained ambiguous rows stay readable. */
@injectable()
export class LegacyConversationMigration {
  constructor(@inject("Database") private readonly db: Database) {}

  /** Process one bounded source row and commit its migration provenance atomically. */
  runBatch(
    hooks: LegacyConversationMigrationFailureHooks = {},
  ): LegacyConversationMigrationBatchResult {
    const row = this.nextUnclassifiedMessage();
    if (!row) return this.completeMigration();

    const existing = this.findExistingCanonicalItem(row.id);
    if (existing) return this.recordExistingMessage(row.id, existing, hooks);

    const candidatePair = this.findProvablePair(row);
    if (!candidatePair) return this.recordAmbiguousMessages(
      [row.id],
      "The message is not part of an adjacent user and assistant pair.",
      hooks,
    );

    const invalidReason = this.invalidPairReason(row, candidatePair);
    if (invalidReason) return this.recordAmbiguousPair(candidatePair, invalidReason, hooks);

    const pair = {
      user: this.loadMessage(candidatePair.user.id),
      assistant: this.loadMessage(candidatePair.assistant.id),
    };
    const prepared = this.preparePairResult(pair);
    if ("reason" in prepared) return this.recordAmbiguousPair(candidatePair, prepared.reason, hooks);
    return this.persistPreparedPair(prepared.value, hooks);
  }

  private completeMigration(): LegacyConversationMigrationBatchResult {
    this.markComplete();
    return this.currentResult(0, true);
  }

  private recordExistingMessage(
    messageId: string,
    existing: { id: string; thread_id: string; turn_id: string },
    hooks: LegacyConversationMigrationFailureHooks,
  ): LegacyConversationMigrationBatchResult {
    this.checkpoint(hooks, () => {
      this.recordProvenance(messageId, "migrated", existing.thread_id, existing.turn_id, existing.id, null);
      this.incrementCheckpoint(1, 0);
    });
    return this.currentResult(1, false);
  }

  private invalidPairReason(
    row: LegacyMessageCandidate,
    pair: { user: LegacyMessageCandidate; assistant: LegacyMessageCandidate },
  ): string | undefined {
    if (row.lineage_provable !== 1) {
      return `The legacy thread lineage is orphaned, cyclic, or exceeds depth ${LEGACY_CONVERSATION_MIGRATION_MAX_LINEAGE_DEPTH}.`;
    }
    if (pair.user.source_bytes + pair.assistant.source_bytes > LEGACY_CONVERSATION_MIGRATION_MAX_BYTES) {
      return `The legacy turn exceeds ${LEGACY_CONVERSATION_MIGRATION_MAX_BYTES} bytes.`;
    }
    return undefined;
  }

  private recordAmbiguousPair(
    pair: { user: LegacyMessageCandidate; assistant: LegacyMessageCandidate },
    reason: string,
    hooks: LegacyConversationMigrationFailureHooks,
  ): LegacyConversationMigrationBatchResult {
    return this.recordAmbiguousMessages([pair.user.id, pair.assistant.id], reason, hooks);
  }

  private recordAmbiguousMessages(
    messageIds: readonly string[],
    reason: string,
    hooks: LegacyConversationMigrationFailureHooks,
  ): LegacyConversationMigrationBatchResult {
    this.checkpoint(hooks, () => {
      for (const messageId of messageIds) {
        this.recordProvenance(messageId, "ambiguous", null, null, null, reason);
      }
      this.incrementCheckpoint(0, messageIds.length);
    });
    return this.currentResult(messageIds.length, false);
  }

  private preparePairResult(pair: MigrationPair):
    | { value: ReturnType<LegacyConversationMigration["preparePair"]> }
    | { reason: string } {
    try {
      return { value: this.preparePair(pair) };
    } catch (error) {
      return { reason: error instanceof Error ? error.message : String(error) };
    }
  }

  private persistPreparedPair(
    prepared: ReturnType<LegacyConversationMigration["preparePair"]>,
    hooks: LegacyConversationMigrationFailureHooks,
  ): LegacyConversationMigrationBatchResult {
    this.checkpoint(hooks, () => this.persistPair(prepared));
    return this.currentResult(2, false);
  }

  private checkpoint(hooks: LegacyConversationMigrationFailureHooks, write: () => void): void {
    this.db.transaction(() => {
      write();
      hooks.beforeCheckpoint?.();
    })();
    hooks.afterCheckpoint?.();
  }

  /** Continue from durable provenance checkpoints until no parent message remains. */
  async runToCompletion(): Promise<LegacyConversationMigrationBatchResult> {
    let result = this.runBatch();
    while (!result.completed) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      result = this.runBatch();
    }
    return result;
  }

  private nextUnclassifiedMessage(): LegacyMessageCandidate | null {
    return this.db.prepare(`
      WITH RECURSIVE lineage(thread_id, depth) AS (
        SELECT id, 0
        FROM threads
        WHERE parent_thread_id IS NULL
        UNION ALL
        SELECT child.id, parent.depth + 1
        FROM threads child
        JOIN lineage parent ON parent.thread_id = child.parent_thread_id
        WHERE parent.depth < ${LEGACY_CONVERSATION_MIGRATION_MAX_LINEAGE_DEPTH}
      )
      SELECT
        m.id, m.thread_id, m.role, m.sequence,
        length(CAST(m.content AS BLOB))
          + length(CAST(COALESCE(m.tool_calls, '') AS BLOB))
          + length(CAST(COALESCE(m.files_changed, '') AS BLOB))
          + length(CAST(COALESCE(m.attachments, '') AS BLOB))
          + length(CAST(COALESCE(m.preview_annotations, '') AS BLOB))
          + length(CAST(COALESCE(m.mentions, '') AS BLOB))
          + length(CAST(COALESCE(m.quoted_text, '') AS BLOB)) AS source_bytes,
        lineage.depth AS lineage_depth,
        CASE WHEN lineage.depth IS NULL THEN 0 ELSE 1 END AS lineage_provable
      FROM messages m
      JOIN threads t ON t.id = m.thread_id
      LEFT JOIN lineage ON lineage.thread_id = t.id
      LEFT JOIN canonical_legacy_message_provenance p ON p.message_id = m.id
      WHERE p.message_id IS NULL
      ORDER BY CASE WHEN lineage.depth IS NULL THEN ${LEGACY_CONVERSATION_MIGRATION_MAX_LINEAGE_DEPTH + 1}
        ELSE lineage.depth END,
        m.thread_id ASC, m.sequence ASC, m.id ASC
      LIMIT 1
    `).get() as LegacyMessageCandidate | undefined ?? null;
  }

  private adjacentMessage(
    row: LegacyMessageCandidate,
    direction: "previous" | "next",
  ): LegacyMessageCandidate | null {
    const comparator = direction === "previous" ? "<" : ">";
    const order = direction === "previous" ? "DESC" : "ASC";
    return this.db.prepare(`
      SELECT
        m.id, m.thread_id, m.role, m.sequence,
        length(CAST(m.content AS BLOB))
          + length(CAST(COALESCE(m.tool_calls, '') AS BLOB))
          + length(CAST(COALESCE(m.files_changed, '') AS BLOB))
          + length(CAST(COALESCE(m.attachments, '') AS BLOB))
          + length(CAST(COALESCE(m.preview_annotations, '') AS BLOB))
          + length(CAST(COALESCE(m.mentions, '') AS BLOB))
          + length(CAST(COALESCE(m.quoted_text, '') AS BLOB)) AS source_bytes
      FROM messages m
      JOIN threads t ON t.id = m.thread_id
      WHERE m.thread_id = ?
        AND (m.sequence, m.id) ${comparator} (?, ?)
      ORDER BY m.sequence ${order}, m.id ${order}
      LIMIT 1
    `).get(row.thread_id, row.sequence, row.id) as LegacyMessageCandidate | undefined ?? null;
  }

  private findProvablePair(row: LegacyMessageCandidate): {
    user: LegacyMessageCandidate;
    assistant: LegacyMessageCandidate;
  } | null {
    if (row.role === "user") {
      const assistant = this.adjacentMessage(row, "next");
      return assistant?.role === "assistant" ? { user: row, assistant } : null;
    }
    if (row.role === "assistant") {
      const user = this.adjacentMessage(row, "previous");
      return user?.role === "user" ? { user, assistant: row } : null;
    }
    return null;
  }

  private loadMessage(messageId: string): LegacyMessageRow {
    const row = this.db.prepare(`
      SELECT
        m.id, m.thread_id, m.role, m.content, m.tool_calls, m.files_changed,
        m.cost_usd, m.tokens_used, m.timestamp, m.sequence, m.attachments,
        m.preview_annotations, m.mentions, m.reply_to_message_id, m.quoted_text,
        m.model, m.provider, m.origin_type, m.is_internal,
        t.workspace_id, t.provider AS thread_provider, t.sdk_session_id,
        t.parent_thread_id,
        t.permission_mode, t.created_at AS thread_created_at,
        t.updated_at AS thread_updated_at
      FROM messages m
      JOIN threads t ON t.id = m.thread_id
      WHERE m.id = ?
    `).get(messageId) as LegacyMessageRow | undefined;
    if (!row) throw new Error(`Legacy message disappeared during migration: ${messageId}`);
    return row;
  }

  private preparePair(pair: MigrationPair): {
    pair: MigrationPair;
    userMessage: Message;
    assistantMessage: Message;
    providerIdentities: ProviderIdentity[];
    turnId: string;
    executionId: string;
    narratives: Array<{
      id: string;
      kind: "tool-call" | "reasoning" | "system";
      parentItemId?: string;
      projection: "toolCall" | "narrationSegment" | "hook";
      record: ToolCallRecord | ThoughtSegmentRecord | HookExecutionRecord;
      createdAt: string;
    }>;
    parentThreadId: string | null;
    rootThreadId: string;
    owningParentThreadId: string | null;
  } {
    const userMessage = messageFromLegacyRow(pair.user);
    const assistantMessage = messageFromLegacyRow(pair.assistant);
    const providerId = pair.user.thread_provider.trim();
    if (!providerId) throw new Error("The legacy thread has no provider identity.");
    const providerIdentities: ProviderIdentity[] = pair.user.sdk_session_id
      ? [{
          providerId,
          scope: providerId === "codex" ? "thread" : "session",
          value: pair.user.sdk_session_id,
          provenance: "native",
        }]
      : [];
    const lineage = this.resolveCanonicalLineage(
      pair.user.thread_id,
      pair.user.parent_thread_id,
    );
    const narrativeSize = this.measureNarratives(pair.assistant.id);
    if (narrativeSize.count > LEGACY_CONVERSATION_MIGRATION_MAX_NARRATIVE_ITEMS) {
      throw new Error(
        `The legacy turn exceeds ${LEGACY_CONVERSATION_MIGRATION_MAX_NARRATIVE_ITEMS} narrative items.`,
      );
    }
    if (narrativeSize.bytes > LEGACY_CONVERSATION_MIGRATION_MAX_BYTES) {
      throw new Error(
        `The legacy turn exceeds ${LEGACY_CONVERSATION_MIGRATION_MAX_BYTES} bytes.`,
      );
    }
    const narratives = this.loadNarratives(pair.assistant.id);
    const turnId = `legacy-turn:${pair.user.id}`;
    const executionId = `legacy-execution:${pair.user.id}`;
    const bytes = Buffer.byteLength(JSON.stringify({
      userMessage,
      assistantMessage,
      providerIdentities,
      narratives,
    }), "utf8");
    if (bytes > LEGACY_CONVERSATION_MIGRATION_MAX_BYTES) {
      throw new Error(
        `The legacy turn exceeds ${LEGACY_CONVERSATION_MIGRATION_MAX_BYTES} bytes.`,
      );
    }
    return {
      pair,
      userMessage,
      assistantMessage,
      providerIdentities,
      turnId,
      executionId,
      narratives,
      ...lineage,
    };
  }

  private resolveCanonicalLineage(
    threadId: string,
    parentThreadId: string | null,
  ): {
    parentThreadId: string | null;
    rootThreadId: string;
    owningParentThreadId: string | null;
  } {
    if (parentThreadId === null) {
      return {
        parentThreadId: null,
        rootThreadId: threadId,
        owningParentThreadId: null,
      };
    }
    const parent = this.db.prepare(`
      SELECT root_thread_id, owning_parent_thread_id
      FROM canonical_agent_threads
      WHERE id = ?
    `).get(parentThreadId) as {
      root_thread_id: string;
      owning_parent_thread_id: string | null;
    } | undefined;
    if (!parent) {
      throw new Error(`The legacy parent thread has no canonical mapping: ${parentThreadId}`);
    }
    return {
      parentThreadId,
      rootThreadId: parent.root_thread_id,
      owningParentThreadId: parent.owning_parent_thread_id ?? parentThreadId,
    };
  }

  private measureNarratives(messageId: string): { count: number; bytes: number } {
    return this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM tool_call_records WHERE message_id = ?)
          + (SELECT COUNT(*) FROM thought_segments WHERE message_id = ?)
          + (SELECT COUNT(*) FROM hook_executions WHERE message_id = ?) AS count,
        (SELECT COALESCE(SUM(
          length(CAST(input_summary AS BLOB))
          + length(CAST(output_summary AS BLOB))
        ), 0) FROM tool_call_records WHERE message_id = ?)
          + (SELECT COALESCE(SUM(length(CAST(text AS BLOB))), 0)
             FROM thought_segments WHERE message_id = ?)
          + (SELECT COALESCE(SUM(length(CAST(payload AS BLOB))), 0)
             FROM hook_executions WHERE message_id = ?) AS bytes
    `).get(
      messageId,
      messageId,
      messageId,
      messageId,
      messageId,
      messageId,
    ) as { count: number; bytes: number };
  }

  private loadNarratives(messageId: string): ReturnType<LegacyConversationMigration["preparePair"]>["narratives"] {
    const toolCalls = this.db.prepare(`
      SELECT id, message_id, parent_tool_call_id, tool_name, display_name,
        provider_agent_key, model, reasoning_effort, input_summary, output_summary,
        output_truncated, output_total_bytes, output_artifact_path, exit_code,
        status, started_at, completed_at, sort_order
      FROM tool_call_records
      WHERE message_id = ?
      ORDER BY sort_order ASC, id ASC
    `).all(messageId) as ToolCallRecord[];
    const thoughts = this.db.prepare(`
      SELECT id, message_id, text, started_at, ended_at, sort_order, is_final_response
      FROM thought_segments
      WHERE message_id = ?
      ORDER BY sort_order ASC, id ASC
    `).all(messageId) as ThoughtSegmentRecord[];
    const hookRows = this.db.prepare(`
      SELECT id, message_id, hook_name, tool_name, phase, payload, duration_ms,
        did_block, started_at, ended_at, sort_order
      FROM hook_executions
      WHERE message_id = ?
      ORDER BY sort_order ASC, id ASC
    `).all(messageId) as Array<Omit<HookExecutionRecord, "did_block"> & { did_block: number }>;
    const hooks: HookExecutionRecord[] = hookRows.map((row) => ({
      ...row,
      did_block: row.did_block === 1,
    }));
    return [
      ...toolCalls.map((record) => ({
        id: `toolCall:${record.id}`,
        kind: "tool-call" as const,
        ...(record.parent_tool_call_id
          ? { parentItemId: `toolCall:${record.parent_tool_call_id}` }
          : {}),
        projection: "toolCall" as const,
        record,
        createdAt: record.started_at,
      })),
      ...thoughts.map((record) => ({
        id: `narrationSegment:${record.id}`,
        kind: "reasoning" as const,
        projection: "narrationSegment" as const,
        record,
        createdAt: record.started_at,
      })),
      ...hooks.map((record) => ({
        id: `hook:${record.id}`,
        kind: "system" as const,
        projection: "hook" as const,
        record,
        createdAt: record.started_at,
      })),
    ].sort((left, right) => (
      left.record.sort_order - right.record.sort_order || left.id.localeCompare(right.id)
    ));
  }

  private persistPair(prepared: ReturnType<LegacyConversationMigration["preparePair"]>): void {
    const {
      pair,
      providerIdentities,
      turnId,
      executionId,
      parentThreadId,
      rootThreadId,
      owningParentThreadId,
    } = prepared;
    const identitiesJson = JSON.stringify(providerIdentities);
    const threadInsert = this.db.prepare(`
      INSERT INTO canonical_agent_threads (
        id, workspace_id, parent_thread_id, root_thread_id, owning_parent_thread_id,
        provider_id, provider_identities_json, activity_state, conversation_revision,
        roster_revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'Idle', 1, 0, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(
      pair.user.thread_id,
      pair.user.workspace_id,
      parentThreadId,
      rootThreadId,
      owningParentThreadId,
      pair.user.thread_provider,
      identitiesJson,
      pair.user.thread_created_at,
      pair.user.thread_updated_at,
    );
    if (parentThreadId !== null && threadInsert.changes === 1) {
      this.db.prepare(`
        UPDATE canonical_agent_threads
        SET roster_revision = roster_revision + 1,
            updated_at = ?
        WHERE id = ?
      `).run(pair.user.thread_updated_at, parentThreadId);
    } else if (threadInsert.changes === 0) {
      this.db.prepare(`
        UPDATE canonical_agent_threads
        SET conversation_revision = conversation_revision + 1,
            updated_at = ?
        WHERE id = ?
      `).run(pair.user.thread_updated_at, pair.user.thread_id);
    }
    this.db.prepare(`
      INSERT INTO canonical_agent_turns (
        id, thread_id, execution_id, status, trigger_json, permission_mode,
        provider_identities_json, started_at, ended_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'Completed', '{"kind":"user"}', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(
      turnId,
      pair.user.thread_id,
      executionId,
      pair.user.permission_mode === "full" ? "full" : "supervised",
      identitiesJson,
      pair.user.timestamp,
      pair.assistant.timestamp,
      pair.user.timestamp,
      pair.assistant.timestamp,
    );
    this.persistMessageItem(prepared.userMessage, turnId, identitiesJson);
    this.persistMessageItem(prepared.assistantMessage, turnId, identitiesJson);
    const insertNarrative = this.db.prepare(`
      INSERT INTO canonical_agent_items (
        id, thread_id, turn_id, parent_item_id, kind, provider_identities_json,
        payload_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `);
    for (const narrative of prepared.narratives) {
      insertNarrative.run(
        narrative.id,
        pair.user.thread_id,
        turnId,
        narrative.parentItemId ?? null,
        narrative.kind,
        identitiesJson,
        JSON.stringify({
          projection: narrative.projection,
          record: narrative.record,
          legacyProvenance: {
            source: "messages",
            migrationVersion: LEGACY_CONVERSATION_MIGRATION_VERSION,
            mapping: "canonical",
          },
        }),
        narrative.createdAt,
        narrative.createdAt,
      );
    }
    this.db.prepare(`
      INSERT INTO canonical_agent_ingest_checkpoints (
        execution_id, thread_id, turn_id, last_accepted_sequence, last_durable_sequence,
        native_cursor_json, phase, terminal_outcome, error, updated_at
      ) VALUES (?, ?, ?, 0, 0, NULL, 'legacy_migrated', 'completed', NULL, ?)
      ON CONFLICT(execution_id) DO NOTHING
    `).run(executionId, pair.user.thread_id, turnId, pair.assistant.timestamp);
    for (const message of [prepared.userMessage, prepared.assistantMessage]) {
      this.recordProvenance(
        message.id,
        "migrated",
        pair.user.thread_id,
        turnId,
        `message:${message.id}`,
        null,
      );
    }
    this.incrementCheckpoint(2, 0);
  }

  private persistMessageItem(message: Message, turnId: string, identitiesJson: string): void {
    this.db.prepare(`
      INSERT INTO canonical_agent_items (
        id, thread_id, turn_id, parent_item_id, kind, provider_identities_json,
        payload_json, created_at, updated_at
      ) VALUES (?, ?, ?, NULL, 'message', ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(
      `message:${message.id}`,
      message.thread_id,
      turnId,
      identitiesJson,
      JSON.stringify({
        projection: "message",
        message,
        legacyProvenance: message.legacyProvenance,
      }),
      message.timestamp,
      message.timestamp,
    );
  }

  private findExistingCanonicalItem(messageId: string): {
    id: string;
    thread_id: string;
    turn_id: string;
  } | null {
    return this.db.prepare(`
      SELECT id, thread_id, turn_id
      FROM canonical_agent_items
      WHERE id = ?
        AND kind = 'message'
        AND json_extract(payload_json, '$.message.id') = ?
    `).get(`message:${messageId}`, messageId) as {
      id: string;
      thread_id: string;
      turn_id: string;
    } | undefined ?? null;
  }

  private recordProvenance(
    messageId: string,
    status: "migrated" | "ambiguous",
    canonicalThreadId: string | null,
    canonicalTurnId: string | null,
    canonicalItemId: string | null,
    reason: string | null,
  ): void {
    this.db.prepare(`
      INSERT INTO canonical_legacy_message_provenance (
        message_id, migration_version, mapping_status, canonical_thread_id,
        canonical_turn_id, canonical_item_id, reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_id) DO NOTHING
    `).run(
      messageId,
      LEGACY_CONVERSATION_MIGRATION_VERSION,
      status,
      canonicalThreadId,
      canonicalTurnId,
      canonicalItemId,
      reason,
    );
  }

  private incrementCheckpoint(migrated: number, ambiguous: number): void {
    this.db.prepare(`
      INSERT INTO canonical_legacy_migration_checkpoints (
        version, status, migrated_messages, ambiguous_messages, updated_at
      ) VALUES (?, 'running', ?, ?, ?)
      ON CONFLICT(version) DO UPDATE SET
        status = 'running',
        migrated_messages = migrated_messages + excluded.migrated_messages,
        ambiguous_messages = ambiguous_messages + excluded.ambiguous_messages,
        updated_at = excluded.updated_at,
        completed_at = NULL
    `).run(
      LEGACY_CONVERSATION_MIGRATION_VERSION,
      migrated,
      ambiguous,
      new Date().toISOString(),
    );
  }

  private markComplete(): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO canonical_legacy_migration_checkpoints (
        version, status, migrated_messages, ambiguous_messages, updated_at, completed_at
      ) VALUES (?, 'completed', 0, 0, ?, ?)
      ON CONFLICT(version) DO UPDATE SET
        status = 'completed', updated_at = excluded.updated_at, completed_at = excluded.completed_at
    `).run(LEGACY_CONVERSATION_MIGRATION_VERSION, now, now);
  }

  private currentResult(
    processedMessages: number,
    completed: boolean,
  ): LegacyConversationMigrationBatchResult {
    const row = this.db.prepare(`
      SELECT migrated_messages, ambiguous_messages
      FROM canonical_legacy_migration_checkpoints
      WHERE version = ?
    `).get(LEGACY_CONVERSATION_MIGRATION_VERSION) as {
      migrated_messages: number;
      ambiguous_messages: number;
    } | undefined;
    return {
      processedMessages,
      migratedMessages: row?.migrated_messages ?? 0,
      ambiguousMessages: row?.ambiguous_messages ?? 0,
      completed,
    };
  }
}
