import type {
  PtyHostCleanupLedgerStore,
  PtyHostCleanupRecord,
} from "../cleanup/terminal-cleanup-ledger.js";

/** In-memory cleanup ledger used by deterministic and real-host tests. */
export class InMemoryPtyHostCleanupLedger
  implements PtyHostCleanupLedgerStore
{
  private readonly records = new Map<string, PtyHostCleanupRecord>();

  /** Adds or replaces one test process identity. */
  record(record: PtyHostCleanupRecord): void {
    this.records.set(record.sessionId, { ...record });
  }

  /** Removes one matching test process identity. */
  remove(sessionId: string, hostGeneration: string): boolean {
    const record = this.records.get(sessionId);
    if (!record || record.hostGeneration !== hostGeneration) return false;
    return this.records.delete(sessionId);
  }

  /** Returns one test process identity. */
  get(sessionId: string): PtyHostCleanupRecord | null {
    const record = this.records.get(sessionId);
    return record ? { ...record } : null;
  }

  /** Returns all test process identities. */
  list(): readonly PtyHostCleanupRecord[] {
    return [...this.records.values()].map((record) => ({ ...record }));
  }

  /** Returns test process identities for one host generation. */
  forGeneration(hostGeneration: string): readonly PtyHostCleanupRecord[] {
    return this.list().filter(
      (record) => record.hostGeneration === hostGeneration,
    );
  }
}
