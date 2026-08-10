/** Process identity retained only for bounded PTY host cleanup. */
export interface PtyHostCleanupRecord {
  readonly sessionId: string;
  readonly hostGeneration: string;
  readonly rootPid: number;
  readonly processGroupId: string;
}

/** Bounded cleanup ledger for process trees owned by supervised host generations. */
export class PtyHostCleanupLedger {
  private readonly records = new Map<string, PtyHostCleanupRecord>();

  constructor(private readonly limit = 20) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
      throw new Error("PTY cleanup ledger limit must be between 1 and 20");
    }
  }

  /** Adds or replaces one session process identity. */
  record(record: PtyHostCleanupRecord): void {
    if (
      !this.records.has(record.sessionId) &&
      this.records.size >= this.limit
    ) {
      throw new Error(`PTY cleanup ledger limit (${this.limit}) reached`);
    }
    if (!Number.isInteger(record.rootPid) || record.rootPid <= 1) {
      throw new Error("PTY cleanup ledger root PID is unsafe");
    }
    this.records.set(record.sessionId, { ...record });
  }

  /** Removes one exited session from the cleanup ledger. */
  remove(sessionId: string): void {
    this.records.delete(sessionId);
  }

  /** Returns one session process identity. */
  get(sessionId: string): PtyHostCleanupRecord | null {
    const record = this.records.get(sessionId);
    return record ? { ...record } : null;
  }

  /** Returns a snapshot for one crashed host generation. */
  forGeneration(hostGeneration: string): readonly PtyHostCleanupRecord[] {
    return [...this.records.values()].filter(
      (record) => record.hostGeneration === hostGeneration,
    );
  }

  /** Removes every record owned by one fully reaped generation. */
  removeGeneration(hostGeneration: string): void {
    for (const [sessionId, record] of this.records) {
      if (record.hostGeneration === hostGeneration)
        this.records.delete(sessionId);
    }
  }
}
