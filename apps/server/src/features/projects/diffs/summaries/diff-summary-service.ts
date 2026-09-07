/**
 * Generates and persists AI-powered diff summaries for threads.
 * Ties together ThreadDiffSource, buildDiffSummaryPrompt, UtilityCompletionService,
 * and the diff_summaries DB table into a single orchestration layer.
 */

import * as NodeCrypto from "node:crypto";
import { injectable, inject } from "tsyringe";
import type { Database, Statement } from "bun:sqlite";
import { logger } from "@mcode/shared";
import { UtilityCompletionService } from "../../../../shared/completion/utility-completion-service.js";
import { SnapshotService } from "../snapshots/snapshot-service.js";
import type { GitExecutor } from "../../git/execution/index.js";
import { ThreadDiffSource } from "./diff-summary-source.js";
import type { TurnSnapshotRow } from "./diff-summary-source.js";
import { buildDiffSummaryPrompt } from "./diff-summary-prompt.js";

/** A persisted diff summary record. */
export interface DiffSummaryRecord {
  id: string;
  threadId: string;
  content: string;
  turnCount: number;
  lastTurnId: string | null;
  model: string;
  createdAt: string;
}

/** Row shape as stored in the diff_summaries table. */
interface DiffSummaryRow {
  id: string;
  thread_id: string;
  content: string;
  turn_count: number;
  last_turn_id: string | null;
  model: string;
  created_at: string;
}

/** Maps a raw DB row to the public DiffSummaryRecord shape. */
function rowToRecord(row: DiffSummaryRow): DiffSummaryRecord {
  return {
    id: row.id,
    threadId: row.thread_id,
    content: row.content,
    turnCount: row.turn_count,
    lastTurnId: row.last_turn_id,
    model: row.model,
    createdAt: row.created_at,
  };
}

/**
 * Generates and persists AI-powered diff summaries for threads.
 */
@injectable()
export class DiffSummaryService {
  private readonly stmtGet: Statement;
  private readonly stmtInsert: Statement;

  constructor(
    @inject(UtilityCompletionService)
    private readonly utilityCompletion: UtilityCompletionService,
    @inject(SnapshotService)
    private readonly snapshotService: SnapshotService,
    @inject("GitExecutor")
    private readonly gitExecutor: GitExecutor,
    @inject("Database")
    db: Database,
  ) {
    this.stmtGet = db.prepare(
      "SELECT id, thread_id, content, turn_count, last_turn_id, model, created_at FROM diff_summaries WHERE thread_id = ? LIMIT 1",
    );
    this.stmtInsert = db.prepare(
      "INSERT OR REPLACE INTO diff_summaries (id, thread_id, content, turn_count, last_turn_id, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
  }

  /** Get the stored summary for a thread, if one exists. */
  get(threadId: string): DiffSummaryRecord | null {
    const row = this.stmtGet.get(threadId) as DiffSummaryRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  /**
   * Generate a summary from pre-fetched snapshots.
   * Used by the RPC handler which already has the snapshots and cwd.
   */
  async generateFromSnapshots(
    threadId: string,
    snapshots: TurnSnapshotRow[],
    cwd: string,
  ): Promise<DiffSummaryRecord> {
    const source = new ThreadDiffSource(
      snapshots,
      cwd,
      this.snapshotService,
      this.gitExecutor,
    );

    const payload = await source.getDiff();

    if (payload.turnCount === 0) {
      throw new Error("No file changes to summarize");
    }

    const prompt = buildDiffSummaryPrompt(payload);
    const { text: content, model } = await this.utilityCompletion.complete(prompt, cwd);

    const record: DiffSummaryRecord = {
      id: NodeCrypto.randomUUID(),
      threadId,
      content,
      turnCount: payload.turnCount,
      lastTurnId: payload.lastTurnId,
      model,
      createdAt: new Date().toISOString(),
    };

    // Atomic upsert via INSERT OR REPLACE (unique index on thread_id)
    this.stmtInsert.run(
      record.id,
      record.threadId,
      record.content,
      record.turnCount,
      record.lastTurnId,
      record.model,
      record.createdAt,
    );

    logger.info(`Generated diff summary for thread ${threadId} (${payload.turnCount} turns)`);

    return record;
  }
}
