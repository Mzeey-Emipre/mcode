/**
 * Pre-migration safety net: copies the SQLite file (and its WAL sidecar) to a
 * timestamped backup before `migrate()` runs, so a botched migration can be
 * fully restored even if the schema mutation itself committed partial damage
 * before throwing. Old backups are pruned to a small ring so disk pressure
 * stays bounded over many app starts.
 */

import { randomUUID } from "crypto";
import {
  copyFileSync,
  existsSync,
  readdirSync,
  statfsSync,
  statSync,
  unlinkSync,
} from "fs";
import { basename, dirname, join } from "path";

/** Sidecar files SQLite may write next to the main DB in WAL mode. */
const WAL_SUFFIX = "-wal";
const SHM_SUFFIX = "-shm";

/** Number of recoverable database generations retained after upgrades. */
export const MIGRATION_BACKUP_RETENTION = 5;

/** Disk-space inputs for the migration backup preflight. */
export interface MigrationBackupSpaceOptions {
  availableBytes?: bigint;
  retainedGenerations: number;
}

/** Suffix used to identify migration backups belonging to a given DB file. */
function backupPrefix(dbPath: string): string {
  return `${basename(dbPath)}.bak-`;
}

function migrationBackupPaths(dbPath: string): string[] {
  const dir = dirname(dbPath);
  const prefix = backupPrefix(dbPath);
  return readdirSync(dir)
    .filter((entry) => entry.startsWith(prefix) && !entry.endsWith(WAL_SUFFIX))
    .map((entry) => join(dir, entry));
}

/** Reject a migration when the configured recovery generations cannot fit. */
export function assertMigrationBackupSpace(
  dbPath: string,
  options: MigrationBackupSpaceOptions,
): void {
  if (!Number.isSafeInteger(options.retainedGenerations) || options.retainedGenerations < 1) {
    throw new Error("retainedGenerations must be a positive safe integer");
  }
  if (dbPath === ":memory:" || !existsSync(dbPath)) return;

  const databaseBytes = statSync(dbPath, { bigint: true }).size;
  const walPath = `${dbPath}${WAL_SUFFIX}`;
  const walBytes = existsSync(walPath) ? statSync(walPath, { bigint: true }).size : 0n;
  const existingGenerations = migrationBackupPaths(dbPath).length;
  const missingGenerations = Math.max(
    0,
    options.retainedGenerations - existingGenerations,
  );
  const additionalGenerations = Math.max(1, missingGenerations);
  const requiredBytes = (databaseBytes + walBytes) * BigInt(additionalGenerations);
  let availableBytes = options.availableBytes;
  if (availableBytes === undefined) {
    const filesystem = statfsSync(dirname(dbPath), { bigint: true });
    availableBytes = filesystem.bavail * filesystem.bsize;
  }

  if (availableBytes < 0n) {
    throw new Error("availableBytes must not be negative");
  }
  if (availableBytes < requiredBytes) {
    throw new Error(
      `Database migration requires ${requiredBytes} bytes for ${options.retainedGenerations} recoverable generations, with ${availableBytes} bytes available.`,
    );
  }
}

/**
 * Copy `dbPath` (and its WAL sidecar, if present) to a timestamped backup.
 *
 * Returns the backup path on success or `null` when there is nothing to back
 * up (in-memory database, or the file does not exist yet because this is a
 * first-run install). The caller must make sure that no process writes to the
 * database while the main file and its WAL are copied.
 */
export function createMigrationBackup(
  dbPath: string,
  options: MigrationBackupSpaceOptions = {
    retainedGenerations: MIGRATION_BACKUP_RETENTION,
  },
): string | null {
  if (dbPath === ":memory:" || !existsSync(dbPath)) return null;
  assertMigrationBackupSpace(dbPath, options);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${dbPath}.bak-${stamp}-${randomUUID()}`;
  copyFileSync(dbPath, backupPath);

  const walSrc = `${dbPath}${WAL_SUFFIX}`;
  try {
    if (existsSync(walSrc)) {
      copyFileSync(walSrc, `${backupPath}${WAL_SUFFIX}`);
    }
  } catch (error) {
    unlinkSync(backupPath);
    throw error;
  }
  return backupPath;
}

/**
 * Restore a backup created by `createMigrationBackup` over the live DB path.
 *
 * Removes any current `-wal` / `-shm` sidecars first so SQLite cannot replay
 * a journal from the failed migration over the restored file. The shared
 * memory file is regenerated automatically on next open.
 */
export function restoreMigrationBackup(backupPath: string, dbPath: string): void {
  for (const suffix of [WAL_SUFFIX, SHM_SUFFIX]) {
    const sidecar = `${dbPath}${suffix}`;
    if (existsSync(sidecar)) unlinkSync(sidecar);
  }

  copyFileSync(backupPath, dbPath);

  const walBackup = `${backupPath}${WAL_SUFFIX}`;
  if (existsSync(walBackup)) {
    copyFileSync(walBackup, `${dbPath}${WAL_SUFFIX}`);
  }
}

/** Restore the usable generation, then rethrow the migration failure. */
export function restoreMigrationBackupAfterFailure(
  backupPath: string,
  dbPath: string,
  migrationError: unknown,
): never {
  try {
    restoreMigrationBackup(backupPath, dbPath);
  } catch (restoreError) {
    throw new AggregateError(
      [migrationError, restoreError],
      "Database migration failed and automatic restore failed.",
    );
  }
  throw migrationError;
}

/**
 * Delete all but the most recent `keep` migration backups for `dbPath`.
 * Backup pairs (`.bak-*` and matching `-wal`) are removed together so the
 * directory does not accumulate orphan WAL copies.
 */
export function pruneMigrationBackups(
  dbPath: string,
  keep = MIGRATION_BACKUP_RETENTION,
): void {
  if (keep < 0) throw new Error("keep must be >= 0");
  if (dbPath === ":memory:") return;

  const dir = dirname(dbPath);
  if (!existsSync(dir)) return;

  const entries = migrationBackupPaths(dbPath)
    .map((full) => {
      return { full, mtime: statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);

  for (const { full } of entries.slice(keep)) {
    unlinkSync(full);
    const wal = `${full}${WAL_SUFFIX}`;
    if (existsSync(wal)) {
      unlinkSync(wal);
    }
  }
}
