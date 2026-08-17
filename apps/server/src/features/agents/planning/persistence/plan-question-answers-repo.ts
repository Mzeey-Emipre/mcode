/**
 * Plan-question wizard answered-marker data access layer.
 *
 * Records that the user has submitted answers for the plan-questions block
 * embedded in a specific assistant message. The marker is what suppresses the
 * wizard from re-popping after server restarts or mid-turn errors. Sidecar
 * table; FK CASCADE on both `assistant_message_id` and `thread_id` keeps it
 * self-pruning when parent rows are deleted.
 */

import { injectable, inject } from "tsyringe";
import type Database from "better-sqlite3";

/** Repository for the `plan_question_answers` sidecar table. */
@injectable()
export class PlanQuestionAnswersRepo {
  private readonly stmtMark;
  private readonly stmtIsAnswered;
  private readonly stmtListForThread;

  constructor(@inject("Database") db: Database.Database) {
    this.stmtMark = db.prepare(`
      INSERT OR IGNORE INTO plan_question_answers (assistant_message_id, thread_id)
      VALUES (?, ?)
    `);
    this.stmtIsAnswered = db.prepare(
      "SELECT 1 FROM plan_question_answers WHERE assistant_message_id = ?",
    );
    this.stmtListForThread = db.prepare(
      "SELECT assistant_message_id FROM plan_question_answers WHERE thread_id = ? ORDER BY answered_at ASC",
    );
  }

  /**
   * Persist the answered marker for an assistant plan-questions message.
   * Idempotent: re-marking the same id is a no-op via INSERT OR IGNORE.
   */
  markAnswered(assistantMessageId: string, threadId: string): void {
    this.stmtMark.run(assistantMessageId, threadId);
  }

  /** True iff a marker exists for the given assistant message id. */
  isAnswered(assistantMessageId: string): boolean {
    return this.stmtIsAnswered.get(assistantMessageId) !== undefined;
  }

  /** All answered assistant-message ids for a thread, oldest first. */
  listAnsweredForThread(threadId: string): string[] {
    const rows = this.stmtListForThread.all(threadId) as {
      assistant_message_id: string;
    }[];
    return rows.map((r) => r.assistant_message_id);
  }
}
