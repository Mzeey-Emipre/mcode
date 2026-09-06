/**
 * Message data access layer.
 * Provides creation and retrieval operations for message records in SQLite.
 */

import * as NodeCrypto from "node:crypto";
import { injectable, inject } from "tsyringe";
import type Database from "better-sqlite3";
import type {
  Message,
  MessageMention,
  MessageRole,
  PreviewAnnotationBundle,
  SelectedTextComment,
  StoredAttachment,
  SystemNoticeMetadata,
  TurnOutcome,
} from "@mcode/contracts";
import {
  PreviewAnnotationBundleSchema,
  SelectedTextCommentsSchema,
  SystemNoticeMetadataSchema,
  THREAD_GET_TRANSCRIPT_MAX_BYTES,
} from "@mcode/contracts";

interface MessageRow {
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
  selected_text_comments: string | null;
  reply_to_message_id: string | null;
  quoted_text: string | null;
  model: string | null;
  provider: string | null;
  origin_type: string;
  source_thread_id: string | null;
  source_turn_id: string | null;
  source_provider_id: string | null;
  is_internal: number;
  outcome?: TurnOutcome | null;
  outcome_execution_id?: string | null;
  system_notice: string | null;
  tool_call_count?: number;
}

interface MessageBudgetRow {
  id: string;
  sequence: number;
  content_bytes: number;
  metadata_bytes: number;
}

type MessageOriginInput =
  | { type: "composer" }
  | {
      type: "thread";
      sourceThreadId: string;
      sourceTurnId: string;
      sourceProviderId: string;
    };

/** Persisted fields needed to build the bounded thread-control transcript. */
export interface ThreadControlMessageRecord {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  provider: string | null;
  model: string | null;
  originType: "composer" | "thread" | "legacy";
  sourceThreadId: string | null;
  sourceTurnId: string | null;
  sourceProviderId: string | null;
}

export interface ThreadHistoryBudget {
  budgetBytes: number;
  retainedBytes: number;
  omittedBeforeCount: number;
  truncatedMessages: Array<{
    id: string;
    originalBytes: number;
    retainedBytes: number;
  }>;
}

export interface BudgetedThreadMessages {
  messages: Message[];
  budget: ThreadHistoryBudget;
}

export interface BudgetedThreadMessageOptions {
  maxBytes: number;
  pageSize?: number;
  maxRows?: number;
  includeInternal?: boolean;
}

function parseJsonField(value: string | null): unknown | null {
  if (value === null) {
    return null;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function parsePreviewAnnotations(value: string | null): PreviewAnnotationBundle | null {
  const parsed = parseJsonField(value);
  if (parsed === null) return null;
  return PreviewAnnotationBundleSchema().parse(parsed);
}

function serializePreviewAnnotations(
  previewAnnotations: PreviewAnnotationBundle | undefined,
): string | null {
  if (!previewAnnotations) return null;
  return JSON.stringify(PreviewAnnotationBundleSchema().parse(previewAnnotations));
}

function parseSelectedTextComments(value: string | null): SelectedTextComment[] | null {
  const parsed = parseJsonField(value);
  if (parsed === null) return null;
  return SelectedTextCommentsSchema().parse(parsed);
}

function parseSystemNotice(value: string | null): SystemNoticeMetadata | null {
  const parsed = parseJsonField(value);
  if (parsed === null) return null;
  return SystemNoticeMetadataSchema().parse(parsed);
}

function serializeSelectedTextComments(
  selectedTextComments: SelectedTextComment[] | undefined,
): string | null {
  if (!selectedTextComments || selectedTextComments.length === 0) return null;
  return JSON.stringify(SelectedTextCommentsSchema().parse(selectedTextComments));
}

function rowToMessage(row: MessageRow): Message {
  const msg: Message = {
    id: row.id,
    thread_id: row.thread_id,
    role: row.role as MessageRole,
    content: row.content,
    tool_calls: parseJsonField(row.tool_calls),
    files_changed: parseJsonField(row.files_changed),
    cost_usd: row.cost_usd,
    tokens_used: row.tokens_used,
    timestamp: row.timestamp,
    sequence: row.sequence,
    attachments: parseJsonField(row.attachments) as
      | StoredAttachment[]
      | null,
    previewAnnotations: parsePreviewAnnotations(row.preview_annotations),
    mentions: parseJsonField(row.mentions) as MessageMention[] | null,
    selectedTextComments: parseSelectedTextComments(row.selected_text_comments),
    reply_to_message_id: row.reply_to_message_id,
    quoted_text: row.quoted_text,
    model: row.model,
    outcome: row.outcome ?? null,
    outcomeExecutionId: row.outcome_execution_id ?? null,
    systemNotice: parseSystemNotice(row.system_notice),
    is_internal: row.is_internal === 1,
    ...(row.origin_type === "legacy"
      ? {
          legacyProvenance: {
            source: "messages" as const,
            migrationVersion: null,
            mapping: "legacy" as const,
            reason: "The legacy structure does not prove a canonical turn mapping.",
          },
        }
      : {}),
  };

  if (row.tool_call_count && row.tool_call_count > 0) {
    msg.tool_call_count = row.tool_call_count;
  }

  return msg;
}

const MESSAGE_COLUMNS =
  "id, thread_id, role, content, tool_calls, files_changed, cost_usd, tokens_used, timestamp, sequence, attachments, preview_annotations, mentions, selected_text_comments, reply_to_message_id, quoted_text, model, provider, origin_type, source_thread_id, source_turn_id, source_provider_id, is_internal, outcome, outcome_execution_id, system_notice";

const MESSAGE_COLUMNS_PREFIXED =
  "m.id, m.thread_id, m.role, m.content, m.tool_calls, m.files_changed, m.cost_usd, m.tokens_used, m.timestamp, m.sequence, m.attachments, m.preview_annotations, m.mentions, m.selected_text_comments, m.reply_to_message_id, m.quoted_text, m.model, m.provider, m.origin_type, m.source_thread_id, m.source_turn_id, m.source_provider_id, m.is_internal, m.outcome, m.outcome_execution_id, m.system_notice";

/**
 * Pre-aggregates tool call counts for the selected page only.
 * The page CTE prevents a correlated count from running once per message row.
 */
function pagedMessageQuery(whereClause: string, direction: "ASC" | "DESC" = "DESC"): string {
  return `WITH page AS (
  SELECT ${MESSAGE_COLUMNS_PREFIXED}
  FROM messages m
  WHERE ${whereClause}
  ORDER BY m.sequence ${direction}
  LIMIT ?
),
tool_counts AS (
  SELECT message_id, COUNT(*) AS tool_call_count
  FROM tool_call_records
  WHERE message_id IN (SELECT id FROM page)
  GROUP BY message_id
)
SELECT page.*, COALESCE(tool_counts.tool_call_count, 0) AS tool_call_count
FROM page
LEFT JOIN tool_counts ON tool_counts.message_id = page.id
ORDER BY page.sequence ASC`;
}

const DEFAULT_HISTORY_PAGE_SIZE = 100;
const MAX_HISTORY_PAGE_SIZE = 500;
const DEFAULT_HISTORY_MAX_ROWS = 500;
const MAX_HISTORY_MAX_ROWS = 2_000;

function clampPositiveInt(value: number, fallback: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function takeUtf8Prefix(text: string, maxBytes: number): { text: string; bytes: number } {
  if (maxBytes <= 0) return { text: "", bytes: 0 };
  let bytes = 0;
  let out = "";
  for (const char of text) {
    const next = byteLength(char);
    if (bytes + next > maxBytes) break;
    out += char;
    bytes += next;
  }
  return { text: out, bytes };
}

/** Repository for message creation and retrieval against SQLite. */
@injectable()
export class MessageRepo {
  private createStatement: Database.Statement | null = null;
  private createAssistantStatement: Database.Statement | null = null;
  private publishAssistantStatement: Database.Statement | null = null;
  private latestSequenceStatement: Database.Statement | null = null;

  constructor(@inject("Database") private readonly db: Database.Database) {}

  private getCreateStatement(): Database.Statement {
    return this.createStatement ??= this.db.prepare(
      "INSERT INTO messages (id, thread_id, role, content, timestamp, sequence, attachments, preview_annotations, mentions, reply_to_message_id, quoted_text, model, origin_type, source_thread_id, source_turn_id, source_provider_id, is_internal, selected_text_comments, system_notice) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
  }

  private getCreateAssistantStatement(): Database.Statement {
    return this.createAssistantStatement ??= this.db.prepare(
      "INSERT OR IGNORE INTO messages (id, thread_id, role, content, timestamp, sequence, attachments, mentions, model, provider, origin_type, is_internal) VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, ?, ?, 'composer', ?)",
    );
  }

  private getPublishAssistantStatement(): Database.Statement {
    return this.publishAssistantStatement ??= this.db.prepare(
      "UPDATE messages SET is_internal = 0 WHERE id = ? AND role = 'assistant'",
    );
  }

  /**
   * Create a new message and return the fully-populated record.
   *
   * `model` records the model identifier active when an assistant message was
   * produced (e.g. "claude-opus-4-7"). Null for user/system messages and
   * acceptable for assistant messages when the provider doesn't surface a
   * model — the UI footer falls back gracefully.
   * `messageId` preserves the renderer's optimistic identity when supplied.
   */
  create(
    threadId: string,
    role: MessageRole,
    content: string,
    sequence: number,
    attachments?: StoredAttachment[],
    replyToMessageId?: string,
    quotedText?: string,
    model?: string | null,
    isInternal?: boolean,
    mentions?: MessageMention[],
    previewAnnotations?: PreviewAnnotationBundle,
    origin: MessageOriginInput = { type: "composer" },
    messageId?: string,
    selectedTextComments?: SelectedTextComment[],
    systemNotice?: SystemNoticeMetadata,
  ): Message {
    const id = messageId ?? NodeCrypto.randomUUID();
    const now = new Date().toISOString();
    const attachmentsJson = this.serializeNonEmptyArray(attachments);
    const mentionsJson = this.serializeNonEmptyArray(mentions);
    const previewAnnotationsJson = serializePreviewAnnotations(previewAnnotations);
    const selectedTextCommentsJson = serializeSelectedTextComments(selectedTextComments);
    const systemNoticeJson = systemNotice ? JSON.stringify(SystemNoticeMetadataSchema().parse(systemNotice)) : null;
    const modelValue = model ?? null;
    const isInternalValue = isInternal ? 1 : 0;
    const source = this.messageSource(origin);

    this.getCreateStatement().run(
        id, threadId, role, content, now, sequence,
        attachmentsJson, previewAnnotationsJson, mentionsJson, replyToMessageId ?? null, quotedText ?? null, modelValue, origin.type, source.threadId, source.turnId, source.providerId, isInternalValue, selectedTextCommentsJson, systemNoticeJson,
      );

    return this.createdMessage({
      id,
      threadId,
      role,
      content,
      sequence,
      timestamp: now,
      attachments,
      previewAnnotations,
      mentions,
      selectedTextComments,
      replyToMessageId,
      quotedText,
      model: modelValue,
      isInternal,
      systemNotice,
    });
  }

  /** Create a visible system message carrying bounded provider notice metadata. */
  createSystemNotice(
    threadId: string,
    content: string,
    sequence: number,
    systemNotice: SystemNoticeMetadata | undefined,
  ): Message {
    const metadata = systemNotice ? SystemNoticeMetadataSchema().parse(systemNotice) : undefined;
    return this.db.transaction(() => this.writeSystemNotice(threadId, content, sequence, metadata))();
  }

  private writeSystemNotice(threadId: string, content: string, sequence: number, systemNotice: SystemNoticeMetadata | undefined): Message {
    if (systemNotice?.noticeKey) {
      const existing = this.db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE thread_id = ? AND json_extract(system_notice, '$.sessionId') IS ? AND (json_extract(system_notice, '$.noticeKey') = ? OR (? = 'model-rerouted' AND json_extract(system_notice, '$.kind') = 'model-rerouted')) ORDER BY sequence DESC LIMIT 1`).get(threadId, systemNotice.sessionId ?? null, systemNotice.noticeKey, systemNotice.kind) as MessageRow | undefined;
      if (existing) {
        this.db.prepare("UPDATE messages SET content = ?, system_notice = ? WHERE id = ?").run(content, JSON.stringify(systemNotice), existing.id);
        return rowToMessage({ ...existing, content, system_notice: JSON.stringify(systemNotice) });
      }
    }
    if (systemNotice?.scope === "session") {
      this.db.prepare("DELETE FROM messages WHERE id IN (SELECT id FROM messages WHERE thread_id = ? AND json_extract(system_notice, '$.scope') = 'session' AND json_extract(system_notice, '$.sessionId') IS ? ORDER BY sequence DESC LIMIT -1 OFFSET 19)").run(threadId, systemNotice.sessionId ?? null);
    }
    return this.create(
      threadId, "system", content, sequence,
      undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, systemNotice,
    );
  }

  /** Select the provider notice session and expire session-scoped rows from prior sessions. */
  beginNoticeSession(threadId: string, sessionId: string | undefined): void {
    this.db.transaction(() => {
      this.db.prepare("UPDATE threads SET current_notice_session_id = ? WHERE id = ?").run(sessionId ?? null, threadId);
      this.db.prepare("DELETE FROM messages WHERE thread_id = ? AND json_extract(system_notice, '$.scope') = 'session' AND json_extract(system_notice, '$.sessionId') IS NOT ?").run(threadId, sessionId ?? null);
    })();
  }

  /** Read the latest notices for the provider session selected at its startup boundary. */
  listSessionNotices(threadId: string): Message[] {
    const rows = this.db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM (
      SELECT ${MESSAGE_COLUMNS}
      FROM messages
      WHERE thread_id = ?
        AND system_notice IS NOT NULL
        AND json_extract(system_notice, '$.sessionId') IS (
          SELECT current_notice_session_id FROM threads WHERE id = ?
        )
      ORDER BY sequence DESC
      LIMIT 20
    ) ORDER BY sequence ASC`).all(threadId, threadId) as MessageRow[];
    return rows.map(rowToMessage);
  }

  /**
   * Insert an assistant message under a caller-supplied deterministic `id`,
   * skipping the write when a row with that id already exists.
   *
   * This mirrors the `INSERT OR IGNORE` pattern the narrative tables use
   * (see {@link ToolCallRecordRepo}). Because the turn's assistant message has a
   * deterministic per-turn identity, a replayed write — a re-run finalize, a
   * retry, or a reconnect replay — collapses onto the same id and is a no-op
   * rather than a duplicate row. The first write wins; a later ignored write
   * does not overwrite its content. The returned record reflects the supplied
   * values (the caller already holds the deterministic id, so re-reading the
   * stored row is unnecessary). Note: on an ignored write the returned
   * `content`, `sequence`, and `timestamp` reflect this call's arguments, not
   * the row already in the database — re-read from the DB if you need the
   * authoritative stored values.
   */
  createAssistantIdempotent(input: {
    id: string;
    threadId: string;
    content: string;
    sequence: number;
    model?: string | null;
    provider?: string | null;
    attachments?: StoredAttachment[];
    mentions?: MessageMention[];
    isInternal?: boolean;
  }): Message {
    const now = new Date().toISOString();
    const modelValue = input.model ?? null;
    const providerValue = input.provider ?? null;
    const attachmentsJson = this.serializeNonEmptyArray(input.attachments);
    const mentionsJson = this.serializeNonEmptyArray(input.mentions);

    const result = this.getCreateAssistantStatement().run(
      input.id,
      input.threadId,
      input.content,
      now,
      input.sequence,
      attachmentsJson,
      mentionsJson,
      modelValue,
      providerValue,
      input.isInternal ? 1 : 0,
    );

    const attachments = this.assistantAttachments(result, input.id, input.attachments);
    return this.createdMessage({
      id: input.id,
      threadId: input.threadId,
      role: "assistant",
      content: input.content,
      sequence: input.sequence,
      timestamp: now,
      attachments,
      mentions: input.mentions,
      model: modelValue,
      isInternal: input.isInternal,
    });
  }

  private serializeNonEmptyArray<T>(value: readonly T[] | undefined): string | null {
    return value && value.length > 0 ? JSON.stringify(value) : null;
  }

  private messageSource(origin: MessageOriginInput): {
    threadId: string | null;
    turnId: string | null;
    providerId: string | null;
  } {
    if (origin.type !== "thread") return { threadId: null, turnId: null, providerId: null };
    return {
      threadId: origin.sourceThreadId,
      turnId: origin.sourceTurnId,
      providerId: origin.sourceProviderId,
    };
  }

  private createdMessage(input: {
    id: string;
    threadId: string;
    role: MessageRole;
    content: string;
    sequence: number;
    timestamp: string;
    attachments?: StoredAttachment[] | null;
    previewAnnotations?: PreviewAnnotationBundle | null;
    mentions?: MessageMention[] | null;
    selectedTextComments?: SelectedTextComment[] | null;
    replyToMessageId?: string;
    quotedText?: string;
    model?: string | null;
    isInternal?: boolean;
    systemNotice?: SystemNoticeMetadata | null;
  }): Message {
    return {
      id: input.id,
      thread_id: input.threadId,
      role: input.role,
      content: input.content,
      tool_calls: null,
      files_changed: null,
      cost_usd: null,
      tokens_used: null,
      timestamp: input.timestamp,
      sequence: input.sequence,
      attachments: input.attachments ?? null,
      previewAnnotations: input.previewAnnotations ?? null,
      mentions: input.mentions ?? null,
      selectedTextComments: input.selectedTextComments ?? null,
      reply_to_message_id: input.replyToMessageId ?? null,
      quoted_text: input.quotedText ?? null,
      model: input.model ?? null,
      is_internal: input.isInternal ?? false,
      outcome: null,
      outcomeExecutionId: null,
      systemNotice: input.systemNotice ?? null,
    };
  }

  private assistantAttachments(
    result: Database.RunResult,
    messageId: string,
    attachments: StoredAttachment[] | undefined,
  ): StoredAttachment[] | null {
    if (result.changes === 0 && attachments && attachments.length > 0) {
      return this.appendAttachments(messageId, attachments);
    }
    return attachments ?? null;
  }

  /** Persist a terminal outcome after the turn finalizer proves the turn ended. */
  setAssistantOutcome(messageId: string, outcome: TurnOutcome, executionId?: string): void {
    this.db
      .prepare("UPDATE messages SET outcome = ?, outcome_execution_id = ? WHERE id = ? AND role = 'assistant'")
      .run(outcome, executionId ?? null, messageId);
  }

  /** Make a staged assistant message visible after its terminal checkpoint commits. */
  publishAssistant(messageId: string): void {
    this.getPublishAssistantStatement().run(messageId);
  }

  /** Return the newest sequence in a thread, including internal rows. */
  getLatestSequenceIncludingInternal(threadId: string): number {
    this.latestSequenceStatement ??= this.db.prepare(
      "SELECT sequence FROM messages WHERE thread_id = ? ORDER BY sequence DESC LIMIT 1",
    );
    const row = this.latestSequenceStatement.get(threadId) as { sequence?: number } | undefined;
    return row?.sequence ?? 0;
  }

  /** Append stored attachments to an existing message, deduping by attachment id. */
  appendAttachments(messageId: string, attachments: StoredAttachment[]): StoredAttachment[] {
    if (attachments.length === 0) return [];
    const row = this.db
      .prepare("SELECT attachments FROM messages WHERE id = ? AND is_internal = 0")
      .get(messageId) as Pick<MessageRow, "attachments"> | undefined;
    const parsed = parseJsonField(row?.attachments ?? null);
    const existing = Array.isArray(parsed)
      ? (parsed as StoredAttachment[])
      : [];
    const byId = new Map(existing.map((att) => [att.id, att]));
    for (const att of attachments) {
      byId.set(att.id, att);
    }
    const merged = [...byId.values()];
    this.db
      .prepare("UPDATE messages SET attachments = ? WHERE id = ? AND is_internal = 0")
      .run(merged.length > 0 ? JSON.stringify(merged) : null, messageId);
    return merged;
  }

  /**
   * Return the last N messages for a thread in ascending sequence order.
   *
   * Uses a sub-select pattern: grab the last N rows by descending sequence,
   * then re-sort ascending so the caller gets chronological order.
   *
   * When `before` is provided, only messages with sequence < before are
   * considered, enabling cursor-based pagination for older messages.
   *
   * Returns `{ messages, hasMore }` where hasMore indicates whether
   * older messages exist beyond this batch (uses limit+1 trick).
   */
  listByThread(
    threadId: string,
    limit: number,
    before?: number,
  ): { messages: Message[]; hasMore: boolean } {
    const clampedLimit = Math.max(1, Math.min(1000, limit));
    const fetchLimit = clampedLimit + 1;

    const whereClause = before != null
      ? "m.thread_id = ? AND m.sequence < ? AND m.is_internal = 0 AND json_extract(m.system_notice, '$.scope') IS NOT 'session'"
      : "m.thread_id = ? AND m.is_internal = 0 AND json_extract(m.system_notice, '$.scope') IS NOT 'session'";
    const queryParams = before != null
      ? [threadId, before, fetchLimit]
      : [threadId, fetchLimit];

    let rows = this.db
      .prepare(pagedMessageQuery(whereClause))
      .all(...queryParams) as MessageRow[];

    const hasMore = rows.length > clampedLimit;
    if (hasMore) {
      rows = rows.slice(rows.length - clampedLimit);
    }

    return { messages: rows.map(rowToMessage), hasMore };
  }

  /** Return the first N messages after a sequence cursor in ascending order. */
  listByThreadAfter(
    threadId: string,
    limit: number,
    after: number,
  ): { messages: Message[]; hasMore: boolean } {
    const clampedLimit = Math.max(1, Math.min(1000, limit));
    const fetchLimit = clampedLimit + 1;
    let rows = this.db
      .prepare(pagedMessageQuery(
        "m.thread_id = ? AND m.sequence > ? AND m.is_internal = 0 AND json_extract(m.system_notice, '$.scope') IS NOT 'session'",
        "ASC",
      ))
      .all(threadId, after, fetchLimit) as MessageRow[];

    const hasMore = rows.length > clampedLimit;
    if (hasMore) rows = rows.slice(0, clampedLimit);
    return { messages: rows.map(rowToMessage), hasMore };
  }

  /** Return a bounded newest transcript window with persisted provenance fields. */
  listByThreadForThreadControl(
    threadId: string,
    limit: number,
    maxBytes = THREAD_GET_TRANSCRIPT_MAX_BYTES,
  ): { messages: ThreadControlMessageRecord[]; hasMore: boolean } {
    const clampedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const byteBudget = Number.isFinite(maxBytes)
      ? Math.max(1, Math.min(THREAD_GET_TRANSCRIPT_MAX_BYTES, Math.floor(maxBytes)))
      : THREAD_GET_TRANSCRIPT_MAX_BYTES;
    const rows = this.db.prepare(`
      SELECT id, sequence, role, length(CAST(content AS BLOB)) AS content_bytes,
             timestamp, provider, model, origin_type,
             source_thread_id, source_turn_id, source_provider_id
      FROM messages
      WHERE thread_id = ? AND is_internal = 0 AND json_extract(system_notice, '$.scope') IS NOT 'session'
      ORDER BY sequence DESC
      LIMIT ?
    `).all(threadId, clampedLimit + 1) as Array<{
      id: string;
      sequence: number;
      role: "user" | "assistant" | "system";
      content_bytes: number;
      timestamp: string;
      provider: string | null;
      model: string | null;
      origin_type: string;
      source_thread_id: string | null;
      source_turn_id: string | null;
      source_provider_id: string | null;
    }>;
    let hasMore = rows.length > clampedLimit;
    const selected: Array<typeof rows[number] & { contentLimit?: number }> = [];
    let remainingBytes = byteBudget;
    for (const row of rows.slice(0, clampedLimit)) {
      const contentBytes = Math.max(0, row.content_bytes ?? 0);
      if (contentBytes <= remainingBytes) {
        selected.push(row);
        remainingBytes -= contentBytes;
        continue;
      }
      if (selected.length === 0) {
        selected.push({ ...row, contentLimit: remainingBytes });
      }
      hasMore = true;
      break;
    }
    const fullStmt = this.db.prepare(`
      SELECT id, role, content, timestamp, provider, model, origin_type,
             source_thread_id, source_turn_id, source_provider_id
      FROM messages
      WHERE id = ? AND thread_id = ? AND is_internal = 0
    `);
    const truncatedStmt = this.db.prepare(`
      SELECT id, role, substr(content, 1, ?) AS content, timestamp, provider, model, origin_type,
             source_thread_id, source_turn_id, source_provider_id
      FROM messages
      WHERE id = ? AND thread_id = ? AND is_internal = 0
    `);
    const messages = selected
      .sort((left, right) => left.sequence - right.sequence)
      .flatMap((row) => {
        const fetched = row.contentLimit === undefined
          ? fullStmt.get(row.id, threadId)
          : truncatedStmt.get(row.contentLimit, row.id, threadId);
        if (!fetched) return [];
        const contentRow = fetched as {
          id: string;
          role: "user" | "assistant" | "system";
          content: string;
          timestamp: string;
          provider: string | null;
          model: string | null;
          origin_type: string;
          source_thread_id: string | null;
          source_turn_id: string | null;
          source_provider_id: string | null;
        };
        const prefix = row.contentLimit === undefined
          ? contentRow.content
          : takeUtf8Prefix(contentRow.content, row.contentLimit).text;
        return [{
          id: contentRow.id,
          role: contentRow.role,
          content: prefix,
          timestamp: contentRow.timestamp,
          provider: contentRow.provider,
          model: contentRow.model,
          originType: contentRow.origin_type === "composer" || contentRow.origin_type === "thread" ? contentRow.origin_type : "legacy",
          sourceThreadId: contentRow.source_thread_id,
          sourceTurnId: contentRow.source_turn_id,
          sourceProviderId: contentRow.source_provider_id,
        } satisfies ThreadControlMessageRecord];
      });
    return {
      messages,
      hasMore,
    };
  }

  /**
   * Return ALL messages for a thread with sequence <= maxSequence,
   * in ascending sequence order. No row limit — used for fork resolution
   * where the full history up to the fork point is needed.
   *
   * Callers must enforce an upper bound on `maxSequence` or total rows
   * (see `AgentService` fork guard) so pathological threads cannot OOM the server.
   */
  listByThreadUpToSequence(
    threadId: string,
    maxSequence: number,
  ): Message[] {
    const rows = this.db
      .prepare(
        `WITH counts AS (
  SELECT message_id, COUNT(*) AS tool_call_count
  FROM tool_call_records
  WHERE message_id IN (
    SELECT id FROM messages WHERE thread_id = ? AND sequence <= ? AND is_internal = 0
  )
  GROUP BY message_id
)
SELECT ${MESSAGE_COLUMNS_PREFIXED}, COALESCE(counts.tool_call_count, 0) AS tool_call_count
FROM messages m
LEFT JOIN counts ON counts.message_id = m.id
WHERE m.thread_id = ? AND m.sequence <= ? AND m.is_internal = 0 AND json_extract(m.system_notice, '$.scope') IS NOT 'session'
ORDER BY m.sequence ASC`,
      )
      .all(threadId, maxSequence, threadId, maxSequence) as MessageRow[];

    return rows.map(rowToMessage);
  }

  /**
   * Return the newest messages at or before `maxSequence` under a byte budget.
   * Reads lightweight metadata in reverse pages, then fetches only retained rows.
   */
  listByThreadUpToSequenceBudgeted(
    threadId: string,
    maxSequence: number,
    options: BudgetedThreadMessageOptions,
  ): BudgetedThreadMessages {
    const { budgetBytes, pageSize, maxRows, internalClause, countInternalClause } =
      this.budgetedHistoryOptions(options);

    const pageStmt = this.db.prepare(
      `SELECT
  m.id,
  m.sequence,
  length(CAST(m.content AS BLOB)) AS content_bytes,
  (
    length(CAST(COALESCE(m.files_changed, '') AS BLOB)) +
    length(CAST(COALESCE(m.attachments, '') AS BLOB)) +
    length(CAST(COALESCE(m.mentions, '') AS BLOB)) +
    length(CAST(COALESCE(m.selected_text_comments, '') AS BLOB)) +
    length(CAST(COALESCE(m.quoted_text, '') AS BLOB))
  ) AS metadata_bytes
FROM messages m
WHERE m.thread_id = ? AND m.sequence <= ? AND m.sequence < ? ${internalClause}
ORDER BY m.sequence DESC
LIMIT ?`,
    );

    const countBeforeStmt = this.db.prepare(
      `SELECT COUNT(*) AS count FROM messages WHERE thread_id = ? AND sequence < ? ${countInternalClause}`,
    );
    const countAtOrBeforeStmt = this.db.prepare(
      `SELECT COUNT(*) AS count FROM messages WHERE thread_id = ? AND sequence <= ? ${countInternalClause}`,
    );

    const selected: Array<{
      id: string;
      sequence: number;
      originalBytes: number;
      truncateContentToBytes?: number;
    }> = [];
    const truncatedMessages: ThreadHistoryBudget["truncatedMessages"] = [];
    let retainedBytes = 0;
    let cursor = maxSequence + 1;
    let omittedBeforeCount = 0;

    while (true) {
      const rows = pageStmt.all(threadId, maxSequence, cursor, pageSize) as MessageBudgetRow[];
      if (rows.length === 0) break;

      for (const row of rows) {
        const contentBytes = Math.max(0, row.content_bytes ?? 0);
        const metadataBytes = Math.max(0, row.metadata_bytes ?? 0);
        const rowBytes = contentBytes + metadataBytes;
        const rowCost = Math.max(1, rowBytes);

        if (retainedBytes + rowCost <= budgetBytes) {
          if (selected.length >= maxRows) {
            const countRow = countAtOrBeforeStmt.get(threadId, row.sequence) as { count: number };
            omittedBeforeCount = countRow.count;
            const fetched = this.fetchBudgetedMessages(selected, truncatedMessages);
            return {
              messages: fetched.messages,
              budget: {
                budgetBytes,
                retainedBytes: retainedBytes + fetched.retainedBytesDelta,
                omittedBeforeCount,
                truncatedMessages,
              },
            };
          }
          selected.push({ id: row.id, sequence: row.sequence, originalBytes: contentBytes });
          retainedBytes += rowCost;
          continue;
        }

        if (selected.length === 0) {
          const contentBudget = Math.max(0, budgetBytes - metadataBytes);
          selected.push({
            id: row.id,
            sequence: row.sequence,
            originalBytes: contentBytes,
            truncateContentToBytes: contentBudget,
          });
          retainedBytes = Math.min(budgetBytes, metadataBytes + contentBudget);
          truncatedMessages.push({
            id: row.id,
            originalBytes: contentBytes,
            retainedBytes: contentBudget,
          });
          const countRow = countBeforeStmt.get(threadId, row.sequence) as { count: number };
          omittedBeforeCount = countRow.count;
        } else {
          const countRow = countAtOrBeforeStmt.get(threadId, row.sequence) as { count: number };
          omittedBeforeCount = countRow.count;
        }

        const fetched = this.fetchBudgetedMessages(selected, truncatedMessages);
        return {
          messages: fetched.messages,
          budget: {
            budgetBytes,
            retainedBytes: retainedBytes + fetched.retainedBytesDelta,
            omittedBeforeCount,
            truncatedMessages,
          },
        };
      }

      cursor = rows[rows.length - 1]!.sequence;
    }

    return {
      messages: this.fetchBudgetedMessages(selected, truncatedMessages).messages,
      budget: {
        budgetBytes,
        retainedBytes,
        omittedBeforeCount,
        truncatedMessages,
      },
    };
  }

  private budgetedHistoryOptions(options: BudgetedThreadMessageOptions): {
    budgetBytes: number;
    pageSize: number;
    maxRows: number;
    internalClause: string;
    countInternalClause: string;
  } {
    const includeInternal = options.includeInternal === true;
    return {
      budgetBytes: clampPositiveInt(options.maxBytes, 1, Number.MAX_SAFE_INTEGER),
      pageSize: clampPositiveInt(
        options.pageSize ?? DEFAULT_HISTORY_PAGE_SIZE,
        DEFAULT_HISTORY_PAGE_SIZE,
        MAX_HISTORY_PAGE_SIZE,
      ),
      maxRows: clampPositiveInt(
        options.maxRows ?? DEFAULT_HISTORY_MAX_ROWS,
        DEFAULT_HISTORY_MAX_ROWS,
        MAX_HISTORY_MAX_ROWS,
      ),
      internalClause: includeInternal ? "" : "AND m.is_internal = 0 AND json_extract(m.system_notice, '$.scope') IS NOT 'session'",
      countInternalClause: includeInternal ? "" : "AND is_internal = 0 AND json_extract(system_notice, '$.scope') IS NOT 'session'",
    };
  }

  private fetchBudgetedMessages(
    selected: Array<{
      id: string;
      sequence: number;
      originalBytes: number;
      truncateContentToBytes?: number;
    }>,
    truncatedMessages: ThreadHistoryBudget["truncatedMessages"],
  ): { messages: Message[]; retainedBytesDelta: number } {
    const toolCallCountSql =
      "(SELECT COUNT(*) FROM tool_call_records WHERE message_id = m.id) AS tool_call_count";
    const fullStmt = this.db.prepare(
      `SELECT
  m.id, m.thread_id, m.role, m.content, NULL AS tool_calls,
  m.files_changed, m.cost_usd, m.tokens_used, m.timestamp, m.sequence,
  m.attachments, m.preview_annotations, m.mentions, m.selected_text_comments, m.reply_to_message_id, m.quoted_text, m.model, m.is_internal,
  m.outcome, m.outcome_execution_id, m.system_notice,
  ${toolCallCountSql}
FROM messages m
WHERE m.id = ?`,
    );
    const truncatedStmt = this.db.prepare(
      `SELECT
  m.id, m.thread_id, m.role, substr(m.content, 1, ?) AS content, NULL AS tool_calls,
  m.files_changed, m.cost_usd, m.tokens_used, m.timestamp, m.sequence,
  m.attachments, m.preview_annotations, m.mentions, m.selected_text_comments, m.reply_to_message_id, m.quoted_text, m.model, m.is_internal,
  m.outcome, m.outcome_execution_id, m.system_notice,
  ${toolCallCountSql}
FROM messages m
WHERE m.id = ?`,
    );

    let retainedBytesDelta = 0;
    const messages = selected
      .sort((a, b) => a.sequence - b.sequence)
      .map((item) => {
        if (item.truncateContentToBytes === undefined) {
          return rowToMessage(fullStmt.get(item.id) as MessageRow);
        }

        const row = truncatedStmt.get(item.truncateContentToBytes, item.id) as MessageRow;
        const prefix = takeUtf8Prefix(row.content, item.truncateContentToBytes);
        row.content = prefix.text;
        const truncated = rowToMessage(row);
        const tracked = item.truncateContentToBytes;
        if (tracked !== prefix.bytes) {
          retainedBytesDelta += prefix.bytes - tracked;
          const budgetEntry = truncatedMessages.find((entry) => entry.id === item.id);
          if (budgetEntry) budgetEntry.retainedBytes = prefix.bytes;
          truncated.content = prefix.text;
        }
        return truncated;
      });
    return { messages, retainedBytesDelta };
  }

  /** Find a single message by ID within a specific thread. Returns null if not found. */
  findByIdInThread(threadId: string, messageId: string): Message | null {
    const row = this.db
      .prepare(
        `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ? AND thread_id = ? AND is_internal = 0`,
      )
      .get(messageId, threadId) as MessageRow | undefined;

    return row ? rowToMessage(row) : null;
  }

  /** Look up a single message by its primary key. */
  findById(id: string): Message | undefined {
    const row = this.db
      .prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ? AND is_internal = 0`)
      .get(id) as MessageRow | undefined;
    return row ? rowToMessage(row) : undefined;
  }

  /**
   * Return ALL messages for a thread in ascending sequence order, including
   * those marked `is_internal = 1`.
   *
   * For internal/pipeline use only (e.g. handoff reconstruction, provider
   * session replay). Never feed this output directly to the chat UI — use
   * `listByThread` instead, which filters out internal messages.
   */
  listIncludingInternal(threadId: string): Message[] {
    const rows = this.db
      .prepare(
        `WITH counts AS (
  SELECT message_id, COUNT(*) AS tool_call_count
  FROM tool_call_records
  WHERE message_id IN (SELECT id FROM messages WHERE thread_id = ?)
  GROUP BY message_id
)
SELECT ${MESSAGE_COLUMNS_PREFIXED}, COALESCE(counts.tool_call_count, 0) AS tool_call_count
FROM messages m
LEFT JOIN counts ON counts.message_id = m.id
WHERE m.thread_id = ?
ORDER BY m.sequence ASC`,
      )
      .all(threadId, threadId) as MessageRow[];

    return rows.map(rowToMessage);
  }
}
