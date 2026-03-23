import { randomUUID } from "crypto";
import type Database from "better-sqlite3";
import type { Message, MessageRole, StoredAttachment } from "../models.js";

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
  return {
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
    attachments: parseJsonField(row.attachments) as StoredAttachment[] | null,
  };
}

const MESSAGE_COLUMNS =
  "id, thread_id, role, content, tool_calls, files_changed, cost_usd, tokens_used, timestamp, sequence, attachments";

export function create(
  db: Database.Database,
  threadId: string,
  role: MessageRole,
  content: string,
  sequence: number,
  attachments?: StoredAttachment[],
): Message {
  const id = randomUUID();
  const now = new Date().toISOString();
  const attachmentsJson = attachments && attachments.length > 0 ? JSON.stringify(attachments) : null;

  db.prepare(
    "INSERT INTO messages (id, thread_id, role, content, timestamp, sequence, attachments) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, threadId, role, content, now, sequence, attachmentsJson);

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
 */
export function listByThread(
  db: Database.Database,
  threadId: string,
  limit: number,
): Message[] {
  const clampedLimit = Math.max(1, Math.min(1000, limit));

  const rows = db
    .prepare(
      `SELECT ${MESSAGE_COLUMNS} FROM (SELECT ${MESSAGE_COLUMNS} FROM messages WHERE thread_id = ? ORDER BY sequence DESC LIMIT ?) ORDER BY sequence ASC`,
    )
    .all(threadId, clampedLimit) as MessageRow[];

  return rows.map(rowToMessage);
}
