/**
 * Message data access layer.
 * Provides creation and retrieval operations for message records in SQLite.
 */

import { randomUUID } from "crypto";
import { injectable, inject } from "tsyringe";
import type Database from "better-sqlite3";
import type {
  Message,
  MessageRole,
  StoredAttachment,
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
  reply_to_message_id: string | null;
  quoted_text: string | null;
  model: string | null;
  is_internal: number;
  tool_call_count?: number;
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
    reply_to_message_id: row.reply_to_message_id,
    quoted_text: row.quoted_text,
    model: row.model,
    is_internal: row.is_internal === 1,
  };

  if (row.tool_call_count && row.tool_call_count > 0) {
    msg.tool_call_count = row.tool_call_count;
  }

  return msg;
}

const MESSAGE_COLUMNS =
  "id, thread_id, role, content, tool_calls, files_changed, cost_usd, tokens_used, timestamp, sequence, attachments, reply_to_message_id, quoted_text, model, is_internal";

const MESSAGE_COLUMNS_PREFIXED =
  "m.id, m.thread_id, m.role, m.content, m.tool_calls, m.files_changed, m.cost_usd, m.tokens_used, m.timestamp, m.sequence, m.attachments, m.reply_to_message_id, m.quoted_text, m.model, m.is_internal";

/**
 * Per-row tool call counts via index on `message_id`.
 * Avoids a full-table `GROUP BY` over `tool_call_records` for each list query.
 */
const TOOL_CALL_COUNT_SQL =
  "(SELECT COUNT(*) FROM tool_call_records WHERE message_id = m.id) AS tool_call_count";

/** Repository for message creation and retrieval against SQLite. */
@injectable()
export class MessageRepo {
  constructor(@inject("Database") private readonly db: Database.Database) {}

  /**
   * Create a new message and return the fully-populated record.
   *
   * `model` records the model identifier active when an assistant message was
   * produced (e.g. "claude-opus-4-7"). Null for user/system messages and
   * acceptable for assistant messages when the provider doesn't surface a
   * model — the UI footer falls back gracefully.
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
  ): Message {
    const id = randomUUID();
    const now = new Date().toISOString();
    const attachmentsJson =
      attachments && attachments.length > 0
        ? JSON.stringify(attachments)
        : null;
    const modelValue = model ?? null;
    const isInternalValue = isInternal ? 1 : 0;

    this.db
      .prepare(
        "INSERT INTO messages (id, thread_id, role, content, timestamp, sequence, attachments, reply_to_message_id, quoted_text, model, is_internal) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id, threadId, role, content, now, sequence,
        attachmentsJson, replyToMessageId ?? null, quotedText ?? null, modelValue, isInternalValue,
      );

    return {
      id,
      thread_id: threadId,
      role,
      content,
      tool_calls: null,
      files_changed: null,
      cost_usd: null,
      tokens_used: null,
      timestamp: now,
      sequence,
      attachments: attachments ?? null,
      reply_to_message_id: replyToMessageId ?? null,
      quoted_text: quotedText ?? null,
      model: modelValue,
      is_internal: isInternal ?? false,
    };
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
    attachments?: StoredAttachment[];
  }): Message {
    const now = new Date().toISOString();
    const modelValue = input.model ?? null;
    const attachmentsJson =
      input.attachments && input.attachments.length > 0
        ? JSON.stringify(input.attachments)
        : null;

    const result = this.db
      .prepare(
        "INSERT OR IGNORE INTO messages (id, thread_id, role, content, timestamp, sequence, attachments, model, is_internal) VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, 0)",
      )
      .run(input.id, input.threadId, input.content, now, input.sequence, attachmentsJson, modelValue);

    const attachments =
      result.changes === 0 && input.attachments && input.attachments.length > 0
        ? this.appendAttachments(input.id, input.attachments)
        : (input.attachments ?? null);

    return {
      id: input.id,
      thread_id: input.threadId,
      role: "assistant",
      content: input.content,
      tool_calls: null,
      files_changed: null,
      cost_usd: null,
      tokens_used: null,
      timestamp: now,
      sequence: input.sequence,
      attachments,
      reply_to_message_id: null,
      quoted_text: null,
      model: modelValue,
      is_internal: false,
    };
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
      ? "m.thread_id = ? AND m.sequence < ? AND m.is_internal = 0"
      : "m.thread_id = ? AND m.is_internal = 0";
    const queryParams = before != null
      ? [threadId, before, fetchLimit]
      : [threadId, fetchLimit];

    let rows = this.db
      .prepare(
        `SELECT ${MESSAGE_COLUMNS}, ${TOOL_CALL_COUNT_SQL}
FROM (
  SELECT ${MESSAGE_COLUMNS_PREFIXED}
  FROM messages m
  WHERE ${whereClause}
  ORDER BY m.sequence DESC
  LIMIT ?
) m
ORDER BY m.sequence ASC`,
      )
      .all(...queryParams) as MessageRow[];

    const hasMore = rows.length > clampedLimit;
    if (hasMore) {
      rows = rows.slice(rows.length - clampedLimit);
    }

    return { messages: rows.map(rowToMessage), hasMore };
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
        `SELECT ${MESSAGE_COLUMNS_PREFIXED}, ${TOOL_CALL_COUNT_SQL}
FROM messages m
WHERE m.thread_id = ? AND m.sequence <= ? AND m.is_internal = 0
ORDER BY m.sequence ASC`,
      )
      .all(threadId, maxSequence) as MessageRow[];

    return rows.map(rowToMessage);
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
        `SELECT ${MESSAGE_COLUMNS_PREFIXED}, ${TOOL_CALL_COUNT_SQL}
FROM messages m
WHERE m.thread_id = ?
ORDER BY m.sequence ASC`,
      )
      .all(threadId) as MessageRow[];

    return rows.map(rowToMessage);
  }
}
