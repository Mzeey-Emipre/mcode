import type Database from "better-sqlite3";

const MAX_LEDGER_RECORDS = 20;
const MAX_PROCESS_GROUP_ID_LENGTH = 128;
const MAX_U64 = 18_446_744_073_709_551_615n;
const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Process identity retained only for bounded PTY host cleanup. */
export interface PtyHostCleanupRecord {
  readonly sessionId: string;
  readonly hostGeneration: string;
  readonly rootPid: number;
  readonly processGroupId: string;
  readonly containment: "job-object" | "process-group";
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

interface PtyHostCleanupRow {
  readonly session_id: string;
  readonly host_generation: string;
  readonly root_pid: number;
  readonly process_group_id: string;
  readonly containment: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/** Persistence seam required by PTY host supervision and recovery. */
export interface PtyHostCleanupLedgerStore {
  record(record: PtyHostCleanupRecord): void;
  remove(sessionId: string, hostGeneration: string): boolean;
  get(sessionId: string): PtyHostCleanupRecord | null;
  list(): readonly PtyHostCleanupRecord[];
  forGeneration(hostGeneration: string): readonly PtyHostCleanupRecord[];
}

/** Bounded SQLite cleanup ledger for process trees owned by supervised host generations. */
export class PtyHostCleanupLedger implements PtyHostCleanupLedgerStore {
  constructor(
    private readonly db: Database.Database,
    private readonly limit = MAX_LEDGER_RECORDS,
  ) {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LEDGER_RECORDS) {
      throw new Error("PTY cleanup ledger limit must be between 1 and 20");
    }
  }

  /** Adds one process identity or refreshes the matching generation record. */
  record(record: PtyHostCleanupRecord): void {
    const parsed = validateRecord(record);
    this.db.transaction(() => {
      const existing = this.db
        .prepare(
          `SELECT host_generation, root_pid, process_group_id, containment
           FROM terminal_cleanup_ledger WHERE session_id = ?`,
        )
        .get(parsed.sessionId) as
        | Pick<
            PtyHostCleanupRow,
            | "host_generation"
            | "root_pid"
            | "process_group_id"
            | "containment"
          >
        | undefined;
      if (existing && existing.host_generation !== parsed.hostGeneration) {
        throw new Error(
          `PTY cleanup ledger session ${parsed.sessionId} belongs to host generation ${existing.host_generation}`,
        );
      }
      if (
        existing &&
        (existing.root_pid !== parsed.rootPid ||
          existing.process_group_id !== parsed.processGroupId ||
          existing.containment !== parsed.containment)
      ) {
        throw new Error(
          `PTY cleanup ledger session ${parsed.sessionId} has another process identity`,
        );
      }
      const count = this.db
        .prepare("SELECT COUNT(*) AS count FROM terminal_cleanup_ledger")
        .get() as { count: number };
      if (!existing && count.count >= this.limit) {
        throw new Error(`PTY cleanup ledger limit (${this.limit}) reached`);
      }
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO terminal_cleanup_ledger (
            session_id, host_generation, root_pid, process_group_id,
            containment, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(session_id) DO UPDATE SET
            root_pid = excluded.root_pid,
            process_group_id = excluded.process_group_id,
            containment = excluded.containment,
            updated_at = excluded.updated_at`,
        )
        .run(
          parsed.sessionId,
          parsed.hostGeneration,
          parsed.rootPid,
          parsed.processGroupId,
          parsed.containment,
          now,
          now,
        );
    })();
  }

  /** Removes one record only when its session and host generation match. */
  remove(sessionId: string, hostGeneration: string): boolean {
    validateSessionId(sessionId);
    validateHostGeneration(hostGeneration);
    return (
      this.db
        .prepare(
          "DELETE FROM terminal_cleanup_ledger WHERE session_id = ? AND host_generation = ?",
        )
        .run(sessionId, hostGeneration).changes > 0
    );
  }

  /** Returns one validated persisted process identity. */
  get(sessionId: string): PtyHostCleanupRecord | null {
    validateSessionId(sessionId);
    const row = this.db
      .prepare(
        "SELECT * FROM terminal_cleanup_ledger WHERE session_id = ?",
      )
      .get(sessionId) as PtyHostCleanupRow | undefined;
    return row ? parseRow(row) : null;
  }

  /** Returns every validated process identity in stable creation order. */
  list(): readonly PtyHostCleanupRecord[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM terminal_cleanup_ledger ORDER BY created_at, session_id",
        )
        .all() as PtyHostCleanupRow[]
    ).map(parseRow);
  }

  /** Returns a validated snapshot for one crashed host generation. */
  forGeneration(hostGeneration: string): readonly PtyHostCleanupRecord[] {
    validateHostGeneration(hostGeneration);
    return (
      this.db
        .prepare(
          "SELECT * FROM terminal_cleanup_ledger WHERE host_generation = ? ORDER BY created_at, session_id",
        )
        .all(hostGeneration) as PtyHostCleanupRow[]
    ).map(parseRow);
  }
}

function parseRow(row: PtyHostCleanupRow): PtyHostCleanupRecord {
  return validateRecord({
    sessionId: row.session_id,
    hostGeneration: row.host_generation,
    rootPid: row.root_pid,
    processGroupId: row.process_group_id,
    containment: row.containment as PtyHostCleanupRecord["containment"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function validateRecord(record: PtyHostCleanupRecord): PtyHostCleanupRecord {
  validateSessionId(record.sessionId);
  validateHostGeneration(record.hostGeneration);
  if (
    !Number.isSafeInteger(record.rootPid) ||
    record.rootPid <= 1 ||
    record.rootPid > 4_294_967_295
  ) {
    throw new Error("PTY cleanup ledger root PID is unsafe");
  }
  if (
    record.processGroupId.length < 1 ||
    record.processGroupId.length > MAX_PROCESS_GROUP_ID_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(record.processGroupId)
  ) {
    throw new Error("PTY cleanup ledger process group identity is invalid");
  }
  if (
    record.containment !== "job-object" &&
    record.containment !== "process-group"
  ) {
    throw new Error("PTY cleanup ledger containment is invalid");
  }
  if (record.createdAt !== undefined && !isIsoTimestamp(record.createdAt)) {
    throw new Error("PTY cleanup ledger creation time is invalid");
  }
  if (record.updatedAt !== undefined && !isIsoTimestamp(record.updatedAt)) {
    throw new Error("PTY cleanup ledger update time is invalid");
  }
  return { ...record };
}

function validateSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error("PTY cleanup ledger session ID is invalid");
  }
}

function validateHostGeneration(hostGeneration: string): void {
  if (!/^[1-9]\d*$/.test(hostGeneration)) {
    throw new Error("PTY cleanup ledger host generation is invalid");
  }
  const generation = BigInt(hostGeneration);
  if (generation > MAX_U64) {
    throw new Error("PTY cleanup ledger host generation is invalid");
  }
}

function isIsoTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}
