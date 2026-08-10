import { performance } from "node:perf_hooks";
import type Database from "better-sqlite3";

/** Hard limits for one synchronous SQLite write transaction. */
export interface WriteBatchLimits {
  maxRows: number;
  maxBytes: number;
  maxElapsedMs: number;
}

/** Limits selected from the measured active-turn workload. */
export const ACTIVE_TURN_WRITE_BATCH_LIMITS: WriteBatchLimits = {
  maxRows: 64,
  maxBytes: 256 * 1024,
  maxElapsedMs: 4,
};

/** Aggregate work committed by a bounded write run. */
export interface WriteBatchResult {
  batches: number;
  rows: number;
  bytes: number;
}

/** Inputs and injectable timing seams for a bounded write run. */
export interface RunBoundedWriteBatchesInput<T> {
  db: Pick<Database.Database, "transaction">;
  items: readonly T[];
  limits: WriteBatchLimits;
  byteLength: (item: T) => number;
  rowCount?: (item: T) => number;
  batchOverheadRows?: number;
  batchOverheadBytes?: number;
  write: (item: T) => void;
  now?: () => number;
  yieldControl?: () => Promise<void>;
  onBatchStarted?: () => void;
  onBatchFinishing?: () => void;
  onBatchCommitted?: (result: WriteBatchResult) => void;
}

function assertPositiveLimit(value: number, name: keyof WriteBatchLimits): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
}

/** Commit ordered rows in bounded transactions and yield only after each commit. */
export async function runBoundedWriteBatches<T>(
  input: RunBoundedWriteBatchesInput<T>,
): Promise<WriteBatchResult> {
  assertPositiveLimit(input.limits.maxRows, "maxRows");
  assertPositiveLimit(input.limits.maxBytes, "maxBytes");
  assertPositiveLimit(input.limits.maxElapsedMs, "maxElapsedMs");
  if (!Number.isInteger(input.limits.maxRows)) {
    throw new Error("maxRows must be an integer");
  }

  const sizes = input.items.map((item, index) => {
    const bytes = input.byteLength(item);
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new Error(`Row ${index + 1} has an invalid byte size`);
    }
    if (bytes > input.limits.maxBytes) {
      throw new Error(
        `Row ${index + 1} is ${bytes} bytes and exceeds the ${input.limits.maxBytes}-byte batch limit`,
      );
    }
    return bytes;
  });
  const rowCounts = input.items.map((item, index) => {
    const rows = input.rowCount?.(item) ?? 1;
    if (!Number.isSafeInteger(rows) || rows <= 0) {
      throw new Error(`Item ${index + 1} has an invalid row count`);
    }
    return rows;
  });
  const batchOverheadRows = input.batchOverheadRows ?? 0;
  if (!Number.isSafeInteger(batchOverheadRows) || batchOverheadRows < 0) {
    throw new Error("batchOverheadRows must be a non-negative integer");
  }
  if (batchOverheadRows >= input.limits.maxRows) {
    throw new Error("batchOverheadRows must be lower than maxRows");
  }
  const batchOverheadBytes = input.batchOverheadBytes ?? 0;
  if (!Number.isSafeInteger(batchOverheadBytes) || batchOverheadBytes < 0) {
    throw new Error("batchOverheadBytes must be a non-negative integer");
  }
  if (batchOverheadBytes >= input.limits.maxBytes) {
    throw new Error("batchOverheadBytes must be lower than maxBytes");
  }
  if (input.items.length === 0) return { batches: 0, rows: 0, bytes: 0 };

  const now = input.now ?? performance.now.bind(performance);
  const yieldControl = input.yieldControl ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
  let cursor = 0;
  let batches = 0;
  let totalBytes = 0;
  let totalRows = 0;

  while (cursor < input.items.length) {
    const batchStart = cursor;
    let batchBytes = batchOverheadBytes;
    let batchRows = batchOverheadRows;
    const transaction = input.db.transaction(() => {
      const startedAt = now();
      input.onBatchStarted?.();
      while (cursor < input.items.length) {
        const rows = cursor - batchStart;
        const nextBytes = sizes[cursor]!;
        const nextRows = rowCounts[cursor]!;
        if (nextRows + batchOverheadRows > input.limits.maxRows) {
          throw new Error(
            `Item ${cursor + 1} needs ${nextRows + batchOverheadRows} rows and exceeds the ${input.limits.maxRows}-row batch limit`,
          );
        }
        if (nextBytes + batchOverheadBytes > input.limits.maxBytes) {
          throw new Error(
            `Item ${cursor + 1} needs ${nextBytes + batchOverheadBytes} bytes and exceeds the ${input.limits.maxBytes}-byte batch limit`,
          );
        }
        const elapsed = now() - startedAt;
        if (rows > 0 && (
          batchRows + nextRows > input.limits.maxRows
          || batchBytes + nextBytes > input.limits.maxBytes
          || elapsed >= input.limits.maxElapsedMs
        )) {
          break;
        }

        input.write(input.items[cursor]!);
        cursor += 1;
        batchBytes += nextBytes;
        batchRows += nextRows;
        if (now() - startedAt >= input.limits.maxElapsedMs) break;
      }
      input.onBatchFinishing?.();
    });
    transaction();
    batches += 1;
    totalBytes += batchBytes;
    totalRows += batchRows;
    input.onBatchCommitted?.({ batches: 1, rows: batchRows, bytes: batchBytes });

    if (cursor < input.items.length) await yieldControl();
  }

  return { batches, rows: totalRows, bytes: totalBytes };
}
