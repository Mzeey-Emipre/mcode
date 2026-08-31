/**
 * Hook execution record data access layer.
 * Provides creation and retrieval operations for persisted hook executions.
 */

import * as NodeCrypto from "node:crypto";
import { injectable, inject } from "tsyringe";
import type Database from "better-sqlite3";
import type { HookExecutionRecord } from "@mcode/contracts";
import {
  ACTIVE_TURN_WRITE_BATCH_LIMITS,
  runBoundedWriteBatches,
  type WriteBatchLimits,
  type WriteBatchResult,
} from "../../../../runtime/persistence/sqlite/bounded-write-batches.js";

/** Row shape returned by SQLite for the hook_executions table. */
interface HookExecutionRow {
  id: string;
  message_id: string;
  hook_name: string;
  tool_name: string | null;
  phase: string;
  payload: string;
  duration_ms: number | null;
  did_block: number;
  started_at: string;
  ended_at: string | null;
  sort_order: number;
}

/** Input for creating a new hook execution record. */
export interface CreateHookExecutionInput {
  /** Optional explicit id; generated if omitted. */
  id?: string;
  messageId: string;
  hookName: string;
  toolName: string | null;
  phase: string;
  payload: string;
  durationMs: number | null;
  didBlock: boolean;
  startedAt: string;
  endedAt: string | null;
  sortOrder: number;
}

function rowToRecord(row: HookExecutionRow): HookExecutionRecord {
  return {
    id: row.id,
    message_id: row.message_id,
    hook_name: row.hook_name,
    tool_name: row.tool_name,
    phase: row.phase,
    payload: row.payload,
    duration_ms: row.duration_ms,
    did_block: row.did_block === 1,
    started_at: row.started_at,
    ended_at: row.ended_at,
    sort_order: row.sort_order,
  };
}

const COLUMNS =
  "id, message_id, hook_name, tool_name, phase, payload, duration_ms, did_block, started_at, ended_at, sort_order";

/** Repository for hook execution creation and retrieval against SQLite. */
@injectable()
export class HookExecutionRepo {
  private readonly stmtInsert: Database.Statement;
  private readonly stmtListByMessage: Database.Statement;
  private readonly stmtCountByMessage: Database.Statement;

  constructor(@inject("Database") private readonly db: Database.Database) {
    this.stmtInsert = db.prepare(
      "INSERT OR IGNORE INTO hook_executions (id, message_id, hook_name, tool_name, phase, payload, duration_ms, did_block, started_at, ended_at, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    this.stmtListByMessage = db.prepare(
      `SELECT ${COLUMNS} FROM hook_executions WHERE message_id = ? ORDER BY sort_order ASC`,
    );
    this.stmtCountByMessage = db.prepare(
      "SELECT COUNT(*) as count FROM hook_executions WHERE message_id = ?",
    );
  }

  /** Create a single hook execution record and return the fully-populated record. */
  create(input: CreateHookExecutionInput): HookExecutionRecord {
    const id = input.id ?? NodeCrypto.randomUUID();
    this.stmtInsert.run(
      id,
      input.messageId,
      input.hookName,
      input.toolName,
      input.phase,
      input.payload,
      input.durationMs,
      input.didBlock ? 1 : 0,
      input.startedAt,
      input.endedAt,
      input.sortOrder,
    );
    return {
      id,
      message_id: input.messageId,
      hook_name: input.hookName,
      tool_name: input.toolName,
      phase: input.phase,
      payload: input.payload,
      duration_ms: input.durationMs,
      did_block: input.didBlock,
      started_at: input.startedAt,
      ended_at: input.endedAt,
      sort_order: input.sortOrder,
    };
  }

  /** Insert multiple hook execution records in a single transaction. */
  bulkCreate(inputs: CreateHookExecutionInput[]): void {
    if (inputs.length === 0) return;
    const tx = this.db.transaction((items: CreateHookExecutionInput[]) => {
      for (const item of items) {
        this.stmtInsert.run(
          item.id ?? NodeCrypto.randomUUID(),
          item.messageId,
          item.hookName,
          item.toolName,
          item.phase,
          item.payload,
          item.durationMs,
          item.didBlock ? 1 : 0,
          item.startedAt,
          item.endedAt,
          item.sortOrder,
        );
      }
    });
    tx(inputs);
  }

  /** Insert hook rows in bounded transactions with an event-loop yield between commits. */
  async bulkCreateBatched(
    inputs: readonly CreateHookExecutionInput[],
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
          item.hookName,
          item.toolName,
          item.phase,
          item.payload,
          item.durationMs,
          item.didBlock ? 1 : 0,
          item.startedAt,
          item.endedAt,
          item.sortOrder,
        );
      },
    });
  }

  /** List all hook executions for a message, ordered by sort_order ascending. */
  listByMessage(messageId: string): HookExecutionRecord[] {
    const rows = this.stmtListByMessage.all(messageId) as HookExecutionRow[];
    return rows.map(rowToRecord);
  }

  /** List hook executions for many messages in one indexed query, grouped by message id. */
  listByMessages(messageIds: readonly string[]): Map<string, HookExecutionRecord[]> {
    const grouped = new Map<string, HookExecutionRecord[]>();
    if (messageIds.length === 0) return grouped;

    const placeholders = messageIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM hook_executions WHERE message_id IN (${placeholders}) ORDER BY message_id ASC, sort_order ASC`,
      )
      .all(...messageIds) as HookExecutionRow[];

    for (const row of rows) {
      const record = rowToRecord(row);
      const list = grouped.get(record.message_id) ?? [];
      list.push(record);
      grouped.set(record.message_id, list);
    }
    return grouped;
  }

  /** Count the number of hook executions for a message. */
  countByMessage(messageId: string): number {
    const row = this.stmtCountByMessage.get(messageId) as { count: number };
    return row.count;
  }
}
