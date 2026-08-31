import * as NodePerfHooks from "node:perf_hooks";
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
  const prepared = prepareBoundedWriteInput(input);
  if (input.items.length === 0) return { batches: 0, rows: 0, bytes: 0 };

  const now = input.now ?? NodePerfHooks.performance.now.bind(NodePerfHooks.performance);
  const yieldControl = input.yieldControl ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
  let cursor = 0;
  let batches = 0;
  let totalBytes = 0;
  let totalRows = 0;

  while (cursor < input.items.length) {
    const batchStart = cursor;
    let batchBytes = prepared.batchOverheadBytes;
    let batchRows = prepared.batchOverheadRows;
    const transaction = input.db.transaction(() => {
      const startedAt = now();
      input.onBatchStarted?.();
      const result = writeBatchTransaction(input, prepared, cursor, batchStart, batchBytes, batchRows, startedAt, now);
      cursor = result.cursor;
      batchBytes = result.batchBytes;
      batchRows = result.batchRows;
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

/** Commit ordered rows in bounded synchronous transactions. */
export function runBoundedWriteBatchesSync<T>(
  input: RunBoundedWriteBatchesInput<T>,
): WriteBatchResult {
  const prepared = prepareBoundedWriteInput(input);
  if (input.items.length === 0) return { batches: 0, rows: 0, bytes: 0 };

  const now = input.now ?? NodePerfHooks.performance.now.bind(NodePerfHooks.performance);
  let cursor = 0;
  let batches = 0;
  let totalBytes = 0;
  let totalRows = 0;

  while (cursor < input.items.length) {
    const batchStart = cursor;
    let batchBytes = prepared.batchOverheadBytes;
    let batchRows = prepared.batchOverheadRows;
    const transaction = input.db.transaction(() => {
      const startedAt = now();
      input.onBatchStarted?.();
      const result = writeBatchTransaction(input, prepared, cursor, batchStart, batchBytes, batchRows, startedAt, now);
      cursor = result.cursor;
      batchBytes = result.batchBytes;
      batchRows = result.batchRows;
      input.onBatchFinishing?.();
    });
    transaction();
    batches += 1;
    totalBytes += batchBytes;
    totalRows += batchRows;
    input.onBatchCommitted?.({ batches: 1, rows: batchRows, bytes: batchBytes });
  }

  return { batches, rows: totalRows, bytes: totalBytes };
}

function prepareBoundedWriteInput<T>(input: RunBoundedWriteBatchesInput<T>): {
  readonly sizes: number[];
  readonly rowCounts: number[];
  readonly batchOverheadRows: number;
  readonly batchOverheadBytes: number;
} {
  assertBatchLimits(input.limits);
  const sizes = input.items.map((item, index) => validateItemBytes(input.byteLength(item), index, input.limits));
  const rowCounts = input.items.map((item, index) => validateItemRows(input.rowCount?.(item) ?? 1, index));
  const batchOverheadRows = validateBatchOverhead(input.batchOverheadRows ?? 0, input.limits.maxRows, "batchOverheadRows", "maxRows");
  const batchOverheadBytes = validateBatchOverhead(input.batchOverheadBytes ?? 0, input.limits.maxBytes, "batchOverheadBytes", "maxBytes");
  return { sizes, rowCounts, batchOverheadRows, batchOverheadBytes };
}

function assertBatchLimits(limits: WriteBatchLimits): void {
  assertPositiveLimit(limits.maxRows, "maxRows");
  assertPositiveLimit(limits.maxBytes, "maxBytes");
  assertPositiveLimit(limits.maxElapsedMs, "maxElapsedMs");
  if (!Number.isInteger(limits.maxRows)) throw new Error("maxRows must be an integer");
}

function validateItemBytes(bytes: number, index: number, limits: WriteBatchLimits): number {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error(`Row ${index + 1} has an invalid byte size`);
  if (bytes > limits.maxBytes) {
    throw new Error(`Row ${index + 1} is ${bytes} bytes and exceeds the ${limits.maxBytes}-byte batch limit`);
  }
  return bytes;
}

function validateItemRows(rows: number, index: number): number {
  if (!Number.isSafeInteger(rows) || rows <= 0) throw new Error(`Item ${index + 1} has an invalid row count`);
  return rows;
}

function validateBatchOverhead(
  value: number,
  limit: number,
  name: "batchOverheadRows" | "batchOverheadBytes",
  limitName: "maxRows" | "maxBytes",
): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  if (value >= limit) throw new Error(`${name} must be lower than ${limitName}`);
  return value;
}

function writeBatchTransaction<T>(
  input: RunBoundedWriteBatchesInput<T>,
  prepared: ReturnType<typeof prepareBoundedWriteInput<T>>,
  cursor: number,
  batchStart: number,
  batchBytes: number,
  batchRows: number,
  startedAt: number,
  now: () => number,
): { readonly cursor: number; readonly batchBytes: number; readonly batchRows: number } {
  while (cursor < input.items.length) {
    const next = batchItem(prepared, cursor, input.limits);
    if (mustEndBatch(cursor, batchStart, batchRows, batchBytes, next, startedAt, input.limits, now)) break;
    input.write(input.items[cursor]!);
    cursor += 1;
    batchBytes += next.bytes;
    batchRows += next.rows;
    if (now() - startedAt >= input.limits.maxElapsedMs) break;
  }
  return { cursor, batchBytes, batchRows };
}

function batchItem(
  prepared: { readonly sizes: number[]; readonly rowCounts: number[]; readonly batchOverheadRows: number; readonly batchOverheadBytes: number },
  cursor: number,
  limits: WriteBatchLimits,
): { readonly rows: number; readonly bytes: number } {
  const rows = prepared.rowCounts[cursor]!;
  const bytes = prepared.sizes[cursor]!;
  if (rows + prepared.batchOverheadRows > limits.maxRows) {
    throw new Error(`Item ${cursor + 1} needs ${rows + prepared.batchOverheadRows} rows and exceeds the ${limits.maxRows}-row batch limit`);
  }
  if (bytes + prepared.batchOverheadBytes > limits.maxBytes) {
    throw new Error(`Item ${cursor + 1} needs ${bytes + prepared.batchOverheadBytes} bytes and exceeds the ${limits.maxBytes}-byte batch limit`);
  }
  return { rows, bytes };
}

function mustEndBatch(
  cursor: number,
  batchStart: number,
  batchRows: number,
  batchBytes: number,
  next: { readonly rows: number; readonly bytes: number },
  startedAt: number,
  limits: WriteBatchLimits,
  now: () => number,
): boolean {
  if (cursor === batchStart) return false;
  return batchRows + next.rows > limits.maxRows ||
    batchBytes + next.bytes > limits.maxBytes ||
    now() - startedAt >= limits.maxElapsedMs;
}
