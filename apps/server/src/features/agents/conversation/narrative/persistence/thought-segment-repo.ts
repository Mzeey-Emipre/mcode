/**
 * Thought segment record data access layer.
 * Provides creation and retrieval operations for persisted thought segments.
 */

import * as NodeCrypto from "node:crypto";
import { injectable, inject } from "tsyringe";
import type Database from "better-sqlite3";
import type { ThoughtSegmentRecord } from "@mcode/contracts";
import {
  ACTIVE_TURN_WRITE_BATCH_LIMITS,
  runBoundedWriteBatches,
  type WriteBatchLimits,
  type WriteBatchResult,
} from "../../../../../runtime/persistence/sqlite/bounded-write-batches.js";

/** Row shape returned by SQLite for the thought_segments table. */
interface ThoughtSegmentRow {
  id: string;
  message_id: string;
  text: string;
  started_at: string;
  ended_at: string | null;
  sort_order: number;
  is_final_response: number;
}

/** Input for creating a new thought segment record. */
export interface CreateThoughtSegmentInput {
  /** Optional explicit id; generated if omitted. */
  id?: string;
  messageId: string;
  text: string;
  startedAt: string;
  endedAt: string | null;
  sortOrder: number;
  /** Non-zero when this segment is the assistant's final user-facing response. */
  isFinalResponse?: number;
}

function rowToRecord(row: ThoughtSegmentRow): ThoughtSegmentRecord {
  return {
    id: row.id,
    message_id: row.message_id,
    text: row.text,
    started_at: row.started_at,
    ended_at: row.ended_at,
    sort_order: row.sort_order,
    is_final_response: row.is_final_response,
  };
}

const COLUMNS = "id, message_id, text, started_at, ended_at, sort_order, is_final_response";

/** Repository for thought segment creation and retrieval against SQLite. */
@injectable()
export class ThoughtSegmentRepo {
  private readonly stmtInsert: Database.Statement;
  private readonly stmtListByMessage: Database.Statement;
  private readonly stmtCountByMessage: Database.Statement;

  constructor(@inject("Database") private readonly db: Database.Database) {
    this.stmtInsert = db.prepare(
      "INSERT OR IGNORE INTO thought_segments (id, message_id, text, started_at, ended_at, sort_order, is_final_response) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    this.stmtListByMessage = db.prepare(
      `SELECT ${COLUMNS} FROM thought_segments WHERE message_id = ? ORDER BY sort_order ASC`,
    );
    this.stmtCountByMessage = db.prepare(
      "SELECT COUNT(*) as count FROM thought_segments WHERE message_id = ?",
    );
  }

  /** Create a single thought segment record and return the fully-populated record. */
  create(input: CreateThoughtSegmentInput): ThoughtSegmentRecord {
    const id = input.id ?? NodeCrypto.randomUUID();
    const isFinalResponse = input.isFinalResponse ?? 0;
    this.stmtInsert.run(
      id,
      input.messageId,
      input.text,
      input.startedAt,
      input.endedAt,
      input.sortOrder,
      isFinalResponse,
    );
    return {
      id,
      message_id: input.messageId,
      text: input.text,
      started_at: input.startedAt,
      ended_at: input.endedAt,
      sort_order: input.sortOrder,
      is_final_response: isFinalResponse,
    };
  }

  /** Insert multiple thought segment records in a single transaction. */
  bulkCreate(inputs: CreateThoughtSegmentInput[]): void {
    if (inputs.length === 0) return;
    const tx = this.db.transaction((items: CreateThoughtSegmentInput[]) => {
      for (const item of items) {
        this.stmtInsert.run(
          item.id ?? NodeCrypto.randomUUID(),
          item.messageId,
          item.text,
          item.startedAt,
          item.endedAt,
          item.sortOrder,
          item.isFinalResponse ?? 0,
        );
      }
    });
    tx(inputs);
  }

  /** Insert thought rows in bounded transactions with an event-loop yield between commits. */
  async bulkCreateBatched(
    inputs: readonly CreateThoughtSegmentInput[],
    limits: WriteBatchLimits = ACTIVE_TURN_WRITE_BATCH_LIMITS,
  ): Promise<WriteBatchResult> {
    return runBoundedWriteBatches({
      db: this.db,
      items: inputs,
      limits,
      byteLength: (item) => Buffer.byteLength(JSON.stringify(item), "utf8"),
      write: (item) => {
        this.stmtInsert.run(
          item.id ?? NodeCrypto.randomUUID(),
          item.messageId,
          item.text,
          item.startedAt,
          item.endedAt,
          item.sortOrder,
          item.isFinalResponse ?? 0,
        );
      },
    });
  }

  /** List all thought segments for a message, ordered by sort_order ascending. */
  listByMessage(messageId: string): ThoughtSegmentRecord[] {
    const rows = this.stmtListByMessage.all(messageId) as ThoughtSegmentRow[];
    return rows.map(rowToRecord);
  }

  /** List thought segments for many messages in one indexed query, grouped by message id. */
  listByMessages(messageIds: readonly string[]): Map<string, ThoughtSegmentRecord[]> {
    const grouped = new Map<string, ThoughtSegmentRecord[]>();
    if (messageIds.length === 0) return grouped;

    const placeholders = messageIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM thought_segments WHERE message_id IN (${placeholders}) ORDER BY message_id ASC, sort_order ASC`,
      )
      .all(...messageIds) as ThoughtSegmentRow[];

    for (const row of rows) {
      const record = rowToRecord(row);
      const list = grouped.get(record.message_id) ?? [];
      list.push(record);
      grouped.set(record.message_id, list);
    }
    return grouped;
  }

  /** Count the number of thought segments for a message. */
  countByMessage(messageId: string): number {
    const row = this.stmtCountByMessage.get(messageId) as { count: number };
    return row.count;
  }
}
