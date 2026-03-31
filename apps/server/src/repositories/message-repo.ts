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
  };

  if (row.tool_call_count && row.tool_call_count > 0) {
    msg.tool_call_count = row.tool_call_count;
  }

  return msg;
}

const MESSAGE_COLUMNS =
  "id, thread_id, role, content, tool_calls, files_changed, cost_usd, tokens_used, timestamp, sequence, attachments";

const MESSAGE_COLUMNS_PREFIXED =
  "m.id, m.thread_id, m.role, m.content, m.tool_calls, m.files_changed, m.cost_usd, m.tokens_used, m.timestamp, m.sequence, m.attachments";

/** Repository for message creation and retrieval against SQLite. */
@injectable()
export class MessageRepo {
  constructor(@inject("Database") private readonly db: Database.Database) {}

  /** Create a new message and return the fully-populated record. */
  create(
    threadId: string,
    role: MessageRole,
    content: string,
    sequence: number,
    attachments?: StoredAttachment[],
  ): Message {
    const id = randomUUID();
    const now = new Date().toISOString();
    const attachmentsJson =
      attachments && attachments.length > 0
        ? JSON.stringify(attachments)
        : null;

    this.db
      .prepare(
        "INSERT INTO messages (id, thread_id, role, content, timestamp, sequence, attachments) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, threadId, role, content, now, sequence, attachmentsJson);

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
    };
  }

  /**
   * Return the last N messages for a thread in ascending sequence order.
   *
   * Uses a sub-select pattern: grab the last N rows by descending sequence,
   * then re-sort ascending so the caller gets chronological order.
   *
   * When `before` is provided, only messages with sequence < before are
   * considered, enabling cursor-based pagination for older messages.
   */
  listByThread(threadId: string, limit: number, before?: number): Message[] {
    const clampedLimit = Math.max(1, Math.min(1000, limit));

    const whereClause = before != null
      ? "m.thread_id = ? AND m.sequence < ?"
      : "m.thread_id = ?";
    const queryParams = before != null
      ? [threadId, before, clampedLimit]
      : [threadId, clampedLimit];

    const rows = this.db
      .prepare(
        `SELECT ${MESSAGE_COLUMNS}, tc_count.cnt as tool_call_count
FROM (
  SELECT ${MESSAGE_COLUMNS_PREFIXED}
  FROM messages m
  WHERE ${whereClause}
  ORDER BY m.sequence DESC
  LIMIT ?
) m
LEFT JOIN (
  SELECT message_id, COUNT(*) as cnt
  FROM tool_call_records
  GROUP BY message_id
) tc_count ON tc_count.message_id = m.id
ORDER BY m.sequence ASC`,
      )
      .all(...queryParams) as MessageRow[];

    return rows.map(rowToMessage);
  }
}
