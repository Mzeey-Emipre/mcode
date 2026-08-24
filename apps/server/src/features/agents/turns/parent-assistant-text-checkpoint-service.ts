import type Database from "better-sqlite3";
import { inject, injectable } from "tsyringe";
import { ACTIVE_TURN_WRITE_BATCH_LIMITS } from "../../../runtime/persistence/sqlite/bounded-write-batches.js";

/** Default retained recovery limits for one unfinished assistant response. */
export const PARENT_ASSISTANT_TEXT_RETAINED_LIMITS = {
  maxBytes: ACTIVE_TURN_WRITE_BATCH_LIMITS.maxBytes,
  maxChunks: 16_384,
} as const;

/** Measured production policy for durable assistant-text publication. */
export const PARENT_ASSISTANT_TEXT_QUEUE_POLICY = {
  maxChunkBytes: 16 * 1024,
  maxQueuedEvents: ACTIVE_TURN_WRITE_BATCH_LIMITS.maxRows - 1,
  maxAgeMs: 250,
} as const;

/** One ordered assistant-text delta accepted for durable publication. */
export interface ParentAssistantTextCheckpointInput {
  executionId: string;
  threadId: string;
  turnId: string;
  sequence: number;
  text: string;
}

/** Retention limits for one unfinished assistant response. */
export interface ParentAssistantTextCheckpointLimits {
  maxBytes: number;
  maxChunks: number;
}

/** Result of committing one concatenated assistant-text chunk. */
export interface ParentAssistantTextCheckpointResult {
  outcome: "committed" | "duplicate" | "overflow";
  durableThrough: number;
  committedItems: number;
  committedBytes: number;
}

/** One durable assistant-text chunk restored in accepted order. */
export interface RestoredParentAssistantTextChunk {
  firstSequence: number;
  lastSequence: number;
  text: string;
  byteLength: number;
}

/** Persists bounded chunks for unfinished ordinary parent assistant responses. */
@injectable()
export class ParentAssistantTextCheckpointService {
  constructor(
    @inject("Database") private readonly db: Database.Database,
    @inject("ParentAssistantTextCheckpointLimits", { isOptional: true })
    private readonly limits: ParentAssistantTextCheckpointLimits = PARENT_ASSISTANT_TEXT_RETAINED_LIMITS,
  ) {}

  /** Commit consecutive deltas as one durable chunk and advance its cursor atomically. */
  appendChunk(inputs: readonly ParentAssistantTextCheckpointInput[]): ParentAssistantTextCheckpointResult {
    const prepared = this.prepareChunk(inputs);
    const first = prepared.inputs[0]!;
    const last = prepared.inputs.at(-1)!;

    return this.db.transaction(() => {
      const checkpoint = this.db.prepare(`
        SELECT thread_id, turn_id, last_sequence, retained_bytes, retained_chunks
        FROM parent_assistant_text_checkpoints
        WHERE execution_id = ?
      `).get(first.executionId) as {
        thread_id: string;
        turn_id: string;
        last_sequence: number;
        retained_bytes: number;
        retained_chunks: number;
      } | undefined;

      if (checkpoint && (checkpoint.thread_id !== first.threadId || checkpoint.turn_id !== first.turnId)) {
        throw new Error("Assistant text checkpoint routing conflicts with its execution");
      }

      const durableThrough = checkpoint?.last_sequence ?? 0;
      if (first.sequence <= durableThrough) {
        if (last.sequence > durableThrough) {
          throw new Error("Assistant text checkpoint retry overlaps durable and new text");
        }
        const duplicate = this.db.prepare(`
          SELECT text, byte_length
          FROM parent_assistant_text_checkpoint_chunks
          WHERE execution_id = ? AND first_sequence = ? AND last_sequence = ?
        `).get(first.executionId, first.sequence, last.sequence) as {
          text: string;
          byte_length: number;
        } | undefined;
        if (!duplicate || duplicate.text !== prepared.text || duplicate.byte_length !== prepared.byteLength) {
          throw new Error("Assistant text checkpoint duplicate conflicts with durable text");
        }
        return {
          outcome: "duplicate" as const,
          durableThrough,
          committedItems: 0,
          committedBytes: 0,
        };
      }
      if (first.sequence !== durableThrough + 1) {
        throw new Error(`Assistant text checkpoint sequence gap: expected ${durableThrough + 1}, received ${first.sequence}`);
      }

      const retainedBytes = (checkpoint?.retained_bytes ?? 0) + prepared.byteLength;
      const retainedChunks = (checkpoint?.retained_chunks ?? 0) + 1;
      if (retainedBytes > this.limits.maxBytes || retainedChunks > this.limits.maxChunks) {
        return {
          outcome: "overflow" as const,
          durableThrough,
          committedItems: 0,
          committedBytes: 0,
        };
      }

      const updatedAt = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO parent_assistant_text_checkpoints (
          execution_id, thread_id, turn_id, last_sequence, retained_bytes, retained_chunks, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(execution_id) DO UPDATE SET
          last_sequence = excluded.last_sequence,
          retained_bytes = excluded.retained_bytes,
          retained_chunks = excluded.retained_chunks,
          updated_at = excluded.updated_at
      `).run(
        first.executionId,
        first.threadId,
        first.turnId,
        last.sequence,
        retainedBytes,
        retainedChunks,
        updatedAt,
      );
      this.db.prepare(`
        INSERT INTO parent_assistant_text_checkpoint_chunks (
          execution_id, first_sequence, last_sequence, text, byte_length
        ) VALUES (?, ?, ?, ?, ?)
      `).run(first.executionId, first.sequence, last.sequence, prepared.text, prepared.byteLength);

      return {
        outcome: "committed" as const,
        durableThrough: last.sequence,
        committedItems: prepared.inputs.length,
        committedBytes: prepared.byteLength,
      };
    })();
  }

  /** Restore the exact durable text prefix in accepted order. */
  restore(executionId: string): string {
    return this.restoreChunks(executionId).map((chunk) => chunk.text).join("");
  }

  /** Restore durable chunks in accepted order for recovery and diagnostics. */
  restoreChunks(executionId: string): RestoredParentAssistantTextChunk[] {
    const rows = this.db.prepare(`
      SELECT first_sequence, last_sequence, text, byte_length
      FROM parent_assistant_text_checkpoint_chunks
      WHERE execution_id = ?
      ORDER BY first_sequence ASC
    `).all(executionId) as Array<{
      first_sequence: number;
      last_sequence: number;
      text: string;
      byte_length: number;
    }>;
    return rows.map((row) => ({
      firstSequence: row.first_sequence,
      lastSequence: row.last_sequence,
      text: row.text,
      byteLength: row.byte_length,
    }));
  }

  /** Discard provisional text for an unfinished execution before a fresh retry. */
  reset(executionId: string): boolean {
    return this.db.transaction(() => this.db.prepare(`
      DELETE FROM parent_assistant_text_checkpoints
      WHERE execution_id = ?
        AND EXISTS (
          SELECT 1 FROM canonical_agent_ingest_checkpoints
          WHERE execution_id = parent_assistant_text_checkpoints.execution_id
            AND terminal_outcome IS NULL
        )
    `).run(executionId).changes === 1)();
  }

  /** Retire provisional text only after the canonical execution is terminal. */
  retire(executionId: string): boolean {
    return this.db.transaction(() => {
      const terminal = this.db.prepare(`
        SELECT 1 FROM canonical_agent_ingest_checkpoints
        WHERE execution_id = ? AND terminal_outcome IS NOT NULL
      `).get(executionId);
      if (!terminal) return false;
      return this.db.prepare(
        "DELETE FROM parent_assistant_text_checkpoints WHERE execution_id = ?",
      ).run(executionId).changes === 1;
    })();
  }

  /** Remove stale provisional data whose canonical executions are already terminal. */
  retireTerminalCheckpoints(): number {
    return this.db.prepare(`
      DELETE FROM parent_assistant_text_checkpoints
      WHERE EXISTS (
        SELECT 1 FROM canonical_agent_ingest_checkpoints
        WHERE execution_id = parent_assistant_text_checkpoints.execution_id
          AND terminal_outcome IS NOT NULL
      )
    `).run().changes;
  }

  private prepareChunk(inputs: readonly ParentAssistantTextCheckpointInput[]): {
    inputs: readonly ParentAssistantTextCheckpointInput[];
    text: string;
    byteLength: number;
  } {
    if (inputs.length === 0) throw new Error("Assistant text checkpoint chunk must not be empty");
    if (inputs.length > ACTIVE_TURN_WRITE_BATCH_LIMITS.maxRows - 1) {
      throw new Error("Assistant text checkpoint chunk exceeds the active-turn row limit");
    }
    const first = inputs[0]!;
    for (const [index, input] of inputs.entries()) {
      if (input.executionId !== first.executionId || input.threadId !== first.threadId || input.turnId !== first.turnId) {
        throw new Error("Assistant text checkpoint chunk mixes execution routing");
      }
      if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) {
        throw new Error("Assistant text checkpoint sequence must be a positive safe integer");
      }
      if (input.sequence !== first.sequence + index) {
        throw new Error("Assistant text checkpoint chunk sequences must be consecutive");
      }
      if (Buffer.byteLength(input.text, "utf8") === 0) {
        throw new Error("Assistant text checkpoint delta must contain text");
      }
    }
    const text = inputs.map((input) => input.text).join("");
    const byteLength = Buffer.byteLength(text, "utf8");
    if (byteLength > ACTIVE_TURN_WRITE_BATCH_LIMITS.maxBytes) {
      throw new Error("Assistant text checkpoint chunk exceeds the active-turn byte limit");
    }
    return { inputs, text, byteLength };
  }
}

/** Policy controlling durable chunk size, queue growth, and display delay. */
export interface ParentAssistantTextCheckpointQueuePolicy {
  maxChunkBytes: number;
  maxQueuedEvents: number;
  maxAgeMs: number;
}

/** Scheduler seam for deterministic queue cadence tests. */
export interface ParentAssistantTextCheckpointQueueScheduler {
  now(): number;
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

/** One publication held until its text is durable. */
export interface QueuedParentAssistantText {
  input: ParentAssistantTextCheckpointInput;
  publish(): void;
  fail(reason: string): void;
}

/** Bounded queue metrics for performance verification. */
export interface ParentAssistantTextCheckpointQueueMetrics {
  committedChunks: number;
  publishedEvents: number;
  windowsMs: number[];
}

/** Coalesces assistant deltas and publishes them only after their chunk commits. */
export class ParentAssistantTextCheckpointQueue {
  private readonly pendingByExecution = new Map<string, {
    threadId: string;
    startedAt: number;
    bytes: number;
    entries: QueuedParentAssistantText[];
    timer: unknown;
  }>();
  private readonly metrics: ParentAssistantTextCheckpointQueueMetrics = {
    committedChunks: 0,
    publishedEvents: 0,
    windowsMs: [],
  };

  constructor(
    private readonly checkpoints: Pick<ParentAssistantTextCheckpointService, "appendChunk">,
    private readonly policy: ParentAssistantTextCheckpointQueuePolicy,
    private readonly scheduler: ParentAssistantTextCheckpointQueueScheduler = defaultQueueScheduler,
  ) {
    if (!Number.isSafeInteger(policy.maxChunkBytes) || policy.maxChunkBytes < 1
      || policy.maxChunkBytes > ACTIVE_TURN_WRITE_BATCH_LIMITS.maxBytes) {
      throw new Error("Assistant text checkpoint maxChunkBytes is outside the active-turn limit");
    }
    if (!Number.isSafeInteger(policy.maxQueuedEvents) || policy.maxQueuedEvents < 1
      || policy.maxQueuedEvents > ACTIVE_TURN_WRITE_BATCH_LIMITS.maxRows - 1) {
      throw new Error("Assistant text checkpoint maxQueuedEvents is outside the active-turn limit");
    }
    if (!Number.isFinite(policy.maxAgeMs) || policy.maxAgeMs <= 0) {
      throw new Error("Assistant text checkpoint maxAgeMs must be positive");
    }
  }

  /** Queue one delta and publish it only after a successful durable commit. */
  enqueue(entry: QueuedParentAssistantText): boolean {
    const bytes = Buffer.byteLength(entry.input.text, "utf8");
    if (bytes === 0 || bytes > ACTIVE_TURN_WRITE_BATCH_LIMITS.maxBytes) {
      entry.fail("Assistant text checkpoint delta exceeds the active-turn byte limit");
      return false;
    }
    let pending = this.pendingByExecution.get(entry.input.executionId);
    if (pending && (pending.entries.length >= this.policy.maxQueuedEvents
      || pending.bytes + bytes > this.policy.maxChunkBytes)) {
      if (!this.flush(entry.input.executionId)) return false;
      pending = undefined;
    }
    if (!pending) {
      const startedAt = this.scheduler.now();
      pending = {
        threadId: entry.input.threadId,
        startedAt,
        bytes: 0,
        entries: [],
        timer: this.scheduler.schedule(() => this.flush(entry.input.executionId), this.policy.maxAgeMs),
      };
      this.pendingByExecution.set(entry.input.executionId, pending);
    }
    pending.entries.push(entry);
    pending.bytes += bytes;
    if (pending.bytes >= this.policy.maxChunkBytes || pending.entries.length >= this.policy.maxQueuedEvents) {
      return this.flush(entry.input.executionId);
    }
    return true;
  }

  /** Flush every queued execution for a thread before a later semantic event. */
  flushThread(threadId: string): boolean {
    for (const [executionId, pending] of this.pendingByExecution) {
      if (pending.threadId === threadId && !this.flush(executionId)) return false;
    }
    return true;
  }

  /** Commit one execution's pending chunk and then publish its original events in order. */
  flush(executionId: string): boolean {
    const pending = this.pendingByExecution.get(executionId);
    if (!pending) return true;
    this.pendingByExecution.delete(executionId);
    this.scheduler.cancel(pending.timer);
    try {
      const result = this.checkpoints.appendChunk(pending.entries.map((entry) => entry.input));
      if (result.outcome === "overflow") {
        for (const entry of pending.entries) entry.fail("Parent assistant text recovery capacity reached");
        return false;
      }
      if (result.outcome === "committed") this.metrics.committedChunks += 1;
      this.recordWindow(this.scheduler.now() - pending.startedAt);
      for (const entry of pending.entries) {
        entry.publish();
        this.metrics.publishedEvents += 1;
      }
      return true;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      for (const entry of pending.entries) entry.fail(reason);
      return false;
    }
  }

  /** Discard an execution's uncommitted text without publication. */
  discard(executionId: string): void {
    const pending = this.pendingByExecution.get(executionId);
    if (!pending) return;
    this.pendingByExecution.delete(executionId);
    this.scheduler.cancel(pending.timer);
  }

  /** Return an immutable metrics snapshot for performance verification. */
  getMetrics(): ParentAssistantTextCheckpointQueueMetrics {
    return {
      committedChunks: this.metrics.committedChunks,
      publishedEvents: this.metrics.publishedEvents,
      windowsMs: [...this.metrics.windowsMs],
    };
  }

  private recordWindow(windowMs: number): void {
    if (this.metrics.windowsMs.length === 256) this.metrics.windowsMs.shift();
    this.metrics.windowsMs.push(windowMs);
  }
}

const defaultQueueScheduler: ParentAssistantTextCheckpointQueueScheduler = {
  now: () => Date.now(),
  schedule: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return timer;
  },
  cancel: (handle) => clearTimeout(handle as NodeJS.Timeout),
};
