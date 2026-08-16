import type {
  PtyHostCleanupLedgerStore,
  PtyHostCleanupRecord,
} from "./terminal-cleanup-ledger.js";

/** Reaps bounded process records and removes only identities that completed cleanup. */
export async function reapPtyHostCleanupRecords(
  ledger: PtyHostCleanupLedgerStore,
  records: readonly PtyHostCleanupRecord[],
  reap: (record: PtyHostCleanupRecord) => Promise<void>,
): Promise<unknown[]> {
  const results = await Promise.allSettled(
    records.map(async (record) => {
      await reap(record);
      ledger.remove(record.sessionId, record.hostGeneration);
    }),
  );
  return results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
}
