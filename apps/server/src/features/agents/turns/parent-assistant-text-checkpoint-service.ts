import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { Database } from "bun:sqlite";
import { inject, injectable } from "tsyringe";
import { ACTIVE_TURN_WRITE_BATCH_LIMITS } from "../../../runtime/persistence/sqlite/bounded-write-batches.js";
import { PARENT_ASSISTANT_TEXT_RETAINED_LIMITS } from "./active-turn-recovery-retention-policy.js";

export { PARENT_ASSISTANT_TEXT_RETAINED_LIMITS } from "./active-turn-recovery-retention-policy.js";

/** Measured production policy for durable assistant-text publication. */
export const PARENT_ASSISTANT_TEXT_QUEUE_POLICY = {
  maxChunkBytes: 16 * 1024,
  maxQueuedEvents: ACTIVE_TURN_WRITE_BATCH_LIMITS.maxRows - 1,
  maxAgeMs: 250,
} as const;

const PARENT_ASSISTANT_TEXT_RECOVERY_JOURNAL_RECORD_OVERHEAD_BYTES = 512;
const PARENT_ASSISTANT_TEXT_RECOVERY_JOURNAL_MAX_BYTES =
  Math.ceil(PARENT_ASSISTANT_TEXT_RETAINED_LIMITS.maxBytes / 3) * 4
  + PARENT_ASSISTANT_TEXT_RETAINED_LIMITS.maxChunks
    * PARENT_ASSISTANT_TEXT_RECOVERY_JOURNAL_RECORD_OVERHEAD_BYTES;

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

/** Filesystem location for the per-database assistant-text recovery journal. */
export interface ParentAssistantTextRecoveryJournalOptions {
  directory?: string;
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

interface PreparedParentAssistantTextCheckpointChunk {
  executionId: string;
  threadId: string;
  turnId: string;
  firstSequence: number;
  lastSequence: number;
  text: string;
  byteLength: number;
  itemCount: number;
}

interface DurableParentAssistantTextCheckpoint {
  thread_id: string;
  turn_id: string;
  last_sequence: number;
  retained_bytes: number;
  retained_chunks: number;
}

/** Persists bounded chunks for unfinished ordinary parent assistant responses. */
@injectable()
export class ParentAssistantTextCheckpointService {
  constructor(
    @inject("Database") private readonly db: Database,
    @inject("ParentAssistantTextCheckpointLimits", { isOptional: true })
    private readonly limits: ParentAssistantTextCheckpointLimits = PARENT_ASSISTANT_TEXT_RETAINED_LIMITS,
    @inject("ParentAssistantTextRecoveryJournalOptions", { isOptional: true })
    journalOptions: ParentAssistantTextRecoveryJournalOptions = {},
  ) {
    this.recoveryJournal = new ParentAssistantTextRecoveryJournal(
      journalOptions.directory ?? resolveDefaultRecoveryJournalDirectory(this.db),
    );
  }

  /** Durable fallback journal scoped to this SQLite database. */
  readonly recoveryJournal: ParentAssistantTextRecoveryJournal;

  /** Commit consecutive deltas as one durable chunk and advance its cursor atomically. */
  appendChunk(inputs: readonly ParentAssistantTextCheckpointInput[]): ParentAssistantTextCheckpointResult {
    return this.appendPreparedChunk(this.prepareChunk(inputs));
  }

  /** Import one complete recovery-journal record into SQLite. */
  appendRecoveredChunk(
    input: ParentAssistantTextRecoveryJournalChunk,
  ): ParentAssistantTextCheckpointResult {
    return this.appendPreparedChunk({
      executionId: input.executionId,
      threadId: input.threadId,
      turnId: input.turnId,
      firstSequence: input.firstSequence,
      lastSequence: input.lastSequence,
      text: input.text,
      byteLength: input.byteLength,
      itemCount: input.lastSequence - input.firstSequence + 1,
    });
  }

  /** Import every fsynced journal before startup recovery reads provisional text. */
  importRecoveryJournals(): string[] {
    return this.recoveryJournal.drainAll((input) => {
      const result = this.appendRecoveredChunk(input);
      if (result.outcome === "overflow") {
        throw new Error("Assistant text recovery journal exceeds the retained checkpoint capacity");
      }
    });
  }

  private appendPreparedChunk(
    prepared: PreparedParentAssistantTextCheckpointChunk,
  ): ParentAssistantTextCheckpointResult {
    return this.db.transaction(() => this.appendPreparedChunkInTransaction(prepared))();
  }

  private appendPreparedChunkInTransaction(
    prepared: PreparedParentAssistantTextCheckpointChunk,
  ): ParentAssistantTextCheckpointResult {
    const checkpoint = this.loadCheckpoint(prepared.executionId);
    this.verifyCheckpointRouting(checkpoint, prepared);
    const durableThrough = checkpoint?.last_sequence ?? 0;
    const duplicate = this.duplicateCheckpointResult(prepared, durableThrough);
    if (duplicate) return duplicate;
    this.verifyNextSequence(prepared, durableThrough);
    const overflow = this.overflowCheckpointResult(prepared, checkpoint, durableThrough);
    if (overflow) return overflow;
    return this.insertPreparedChunk(prepared, checkpoint);
  }

  private loadCheckpoint(executionId: string): DurableParentAssistantTextCheckpoint | undefined {
    return this.db.prepare(`
      SELECT thread_id, turn_id, last_sequence, retained_bytes, retained_chunks
      FROM parent_assistant_text_checkpoints
      WHERE execution_id = ?
    `).get(executionId) as DurableParentAssistantTextCheckpoint | undefined;
  }

  private verifyCheckpointRouting(
    checkpoint: DurableParentAssistantTextCheckpoint | undefined,
    prepared: PreparedParentAssistantTextCheckpointChunk,
  ): void {
    if (checkpoint && (checkpoint.thread_id !== prepared.threadId || checkpoint.turn_id !== prepared.turnId)) {
      throw new Error("Assistant text checkpoint routing conflicts with its execution");
    }
  }

  private duplicateCheckpointResult(
    prepared: PreparedParentAssistantTextCheckpointChunk,
    durableThrough: number,
  ): ParentAssistantTextCheckpointResult | undefined {
    if (prepared.firstSequence > durableThrough) return undefined;
    if (prepared.lastSequence > durableThrough) {
      throw new Error("Assistant text checkpoint retry overlaps durable and new text");
    }
    const duplicate = this.db.prepare(`
      SELECT text, byte_length
      FROM parent_assistant_text_checkpoint_chunks
      WHERE execution_id = ? AND first_sequence = ? AND last_sequence = ?
    `).get(prepared.executionId, prepared.firstSequence, prepared.lastSequence) as {
      text: string;
      byte_length: number;
    } | undefined;
    if (!duplicate || duplicate.text !== prepared.text || duplicate.byte_length !== prepared.byteLength) {
      throw new Error("Assistant text checkpoint duplicate conflicts with durable text");
    }
    return { outcome: "duplicate", durableThrough, committedItems: 0, committedBytes: 0 };
  }

  private verifyNextSequence(prepared: PreparedParentAssistantTextCheckpointChunk, durableThrough: number): void {
    if (prepared.firstSequence !== durableThrough + 1) {
      throw new Error(`Assistant text checkpoint sequence gap: expected ${durableThrough + 1}, received ${prepared.firstSequence}`);
    }
  }

  private overflowCheckpointResult(
    prepared: PreparedParentAssistantTextCheckpointChunk,
    checkpoint: DurableParentAssistantTextCheckpoint | undefined,
    durableThrough: number,
  ): ParentAssistantTextCheckpointResult | undefined {
    const retainedBytes = (checkpoint?.retained_bytes ?? 0) + prepared.byteLength;
    const retainedChunks = (checkpoint?.retained_chunks ?? 0) + 1;
    if (retainedBytes <= this.limits.maxBytes && retainedChunks <= this.limits.maxChunks) return undefined;
    return { outcome: "overflow", durableThrough, committedItems: 0, committedBytes: 0 };
  }

  private insertPreparedChunk(
    prepared: PreparedParentAssistantTextCheckpointChunk,
    checkpoint: DurableParentAssistantTextCheckpoint | undefined,
  ): ParentAssistantTextCheckpointResult {
    const retainedBytes = (checkpoint?.retained_bytes ?? 0) + prepared.byteLength;
    const retainedChunks = (checkpoint?.retained_chunks ?? 0) + 1;
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
      prepared.executionId, prepared.threadId, prepared.turnId, prepared.lastSequence,
      retainedBytes, retainedChunks, new Date().toISOString(),
    );
    this.db.prepare(`
      INSERT INTO parent_assistant_text_checkpoint_chunks (
        execution_id, first_sequence, last_sequence, text, byte_length
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      prepared.executionId, prepared.firstSequence, prepared.lastSequence, prepared.text, prepared.byteLength,
    );
    return {
      outcome: "committed",
      durableThrough: prepared.lastSequence,
      committedItems: prepared.itemCount,
      committedBytes: prepared.byteLength,
    };
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
    const reset = this.db.transaction(() => this.resetInTransaction(executionId))();
    if (reset) this.recoveryJournal.discard(executionId);
    return reset;
  }

  /** Discard every unfinished storage tier before a provider retry starts a fresh response. */
  resetForRetry(executionId: string): boolean {
    const reset = this.db.transaction(() => {
      const unfinished = this.db.prepare(`
        SELECT 1 FROM canonical_agent_ingest_checkpoints
        WHERE execution_id = ? AND terminal_outcome IS NULL
      `).get(executionId);
      if (!unfinished) return false;
      this.db.prepare(
        "DELETE FROM parent_assistant_text_checkpoints WHERE execution_id = ?",
      ).run(executionId);
      return true;
    })();
    if (reset) this.recoveryJournal.discard(executionId);
    return reset;
  }

  /** Discard provisional text while the caller owns the surrounding SQLite transaction. */
  resetInTransaction(executionId: string): boolean {
    return this.db.prepare(`
      DELETE FROM parent_assistant_text_checkpoints
      WHERE execution_id = ?
        AND EXISTS (
          SELECT 1 FROM canonical_agent_ingest_checkpoints
          WHERE execution_id = parent_assistant_text_checkpoints.execution_id
            AND terminal_outcome IS NULL
        )
    `).run(executionId).changes > 0;
  }

  /** Remove the journal after its equivalent canonical projection commits. */
  discardRecoveryJournal(executionId: string): void {
    this.recoveryJournal.discard(executionId);
  }

  /** Retire provisional text only after the canonical execution is terminal. */
  retire(executionId: string): boolean {
    const terminal = this.db.transaction(() => {
      const terminal = this.db.prepare(`
        SELECT 1 FROM canonical_agent_ingest_checkpoints
        WHERE execution_id = ? AND terminal_outcome IS NOT NULL
      `).get(executionId);
      if (!terminal) return false;
      this.db.prepare(
        "DELETE FROM parent_assistant_text_checkpoints WHERE execution_id = ?",
      ).run(executionId);
      return true;
    })();
    if (terminal) this.recoveryJournal.discard(executionId);
    return terminal;
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

  private prepareChunk(
    inputs: readonly ParentAssistantTextCheckpointInput[],
  ): PreparedParentAssistantTextCheckpointChunk {
    if (inputs.length === 0) throw new Error("Assistant text checkpoint chunk must not be empty");
    if (inputs.length > ACTIVE_TURN_WRITE_BATCH_LIMITS.maxRows - 1) {
      throw new Error("Assistant text checkpoint chunk exceeds the active-turn row limit");
    }
    const first = inputs[0]!;
    this.verifyCheckpointChunkInputs(inputs, first);
    return this.preparedCheckpointChunk(inputs, first);
  }

  private verifyCheckpointChunkInputs(
    inputs: readonly ParentAssistantTextCheckpointInput[],
    first: ParentAssistantTextCheckpointInput,
  ): void {
    for (const [index, input] of inputs.entries()) {
      this.verifyCheckpointChunkInput(input, first, index);
    }
  }

  private verifyCheckpointChunkInput(
    input: ParentAssistantTextCheckpointInput,
    first: ParentAssistantTextCheckpointInput,
    index: number,
  ): void {
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

  private preparedCheckpointChunk(
    inputs: readonly ParentAssistantTextCheckpointInput[],
    first: ParentAssistantTextCheckpointInput,
  ): PreparedParentAssistantTextCheckpointChunk {
    const text = inputs.map((input) => input.text).join("");
    const byteLength = Buffer.byteLength(text, "utf8");
    if (byteLength > ACTIVE_TURN_WRITE_BATCH_LIMITS.maxBytes) {
      throw new Error("Assistant text checkpoint chunk exceeds the active-turn byte limit");
    }
    return {
      executionId: first.executionId,
      threadId: first.threadId,
      turnId: first.turnId,
      firstSequence: first.sequence,
      lastSequence: inputs.at(-1)!.sequence,
      text,
      byteLength,
      itemCount: inputs.length,
    };
  }
}

/** One fsynced assistant-text chunk that can be imported into SQLite after recovery. */
export interface ParentAssistantTextRecoveryJournalChunk {
  executionId: string;
  threadId: string;
  turnId: string;
  firstSequence: number;
  lastSequence: number;
  text: string;
  byteLength: number;
}

interface ParentAssistantTextRecoveryJournalRecord {
  version: 1;
  executionId: string;
  threadId: string;
  turnId: string;
  firstSequence: number;
  lastSequence: number;
  byteLength: number;
  textBase64: string;
  checksum: string;
}

/** Appends fsynced per-execution records outside SQLite's failure domain. */
export class ParentAssistantTextRecoveryJournal {
  constructor(private readonly directory?: string) {}

  /** Return whether this process can use a file-backed journal. */
  isAvailable(): boolean {
    return this.directory !== undefined;
  }

  /** Append a complete chunk and fsync it before the caller publishes the source text. */
  append(inputs: readonly ParentAssistantTextCheckpointInput[]): void {
    if (!this.directory) throw new Error("Assistant text recovery journal is unavailable");
    const record = createRecoveryJournalRecord(inputs);
    const path = this.pathFor(record.executionId);
    NodeFS.mkdirSync(this.directory, { recursive: true });
    const descriptor = NodeFS.openSync(path, "a", 0o600);
    try {
      const encoded = Buffer.from(JSON.stringify(record) + "\n", "utf8");
      let offset = 0;
      while (offset < encoded.length) {
        const written = NodeFS.writeSync(descriptor, encoded, offset, encoded.length - offset);
        if (written <= 0) throw new Error("Assistant text recovery journal write did not complete");
        offset += written;
      }
      NodeFS.fsyncSync(descriptor);
    } finally {
      NodeFS.closeSync(descriptor);
    }
  }

  /** Import one execution's complete records and remove the journal only after all imports commit. */
  drain(
    executionId: string,
    append: (input: ParentAssistantTextRecoveryJournalChunk) => unknown,
  ): boolean {
    if (!this.directory) return true;
    const path = this.pathFor(executionId);
    if (!NodeFS.existsSync(path)) return true;
    for (const record of this.readRecords(path, executionId)) {
      append(recoveryJournalChunk(record));
    }
    NodeFS.unlinkSync(path);
    return true;
  }

  /** Import every journal whose filename has a safe execution identity. */
  drainAll(append: (input: ParentAssistantTextRecoveryJournalChunk) => unknown): string[] {
    if (!this.directory || !NodeFS.existsSync(this.directory)) return [];
    const drained: string[] = [];
    for (const name of NodeFS.readdirSync(this.directory)) {
      if (!name.endsWith(".journal")) continue;
      const executionId = name.slice(0, -".journal".length);
      if (!isSafeExecutionId(executionId)) continue;
      this.drain(executionId, append);
      drained.push(executionId);
    }
    return drained;
  }

  /** Remove one journal after the canonical terminal projection is verified. */
  discard(executionId: string): void {
    if (!this.directory || !isSafeExecutionId(executionId)) return;
    const path = this.pathFor(executionId);
    if (NodeFS.existsSync(path)) NodeFS.unlinkSync(path);
  }

  private pathFor(executionId: string): string {
    if (!this.directory || !isSafeExecutionId(executionId)) {
      throw new Error("Assistant text recovery journal execution identity is invalid");
    }
    return NodePath.join(this.directory, executionId + ".journal");
  }

  private readRecords(
    path: string,
    executionId: string,
  ): ParentAssistantTextRecoveryJournalRecord[] {
    if (NodeFS.statSync(path).size > PARENT_ASSISTANT_TEXT_RECOVERY_JOURNAL_MAX_BYTES) {
      throw new Error("Assistant text recovery journal exceeds its bounded retention");
    }
    const contents = NodeFS.readFileSync(path, "utf8");
    if (contents.length > 0 && !contents.endsWith("\n")) {
      throw new Error("Assistant text recovery journal has an incomplete final record");
    }
    const lines = contents.split("\n");
    const records: ParentAssistantTextRecoveryJournalRecord[] = [];
    let retainedBytes = 0;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (line.length === 0 && index === lines.length - 1) continue;
      const parsed = JSON.parse(line) as unknown;
      const record = validateRecoveryJournalRecord(parsed, executionId);
      if (records.length === PARENT_ASSISTANT_TEXT_RETAINED_LIMITS.maxChunks
        || retainedBytes + record.byteLength > PARENT_ASSISTANT_TEXT_RETAINED_LIMITS.maxBytes) {
        throw new Error("Assistant text recovery journal exceeds its bounded retention");
      }
      retainedBytes += record.byteLength;
      records.push(record);
    }
    return records;
  }
}

function resolveDefaultRecoveryJournalDirectory(db: Database): string | undefined {
  if (db.filename === ":memory:") return undefined;
  if (!db.filename) throw new Error("Assistant text recovery journal database path is unavailable");
  return NodePath.join(NodePath.dirname(db.filename), NodePath.basename(db.filename) + ".recovery", "parent-assistant-text");
}

function createRecoveryJournalRecord(
  inputs: readonly ParentAssistantTextCheckpointInput[],
): ParentAssistantTextRecoveryJournalRecord {
  if (inputs.length === 0) throw new Error("Assistant text recovery journal chunk must not be empty");
  const first = inputs[0]!;
  verifyJournalExecutionId(first.executionId);
  verifyRecoveryJournalInputs(inputs, first);
  return journalRecordFromInputs(inputs, first);
}

function verifyJournalExecutionId(executionId: string): void {
  if (!isSafeExecutionId(executionId)) {
    throw new Error("Assistant text recovery journal execution identity is invalid");
  }
}

function verifyRecoveryJournalInputs(
  inputs: readonly ParentAssistantTextCheckpointInput[],
  first: ParentAssistantTextCheckpointInput,
): void {
  for (const [index, input] of inputs.entries()) {
    verifyRecoveryJournalInput(input, first, index);
  }
}

function verifyRecoveryJournalInput(
  input: ParentAssistantTextCheckpointInput,
  first: ParentAssistantTextCheckpointInput,
  index: number,
): void {
  if (input.executionId !== first.executionId || input.threadId !== first.threadId || input.turnId !== first.turnId) {
    throw new Error("Assistant text recovery journal chunk mixes execution routing");
  }
  if (!Number.isSafeInteger(input.sequence) || input.sequence !== first.sequence + index) {
    throw new Error("Assistant text recovery journal chunk sequences must be consecutive");
  }
  if (Buffer.byteLength(input.text, "utf8") === 0) {
    throw new Error("Assistant text recovery journal delta must contain text");
  }
}

function journalRecordFromInputs(
  inputs: readonly ParentAssistantTextCheckpointInput[],
  first: ParentAssistantTextCheckpointInput,
): ParentAssistantTextRecoveryJournalRecord {
  const text = inputs.map((input) => input.text).join("");
  const byteLength = Buffer.byteLength(text, "utf8");
  if (byteLength > ACTIVE_TURN_WRITE_BATCH_LIMITS.maxBytes) {
    throw new Error("Assistant text recovery journal chunk exceeds the active-turn byte limit");
  }
  const textBase64 = Buffer.from(text, "utf8").toString("base64");
  const record: Omit<ParentAssistantTextRecoveryJournalRecord, "checksum"> = {
    version: 1,
    executionId: first.executionId,
    threadId: first.threadId,
    turnId: first.turnId,
    firstSequence: first.sequence,
    lastSequence: inputs.at(-1)!.sequence,
    byteLength,
    textBase64,
  };
  return {
    ...record,
    checksum: recoveryJournalChecksum(record),
  };
}

function validateRecoveryJournalRecord(
  value: unknown,
  executionId: string,
): ParentAssistantTextRecoveryJournalRecord {
  const record = recoveryJournalRecordValue(value);
  if (!isValidRecoveryJournalRecord(record, executionId)) {
    throw new Error("Assistant text recovery journal record is invalid");
  }
  const verified: Omit<ParentAssistantTextRecoveryJournalRecord, "checksum"> = {
    version: 1,
    executionId: record.executionId,
    threadId: record.threadId,
    turnId: record.turnId,
    firstSequence: record.firstSequence!,
    lastSequence: record.lastSequence!,
    byteLength: record.byteLength!,
    textBase64: record.textBase64,
  };
  if (recoveryJournalChecksum(verified) !== record.checksum) {
    throw new Error("Assistant text recovery journal checksum conflicts");
  }
  const text = Buffer.from(record.textBase64, "base64").toString("utf8");
  if (Buffer.byteLength(text, "utf8") !== record.byteLength) {
    throw new Error("Assistant text recovery journal byte length conflicts");
  }
  return { ...verified, checksum: record.checksum };
}

function recoveryJournalRecordValue(value: unknown): Partial<ParentAssistantTextRecoveryJournalRecord> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Partial<ParentAssistantTextRecoveryJournalRecord>;
}

function isValidRecoveryJournalRecord(
  record: Partial<ParentAssistantTextRecoveryJournalRecord> | null,
  executionId: string,
): record is ParentAssistantTextRecoveryJournalRecord {
  return record !== null
    && hasValidRecordIdentity(record, executionId)
    && hasValidRecordBounds(record)
    && hasValidRecordPayload(record);
}

function hasValidRecordIdentity(
  record: Partial<ParentAssistantTextRecoveryJournalRecord>,
  executionId: string,
): boolean {
  return record.version === 1
    && record.executionId === executionId
    && typeof record.threadId === "string"
    && typeof record.turnId === "string";
}

function hasValidRecordBounds(record: Partial<ParentAssistantTextRecoveryJournalRecord>): boolean {
  const firstSequence = positiveSafeInteger(record.firstSequence);
  const lastSequence = positiveSafeInteger(record.lastSequence);
  const byteLength = positiveSafeInteger(record.byteLength);
  if (firstSequence === null || lastSequence === null || byteLength === null) return false;
  if (lastSequence < firstSequence || byteLength > ACTIVE_TURN_WRITE_BATCH_LIMITS.maxBytes) return false;
  return lastSequence - firstSequence + 1 <= ACTIVE_TURN_WRITE_BATCH_LIMITS.maxRows - 1;
}

function positiveSafeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : null;
}

function hasValidRecordPayload(record: Partial<ParentAssistantTextRecoveryJournalRecord>): boolean {
  return typeof record.textBase64 === "string" && typeof record.checksum === "string";
}

function recoveryJournalChunk(
  record: ParentAssistantTextRecoveryJournalRecord,
): ParentAssistantTextRecoveryJournalChunk {
  return {
    executionId: record.executionId,
    threadId: record.threadId,
    turnId: record.turnId,
    firstSequence: record.firstSequence,
    lastSequence: record.lastSequence,
    text: Buffer.from(record.textBase64, "base64").toString("utf8"),
    byteLength: record.byteLength,
  };
}

function recoveryJournalChecksum(
  record: Omit<ParentAssistantTextRecoveryJournalRecord, "checksum">,
): string {
  return NodeCrypto.createHash("sha256").update([
    record.version,
    record.executionId,
    record.threadId,
    record.turnId,
    record.firstSequence,
    record.lastSequence,
    record.byteLength,
    record.textBase64,
  ].join("\n")).digest("hex");
}

function isSafeExecutionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validateQueuePolicy(policy: ParentAssistantTextCheckpointQueuePolicy): void {
  validateChunkByteLimit(policy.maxChunkBytes);
  validateQueuedEventLimit(policy.maxQueuedEvents);
  validateQueueAge(policy.maxAgeMs);
}

function validateChunkByteLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > ACTIVE_TURN_WRITE_BATCH_LIMITS.maxBytes) {
    throw new Error("Assistant text checkpoint maxChunkBytes is outside the active-turn limit");
  }
}

function validateQueuedEventLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > ACTIVE_TURN_WRITE_BATCH_LIMITS.maxRows - 1) {
    throw new Error("Assistant text checkpoint maxQueuedEvents is outside the active-turn limit");
  }
}

function validateQueueAge(value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Assistant text checkpoint maxAgeMs must be positive");
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

/** The current safety level of an active assistant-text stream. */
export type ParentAssistantTextDurabilityMode = "durable" | "saving-delayed" | "unsaved" | "stopping";

/** Server-authoritative storage status shown while an active turn cannot save normally. */
export interface ParentAssistantTextDurabilityUpdate {
  threadId: string;
  executionId: string;
  mode: ParentAssistantTextDurabilityMode;
}

/** Optional queue callbacks owned by the agent orchestration boundary. */
export interface ParentAssistantTextCheckpointQueueOptions {
  limits?: ParentAssistantTextCheckpointLimits;
  onDurabilityChange?(update: ParentAssistantTextDurabilityUpdate): void;
}

type ParentAssistantTextCheckpointStorage = Pick<ParentAssistantTextCheckpointService, "appendChunk">
  & Partial<Pick<ParentAssistantTextCheckpointService,
    "appendRecoveredChunk" | "recoveryJournal" | "restoreChunks">>;

interface QueuedParentAssistantTextChunk {
  entries: QueuedParentAssistantText[];
  byteLength: number;
}

interface PendingParentAssistantTextChunk extends QueuedParentAssistantTextChunk {
  threadId: string;
  startedAt: number;
  timer: unknown;
}

interface ParentAssistantTextDurabilityState {
  threadId: string;
  baselineReady: boolean;
  lastSequence: number;
  retainedBytes: number;
  retainedChunks: number;
  journalActive: boolean;
  memory: QueuedParentAssistantTextChunk[];
  mode: ParentAssistantTextDurabilityMode;
  fail?(reason: string): void;
  retryTimer?: unknown;
}

/** Coalesces assistant deltas and publishes them only after their chunk commits. */
export class ParentAssistantTextCheckpointQueue {
  private readonly pendingByExecution = new Map<string, PendingParentAssistantTextChunk>();
  private readonly durabilityByExecution = new Map<string, ParentAssistantTextDurabilityState>();
  private readonly metrics: ParentAssistantTextCheckpointQueueMetrics = {
    committedChunks: 0,
    publishedEvents: 0,
    windowsMs: [],
  };

  constructor(
    private readonly checkpoints: ParentAssistantTextCheckpointStorage,
    private readonly policy: ParentAssistantTextCheckpointQueuePolicy,
    private readonly scheduler: ParentAssistantTextCheckpointQueueScheduler = defaultQueueScheduler,
    private readonly options: ParentAssistantTextCheckpointQueueOptions = {},
  ) {
    validateQueuePolicy(policy);
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
      || pending.byteLength + bytes > this.policy.maxChunkBytes)) {
      if (!this.flush(entry.input.executionId)) return false;
      pending = undefined;
    }
    if (!pending) {
      const startedAt = this.scheduler.now();
      pending = {
        threadId: entry.input.threadId,
        startedAt,
        byteLength: 0,
        entries: [],
        timer: this.scheduler.schedule(() => this.flush(entry.input.executionId), this.policy.maxAgeMs),
      };
      this.pendingByExecution.set(entry.input.executionId, pending);
    }
    pending.entries.push(entry);
    pending.byteLength += bytes;
    if (pending.byteLength >= this.policy.maxChunkBytes || pending.entries.length >= this.policy.maxQueuedEvents) {
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

  /** Make every earlier parent-assistant chunk SQLite-readable before the next semantic event runs. */
  prepareSemanticBoundary(threadId: string): boolean {
    if (!this.flushThread(threadId)) return false;
    for (const [executionId, state] of this.durabilityByExecution) {
      if (state.threadId !== threadId) continue;
      if (state.mode === "stopping") return false;
      if (state.mode === "unsaved") continue;
      if (state.mode === "saving-delayed" && !this.recoverMemory(executionId, state)) return false;
      if (state.journalActive && !this.drainJournal(executionId, state)) return false;
    }
    return true;
  }

  /** Commit one execution's pending chunk and then publish its original events in order. */
  flush(executionId: string): boolean {
    const pending = this.pendingByExecution.get(executionId);
    if (!pending) return true;
    this.pendingByExecution.delete(executionId);
    this.scheduler.cancel(pending.timer);
    const chunk: QueuedParentAssistantTextChunk = {
      entries: pending.entries,
      byteLength: pending.byteLength,
    };
    return this.persistChunk(executionId, pending.threadId, chunk, pending.startedAt);
  }

  /** Give finalization one last synchronous recovery attempt before it projects the terminal message. */
  finish(executionId: string): boolean {
    if (!this.flush(executionId)) return false;
    const state = this.durabilityByExecution.get(executionId);
    if (!state) return true;
    if (state.mode === "stopping") return false;
    if (state.mode === "unsaved") return true;
    if (state.mode === "saving-delayed" && !this.recoverMemory(executionId, state)) {
      this.rejectMemory(executionId, state, "Assistant text recovery remained unavailable at turn finalization");
      return false;
    }
    if (state.journalActive && !this.drainJournal(executionId, state)) {
      this.rejectMemory(executionId, state, "Assistant text recovery remained unavailable at turn finalization");
      return false;
    }
    return true;
  }

  /** Publish held text only after the user explicitly accepts an unsaved continuation. */
  continueWithoutSaving(executionId: string): boolean {
    const state = this.durabilityByExecution.get(executionId);
    if (!state || state.mode !== "saving-delayed") return false;
    this.cancelRetry(state);
    state.mode = "unsaved";
    for (const chunk of state.memory) this.publishChunk(chunk);
    state.memory = [];
    this.emitDurabilityChange(executionId, state);
    return true;
  }

  /** Return whether this execution currently waits for the user's unsaved-continuation decision. */
  requiresDecision(executionId: string): boolean {
    return this.durabilityByExecution.get(executionId)?.mode === "saving-delayed";
  }

  /** Return whether this execution has already reported a terminal storage failure. */
  hasStoppedForStorageFailure(executionId: string): boolean {
    return this.durabilityByExecution.get(executionId)?.mode === "stopping";
  }

  /** Return whether any active assistant-text stream for the thread has stopped for storage safety. */
  hasThreadStoppedForStorageFailure(threadId: string): boolean {
    return [...this.durabilityByExecution.values()].some((state) =>
      state.threadId === threadId && state.mode === "stopping");
  }

  /** Return the current saving state for reconnect hydration. */
  durabilityMode(executionId: string): ParentAssistantTextDurabilityMode | null {
    return this.durabilityByExecution.get(executionId)?.mode ?? null;
  }

  /** Load the exact durable prefix before the execution assigns its next source sequence. */
  initializeExecution(
    executionId: string,
    threadId: string,
    fail: (reason: string) => void,
  ): number | null {
    const existing = this.durabilityByExecution.get(executionId);
    if (existing) {
      existing.fail ??= fail;
      return existing.baselineReady ? existing.lastSequence : null;
    }
    try {
      const restored = this.checkpoints.restoreChunks?.(executionId) ?? [];
      const state = this.stateFromRestored(threadId, restored);
      this.durabilityByExecution.set(executionId, state);
      return state.lastSequence;
    } catch (error) {
      if (!isRecoverableSqliteFailure(error)) throw error;
      const state: ParentAssistantTextDurabilityState = {
        threadId,
        baselineReady: false,
        lastSequence: 0,
        retainedBytes: 0,
        retainedChunks: 0,
        journalActive: false,
        memory: [],
        mode: "saving-delayed",
        fail,
      };
      this.durabilityByExecution.set(executionId, state);
      this.emitDurabilityChange(executionId, state);
      this.scheduleRetry(executionId, state);
      return null;
    }
  }

  private persistChunk(
    executionId: string,
    threadId: string,
    chunk: QueuedParentAssistantTextChunk,
    startedAt: number,
  ): boolean {
    const state = this.stateFor(executionId, threadId);
    if (state.mode === "stopping") return false;
    state.fail = chunk.entries[0]?.fail;
    return this.persistChunkForMode(executionId, threadId, chunk, startedAt, state);
  }

  private persistChunkForMode(
    executionId: string,
    threadId: string,
    chunk: QueuedParentAssistantTextChunk,
    startedAt: number,
    state: ParentAssistantTextDurabilityState,
  ): boolean {
    if (state.mode === "unsaved") {
      this.publishChunk(chunk);
      return true;
    }
    if (state.mode === "saving-delayed") {
      return this.persistAfterMemoryRecovery(executionId, threadId, chunk, startedAt, state);
    }
    if (state.journalActive && !this.drainJournal(executionId, state)) {
      return this.retainAfterJournalDrainFailure(executionId, state, chunk);
    }
    return this.persistDurableChunk(executionId, state, chunk, startedAt);
  }

  private persistAfterMemoryRecovery(
    executionId: string,
    threadId: string,
    chunk: QueuedParentAssistantTextChunk,
    startedAt: number,
    state: ParentAssistantTextDurabilityState,
  ): boolean {
    if (!this.recoverMemory(executionId, state)) return this.retainInMemory(executionId, state, chunk);
    return this.persistChunk(executionId, threadId, chunk, startedAt);
  }

  private retainAfterJournalDrainFailure(
    executionId: string,
    state: ParentAssistantTextDurabilityState,
    chunk: QueuedParentAssistantTextChunk,
  ): boolean {
    if (this.hasStoppedForStorageFailure(executionId)) return false;
    return this.retainInJournalOrMemory(executionId, state, chunk);
  }

  private persistDurableChunk(
    executionId: string,
    state: ParentAssistantTextDurabilityState,
    chunk: QueuedParentAssistantTextChunk,
    startedAt: number,
  ): boolean {
    if (this.wouldExceedRetention(state, chunk)) {
      this.rejectChunk(executionId, state, chunk, "Parent assistant text recovery capacity reached");
      return false;
    }
    try {
      const result = this.checkpoints.appendChunk(chunk.entries.map((entry) => entry.input));
      if (result.outcome === "overflow") {
        this.rejectChunk(executionId, state, chunk, "Parent assistant text recovery capacity reached");
        return false;
      }
      this.acceptAppendResult(result, state, chunk);
      this.recordWindow(this.scheduler.now() - startedAt);
      this.publishChunk(chunk);
      return true;
    } catch (error) {
      if (isRecoverableSqliteFailure(error)) {
        return this.retainInJournalOrMemory(executionId, state, chunk);
      }
      this.rejectChunk(executionId, state, chunk, failureReason(error));
      return false;
    }
  }

  private acceptAppendResult(
    result: ParentAssistantTextCheckpointResult,
    state: ParentAssistantTextDurabilityState,
    chunk: QueuedParentAssistantTextChunk,
  ): void {
    if (result.outcome !== "committed") return;
    this.metrics.committedChunks += 1;
    this.acceptRetainedChunk(state, chunk);
  }

  /** Discard in-memory state before the canonical retry path resets durable provisional text. */
  discard(executionId: string): void {
    const pending = this.pendingByExecution.get(executionId);
    if (pending) {
      this.pendingByExecution.delete(executionId);
      this.scheduler.cancel(pending.timer);
    }
    const state = this.durabilityByExecution.get(executionId);
    if (!state) return;
    this.cancelRetry(state);
    this.durabilityByExecution.delete(executionId);
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

  private stateFor(executionId: string, threadId: string): ParentAssistantTextDurabilityState {
    const existing = this.durabilityByExecution.get(executionId);
    if (existing) return existing;
    const restored = this.checkpoints.restoreChunks?.(executionId) ?? [];
    const state = this.stateFromRestored(threadId, restored);
    this.durabilityByExecution.set(executionId, state);
    return state;
  }

  private stateFromRestored(
    threadId: string,
    restored: readonly RestoredParentAssistantTextChunk[],
  ): ParentAssistantTextDurabilityState {
    return {
      threadId,
      baselineReady: true,
      lastSequence: restored.at(-1)?.lastSequence ?? 0,
      retainedBytes: restored.reduce((total, chunk) => total + chunk.byteLength, 0),
      retainedChunks: restored.length,
      journalActive: false,
      memory: [],
      mode: "durable",
    };
  }

  private retainInJournalOrMemory(
    executionId: string,
    state: ParentAssistantTextDurabilityState,
    chunk: QueuedParentAssistantTextChunk,
  ): boolean {
    if (state.mode === "stopping") return false;
    if (this.wouldExceedRetention(state, chunk)) {
      this.rejectChunk(executionId, state, chunk, "Parent assistant text recovery capacity reached");
      return false;
    }
    const journal = this.checkpoints.recoveryJournal;
    if (!journal?.isAvailable()) return this.retainInMemory(executionId, state, chunk);
    try {
      journal.append(chunk.entries.map((entry) => entry.input));
      state.journalActive = true;
      this.acceptRetainedChunk(state, chunk);
      this.metrics.committedChunks += 1;
      this.publishChunk(chunk);
      this.scheduleRetry(executionId, state);
      return true;
    } catch (error) {
      if (isRecoverableJournalFailure(error)) {
        return this.retainInMemory(executionId, state, chunk);
      }
      this.rejectChunk(executionId, state, chunk, failureReason(error));
      return false;
    }
  }

  private retainInMemory(
    executionId: string,
    state: ParentAssistantTextDurabilityState,
    chunk: QueuedParentAssistantTextChunk,
  ): boolean {
    if (state.mode === "stopping") return false;
    if (this.wouldExceedRetention(state, chunk)) {
      this.rejectChunk(executionId, state, chunk, "Parent assistant text recovery capacity reached");
      return false;
    }
    state.memory.push(chunk);
    this.acceptRetainedChunk(state, chunk);
    if (state.mode !== "saving-delayed") {
      state.mode = "saving-delayed";
      this.emitDurabilityChange(executionId, state);
    }
    this.scheduleRetry(executionId, state);
    return true;
  }

  private recoverMemory(executionId: string, state: ParentAssistantTextDurabilityState): boolean {
    if (!this.recoverMemoryBaseline(executionId, state)) return false;
    if (!this.recoverActiveJournal(executionId, state)) return false;
    if (state.memory.length === 0) return this.completeMemoryRecovery(executionId, state);
    return this.persistMemoryChunks(executionId, state);
  }

  private recoverMemoryBaseline(executionId: string, state: ParentAssistantTextDurabilityState): boolean {
    return state.baselineReady || this.recoverBaseline(executionId, state);
  }

  private recoverActiveJournal(executionId: string, state: ParentAssistantTextDurabilityState): boolean {
    if (!state.journalActive || this.drainJournal(executionId, state)) return true;
    if (state.mode === "stopping") return false;
    this.promoteMemoryToJournal(executionId, state);
    if (!this.hasStoppedForStorageFailure(executionId)) this.scheduleRetry(executionId, state);
    return false;
  }

  private completeMemoryRecovery(executionId: string, state: ParentAssistantTextDurabilityState): true {
    state.mode = "durable";
    this.cancelRetry(state);
    this.emitDurabilityChange(executionId, state);
    return true;
  }

  private persistMemoryChunks(executionId: string, state: ParentAssistantTextDurabilityState): boolean {
    try {
      while (state.memory.length > 0) {
        const chunk = state.memory[0]!;
        const result = this.checkpoints.appendChunk(chunk.entries.map((entry) => entry.input));
        if (result.outcome === "overflow") {
          this.rejectMemory(executionId, state, "Parent assistant text recovery capacity reached");
          return false;
        }
        if (result.outcome === "committed") this.metrics.committedChunks += 1;
        this.publishChunk(chunk);
        state.memory.shift();
      }
      return this.completeMemoryRecovery(executionId, state);
    } catch (error) {
      return this.handleMemoryRecoveryFailure(executionId, state, error);
    }
  }

  private handleMemoryRecoveryFailure(
    executionId: string,
    state: ParentAssistantTextDurabilityState,
    error: unknown,
  ): false {
    if (isRecoverableSqliteFailure(error)) {
      this.promoteMemoryToJournal(executionId, state);
      if (state.mode !== "stopping") this.scheduleRetry(executionId, state);
      return false;
    }
    this.rejectMemory(executionId, state, failureReason(error));
    return false;
  }

  private recoverBaseline(executionId: string, state: ParentAssistantTextDurabilityState): boolean {
    try {
      const restored = this.checkpoints.restoreChunks?.(executionId) ?? [];
      state.baselineReady = true;
      state.lastSequence = restored.at(-1)?.lastSequence ?? 0;
      state.retainedBytes = restored.reduce((total, chunk) => total + chunk.byteLength, 0);
      state.retainedChunks = restored.length;
      return true;
    } catch (error) {
      if (isRecoverableSqliteFailure(error)) {
        this.scheduleRetry(executionId, state);
        return false;
      }
      this.rejectMemory(executionId, state, failureReason(error));
      return false;
    }
  }

  private promoteMemoryToJournal(
    executionId: string,
    state: ParentAssistantTextDurabilityState,
  ): boolean {
    if (state.mode === "stopping") return false;
    const journal = this.checkpoints.recoveryJournal;
    if (!journal?.isAvailable()) return false;
    try {
      while (state.memory.length > 0) {
        const chunk = state.memory[0]!;
        journal.append(chunk.entries.map((entry) => entry.input));
        state.journalActive = true;
        this.metrics.committedChunks += 1;
        this.publishChunk(chunk);
        state.memory.shift();
      }
      state.mode = "durable";
      this.emitDurabilityChange(executionId, state);
      this.scheduleRetry(executionId, state);
      return true;
    } catch (error) {
      if (isRecoverableJournalFailure(error)) return false;
      this.rejectMemory(executionId, state, failureReason(error));
      return false;
    }
  }

  private drainJournal(executionId: string, state: ParentAssistantTextDurabilityState): boolean {
    const journal = this.checkpoints.recoveryJournal;
    const appendRecoveredChunk = this.checkpoints.appendRecoveredChunk;
    if (!journal || !appendRecoveredChunk) return false;
    try {
      journal.drain(executionId, (input) => {
        const result = appendRecoveredChunk.call(this.checkpoints, input);
        if (result.outcome === "overflow") {
          throw new Error("Parent assistant text recovery capacity reached");
        }
      });
      state.journalActive = false;
      this.emitDurabilityChange(executionId, state);
      return true;
    } catch (error) {
      if (isRecoverableSqliteFailure(error) || isRecoverableJournalFailure(error)) return false;
      this.rejectMemory(executionId, state, failureReason(error));
      return false;
    }
  }

  private wouldExceedRetention(
    state: ParentAssistantTextDurabilityState,
    chunk: QueuedParentAssistantTextChunk,
  ): boolean {
    const limits = this.options.limits ?? PARENT_ASSISTANT_TEXT_RETAINED_LIMITS;
    return state.retainedBytes + chunk.byteLength > limits.maxBytes
      || state.retainedChunks + 1 > limits.maxChunks;
  }

  private acceptRetainedChunk(
    state: ParentAssistantTextDurabilityState,
    chunk: QueuedParentAssistantTextChunk,
  ): void {
    state.retainedBytes += chunk.byteLength;
    state.retainedChunks += 1;
  }

  private publishChunk(chunk: QueuedParentAssistantTextChunk): void {
    for (const entry of chunk.entries) {
      entry.publish();
      this.metrics.publishedEvents += 1;
    }
  }

  private rejectChunk(
    executionId: string,
    state: ParentAssistantTextDurabilityState,
    chunk: QueuedParentAssistantTextChunk,
    reason: string,
  ): void {
    this.rejectMemory(executionId, state, reason, chunk);
  }

  private rejectMemory(
    executionId: string,
    state: ParentAssistantTextDurabilityState,
    reason: string,
    rejectedChunk?: QueuedParentAssistantTextChunk,
  ): void {
    this.cancelRetry(state);
    state.mode = "stopping";
    this.emitDurabilityChange(executionId, state);
    const failure = rejectedChunk?.entries[0]?.fail ?? state.memory[0]?.entries[0]?.fail ?? state.fail;
    state.memory = [];
    failure?.(reason);
  }

  private scheduleRetry(executionId: string, state: ParentAssistantTextDurabilityState): void {
    if (state.retryTimer !== undefined) return;
    state.retryTimer = this.scheduler.schedule(() => {
      state.retryTimer = undefined;
      if (state.mode === "saving-delayed") {
        if (!this.recoverMemory(executionId, state)) this.scheduleRetry(executionId, state);
        return;
      }
      if (state.journalActive && !this.drainJournal(executionId, state)) {
        this.scheduleRetry(executionId, state);
      }
    }, this.policy.maxAgeMs);
  }

  private cancelRetry(state: ParentAssistantTextDurabilityState): void {
    if (state.retryTimer === undefined) return;
    this.scheduler.cancel(state.retryTimer);
    state.retryTimer = undefined;
  }

  private emitDurabilityChange(
    executionId: string,
    state: ParentAssistantTextDurabilityState,
  ): void {
    this.options.onDurabilityChange?.({
      threadId: state.threadId,
      executionId,
      mode: state.mode,
    });
  }
}

function failureReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecoverableSqliteFailure(error: unknown): boolean {
  const code = storageFailureCode(error);
  return code === "SQLITE_BUSY"
    || code === "SQLITE_LOCKED"
    || code === "SQLITE_FULL"
    || code.startsWith("SQLITE_IOERR");
}

function isRecoverableJournalFailure(error: unknown): boolean {
  const code = storageFailureCode(error);
  return code === "EACCES"
    || code === "EBUSY"
    || code === "EIO"
    || code === "ENOSPC"
    || code === "EPERM";
}

function storageFailureCode(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : "";
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
