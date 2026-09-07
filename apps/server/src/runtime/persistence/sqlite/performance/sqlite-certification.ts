import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import * as NodePath from "node:path";
import { Database } from "bun:sqlite";
import {
  SQLITE_PROFILE_WORKLOADS,
  type SQLiteProfileReport,
  type SQLiteProfileSample,
} from "./sqlite-profile.js";
import { openDatabase } from "../database.js";
import {
  MIGRATION_BACKUP_RETENTION,
} from "../migration-backup.js";
import {
  SQLITE_ACTIVE_CACHE_KIB,
  SQLITE_BACKGROUND_CACHE_KIB,
  applySQLiteCacheBudget,
} from "../sqlite-connection-policy.js";

/** Result of the forced migration-failure scenario. */
export type SQLiteForcedMigrationFailureCertification =
  | {
    status: "pass";
    restoredDatabase: true;
    backupGenerations: number;
  }
  | { status: "fail"; error: string };

/** Result of the insufficient-disk migration scenario. */
export type SQLiteInsufficientDiskCertification =
  | {
    status: "pass";
    rejectedBeforeMutation: true;
    backupGenerations: 0;
  }
  | { status: "fail"; error: string };

/** Result of the migration-generation retention scenario. */
export type SQLiteRetentionCertification =
  | {
    status: "pass";
    retainedGenerations: number;
    publicTextIdentifierPreserved: true;
    appliedMigrations: number;
  }
  | { status: "fail"; error: string };

/** Recovery evidence recorded by the release-equivalent SQLite run. */
export interface SQLiteRecoveryCertification {
  forcedMigrationFailure: SQLiteForcedMigrationFailureCertification;
  insufficientDisk: SQLiteInsufficientDiskCertification;
  retention: SQLiteRetentionCertification;
}

/** Observed active and background cache-budget pragma values. */
export interface SQLiteCacheBudgetCertification {
  activeKiB: number;
  backgroundKiB: number;
  activePragma: number;
  backgroundPragma: number;
}

/** Combined performance, policy, and recovery certification report. */
export interface SQLiteCertificationReport {
  schemaVersion: 1;
  createdAt: string;
  status: "pass" | "fail";
  failures: string[];
  cacheBudgets: SQLiteCacheBudgetCertification;
  profile: SQLiteProfileReport;
  recovery: SQLiteRecoveryCertification;
}

const PUBLIC_TEXT_IDENTIFIER = "thread-public-id";
const RETENTION_UPGRADE_COUNT = MIGRATION_BACKUP_RETENTION + 2;
const MAX_DRIZZLE_JOURNAL_BYTES = 1_048_576;
const MAX_DRIZZLE_JOURNAL_ENTRIES = 10_000;
const ACTUAL_MIGRATIONS_DIRECTORY = NodeURL.fileURLToPath(
  new URL("../../../../../drizzle", import.meta.url),
);
const EXPECTED_PRAGMAS = {
  journal_mode: "wal",
  synchronous: 2,
  foreign_keys: 1,
  busy_timeout: 5_000,
  cache_size: -SQLITE_ACTIVE_CACHE_KIB,
  mmap_size: 0,
} as const;

/** Run the migration failure, disk preflight, and retention scenarios. */
export function runSQLiteRecoveryCertification(
  certificationDirectory: string,
): SQLiteRecoveryCertification {
  NodeFS.mkdirSync(certificationDirectory, { recursive: true });
  return {
    forcedMigrationFailure: runForcedMigrationFailureScenario(
      NodePath.join(certificationDirectory, "forced-migration-failure"),
    ),
    insufficientDisk: runInsufficientDiskScenario(
      NodePath.join(certificationDirectory, "insufficient-disk"),
    ),
    retention: runRetentionScenario(NodePath.join(certificationDirectory, "retention")),
  };
}

/** Build a combined report and list every failed certification check. */
export function createSQLiteCertificationReport(
  profile: SQLiteProfileReport,
  recovery: SQLiteRecoveryCertification,
  cacheBudgets: SQLiteCacheBudgetCertification,
): SQLiteCertificationReport {
  const failures = collectProfileFailures(profile);
  collectRecoveryFailures(recovery, failures);
  collectCacheBudgetFailures(cacheBudgets, failures);
  return {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    status: failures.length === 0 ? "pass" : "fail",
    failures,
    cacheBudgets,
    profile,
    recovery,
  };
}

/** Observe the production cache policy at background and active budgets. */
export function runSQLiteCacheBudgetCertification(
  certificationDirectory: string,
): SQLiteCacheBudgetCertification {
  NodeFS.mkdirSync(certificationDirectory, { recursive: true });
  const databasePath = NodePath.join(certificationDirectory, "mcode.db");
  return withMigrationsDirectory(ACTUAL_MIGRATIONS_DIRECTORY, () => {
    const database = openDatabase({ dbPath: databasePath });
    try {
      const backgroundKiB = applySQLiteCacheBudget(database, "background");
      const backgroundPragma = readNumericPragma(database, "cache_size");
      const activeKiB = applySQLiteCacheBudget(database, "active");
      const activePragma = readNumericPragma(database, "cache_size");
      return { activeKiB, backgroundKiB, activePragma, backgroundPragma };
    } finally {
      database.close();
    }
  });
}

function runForcedMigrationFailureScenario(
  scenarioDirectory: string,
): SQLiteForcedMigrationFailureCertification {
  const { databasePath, originalBytes } = createScenarioDatabase(scenarioDirectory);
  const migrationsDirectory = NodePath.join(scenarioDirectory, "drizzle");
  const forcedMigrationTag = "0000_forced_failure";
  NodeFS.mkdirSync(NodePath.join(migrationsDirectory, "meta"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(migrationsDirectory, "meta", "_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "sqlite",
      entries: [{
        idx: 0,
        version: "6",
        when: 1,
        tag: forcedMigrationTag,
        breakpoints: true,
      }],
    }),
  );

  let migrationFailed = false;
  withMigrationsDirectory(migrationsDirectory, () => {
    try {
      openDatabase({ dbPath: databasePath }).close();
    } catch (error) {
      if (
        !(error instanceof Error)
        || !error.message.includes(`${forcedMigrationTag}.sql`)
      ) {
        throw error;
      }
      migrationFailed = true;
    }
  });

  const restoredDatabase = NodeFS.readFileSync(databasePath).equals(originalBytes);
  const backupGenerations = countBackupGenerations(databasePath);
  if (!migrationFailed || !restoredDatabase || backupGenerations !== 1) {
    return {
      status: "fail",
      error: `migrationFailed=${migrationFailed}, restoredDatabase=${restoredDatabase}, backupGenerations=${backupGenerations}`,
    };
  }
  return { status: "pass", restoredDatabase: true, backupGenerations };
}

function runInsufficientDiskScenario(
  scenarioDirectory: string,
): SQLiteInsufficientDiskCertification {
  const { databasePath, originalBytes } = createScenarioDatabase(scenarioDirectory);
  let rejected = false;
  try {
    openDatabase({
      dbPath: databasePath,
      migrationBackupSpace: {
        retainedGenerations: MIGRATION_BACKUP_RETENTION,
        availableBytes: 0n,
      },
    }).close();
  } catch (error) {
    if (
      !(error instanceof Error)
      || !error.message.includes("Database migration requires")
      || !error.message.includes("with 0 bytes available")
    ) {
      throw error;
    }
    rejected = true;
  }

  const rejectedBeforeMutation = rejected
    && NodeFS.readFileSync(databasePath).equals(originalBytes);
  const backupGenerations = countBackupGenerations(databasePath);
  if (!rejectedBeforeMutation || backupGenerations !== 0) {
    return {
      status: "fail",
      error: `rejectedBeforeMutation=${rejectedBeforeMutation}, backupGenerations=${backupGenerations}`,
    };
  }
  return { status: "pass", rejectedBeforeMutation: true, backupGenerations: 0 };
}

function runRetentionScenario(
  scenarioDirectory: string,
): SQLiteRetentionCertification {
  const { databasePath } = createScenarioDatabase(scenarioDirectory);
  removeSyntheticDatabase(databasePath);
  const migrationsDirectory = NodePath.join(scenarioDirectory, "drizzle");
  NodeFS.cpSync(ACTUAL_MIGRATIONS_DIRECTORY, migrationsDirectory, { recursive: true });
  const journalPath = NodePath.join(migrationsDirectory, "meta", "_journal.json");
  const journal = readDrizzleJournal(journalPath);
  if (journal.entries.length <= RETENTION_UPGRADE_COUNT) {
    throw new Error(`Retention certification requires more than ${RETENTION_UPGRADE_COUNT} production migrations.`);
  }
  const pendingEntries = journal.entries.splice(-RETENTION_UPGRADE_COUNT);
  NodeFS.writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  const initialMigrationCount = createProductionDatabase(
    databasePath,
    migrationsDirectory,
  );

  withMigrationsDirectory(migrationsDirectory, () => {
    for (const pendingEntry of pendingEntries) {
      journal.entries.push(pendingEntry);
      NodeFS.writeFileSync(journalPath, JSON.stringify(journal, null, 2));
      openDatabase({ dbPath: databasePath }).close();
    }
  });

  const retainedGenerations = countBackupGenerations(databasePath);
  const database = openRawDatabase(databasePath);
  const record = database.prepare("SELECT id FROM threads WHERE id = ?").get(PUBLIC_TEXT_IDENTIFIER) as
    | { id: string }
    | undefined;
  const finalMigrationCount = (
    database.prepare("SELECT COUNT(*) AS count FROM __drizzle_migrations").get() as { count: number }
  ).count;
  database.close();
  const publicTextIdentifierPreserved = record?.id === PUBLIC_TEXT_IDENTIFIER;
  const appliedMigrations = finalMigrationCount - initialMigrationCount;
  const backupIdentifiersPreserved = listBackupGenerations(databasePath).every(
    (backupPath) => databaseContainsPublicIdentifier(backupPath),
  );
  if (
    retainedGenerations !== MIGRATION_BACKUP_RETENTION
    || !publicTextIdentifierPreserved
    || !backupIdentifiersPreserved
    || appliedMigrations !== RETENTION_UPGRADE_COUNT
  ) {
    return {
      status: "fail",
      error: `retainedGenerations=${retainedGenerations}, publicTextIdentifierPreserved=${publicTextIdentifierPreserved}, backupIdentifiersPreserved=${backupIdentifiersPreserved}, appliedMigrations=${appliedMigrations}`,
    };
  }
  return {
    status: "pass",
    retainedGenerations,
    publicTextIdentifierPreserved: true,
    appliedMigrations,
  };
}

function createScenarioDatabase(scenarioDirectory: string): {
  databasePath: string;
  originalBytes: Buffer;
} {
  NodeFS.mkdirSync(scenarioDirectory, { recursive: true });
  const databasePath = NodePath.join(scenarioDirectory, "mcode.db");
  createDatabaseWithPublicIdentifier(databasePath);
  return { databasePath, originalBytes: NodeFS.readFileSync(databasePath) };
}

function removeSyntheticDatabase(databasePath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = `${databasePath}${suffix}`;
    if (NodeFS.existsSync(path)) NodeFS.unlinkSync(path);
  }
}

function createProductionDatabase(
  databasePath: string,
  migrationsDirectory: string,
): number {
  return withMigrationsDirectory(migrationsDirectory, () => {
    const database = openDatabase({ dbPath: databasePath });
    try {
      const timestamp = "2026-01-01T00:00:00.000Z";
      database.prepare(
        "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).run("certification-workspace", "Certification", "/mcode/certification", timestamp, timestamp);
      database.prepare(
        "INSERT INTO threads (id, workspace_id, title, branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(PUBLIC_TEXT_IDENTIFIER, "certification-workspace", "Certification", "main", timestamp, timestamp);
      return (
        database.prepare("SELECT COUNT(*) AS count FROM __drizzle_migrations").get() as { count: number }
      ).count;
    } finally {
      database.close();
    }
  });
}

interface DrizzleJournal {
  version: string;
  dialect: string;
  entries: Array<{
    idx: number;
    version: string;
    when: number;
    tag: string;
    breakpoints: boolean;
  }>;
}

function readDrizzleJournal(journalPath: string): DrizzleJournal {
  const journalBytes = NodeFS.statSync(journalPath).size;
  if (journalBytes > MAX_DRIZZLE_JOURNAL_BYTES) {
    throw new Error(`Drizzle journal exceeds ${MAX_DRIZZLE_JOURNAL_BYTES} bytes.`);
  }
  const value: unknown = JSON.parse(NodeFS.readFileSync(journalPath, "utf8"));
  if (!isRecord(value) || value.dialect !== "sqlite" || typeof value.version !== "string") {
    throw new Error("Drizzle journal has an invalid header.");
  }
  if (
    !Array.isArray(value.entries)
    || value.entries.length === 0
    || value.entries.length > MAX_DRIZZLE_JOURNAL_ENTRIES
    || !value.entries.every(isDrizzleJournalEntry)
  ) {
    throw new Error("Drizzle journal has invalid or unbounded entries.");
  }
  return {
    version: value.version,
    dialect: value.dialect,
    entries: value.entries,
  };
}

function isDrizzleJournalEntry(value: unknown): value is DrizzleJournal["entries"][number] {
  return isRecord(value)
    && Number.isSafeInteger(value.idx)
    && typeof value.version === "string"
    && value.version.length <= 16
    && Number.isSafeInteger(value.when)
    && typeof value.tag === "string"
    && /^[a-z0-9_]{1,100}$/.test(value.tag)
    && typeof value.breakpoints === "boolean";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNumericPragma(database: Database, name: string): number {
  const value = (database.query(`PRAGMA ${name}`).get() as Record<string, unknown> | null)?.[name];
  if (typeof value !== "number") {
    throw new Error(`PRAGMA ${name} returned ${typeof value}, expected number.`);
  }
  return value;
}

function createDatabaseWithPublicIdentifier(databasePath: string): void {
  const database = openRawDatabase(databasePath);
  try {
    database.exec("CREATE TABLE records (id TEXT PRIMARY KEY)");
    database.prepare("INSERT INTO records (id) VALUES (?)").run(PUBLIC_TEXT_IDENTIFIER);
  } finally {
    database.close();
  }
}

function openRawDatabase(databasePath: string): Database {
  return new Database(databasePath, { strict: true });
}

function withMigrationsDirectory<T>(directory: string, work: () => T): T {
  const original = process.env.MCODE_DRIZZLE_MIGRATIONS_DIR;
  process.env.MCODE_DRIZZLE_MIGRATIONS_DIR = directory;
  try {
    return work();
  } finally {
    if (original === undefined) {
      delete process.env.MCODE_DRIZZLE_MIGRATIONS_DIR;
    } else {
      process.env.MCODE_DRIZZLE_MIGRATIONS_DIR = original;
    }
  }
}

function countBackupGenerations(databasePath: string): number {
  return listBackupGenerations(databasePath).length;
}

function listBackupGenerations(databasePath: string): string[] {
  const prefix = `${NodePath.basename(databasePath)}.bak-`;
  return NodeFS.readdirSync(NodePath.dirname(databasePath))
    .filter((entry) => entry.startsWith(prefix) && !entry.endsWith("-wal"))
    .map((entry) => NodePath.join(NodePath.dirname(databasePath), entry));
}

function databaseContainsPublicIdentifier(databasePath: string): boolean {
  const database = openRawDatabase(databasePath);
  try {
    return database.prepare("SELECT id FROM threads WHERE id = ?")
      .get(PUBLIC_TEXT_IDENTIFIER) !== null;
  } finally {
    database.close();
  }
}

function collectProfileFailures(profile: SQLiteProfileReport): string[] {
  const failures: string[] = [];
  const comparison = profile.comparison;
  if (!comparison) {
    failures.push("The certification requires an approved performance baseline.");
  } else {
    if (comparison.thresholdPercent > 5) {
      failures.push(`The regression threshold is ${comparison.thresholdPercent} percent; the maximum is 5 percent.`);
    }
    for (const regression of comparison.regressions) {
      failures.push(
        `${regression.workload} ${regression.metric} regressed by ${String(regression.changePercent)} percent.`,
      );
    }
    failures.push(...comparison.warnings);
  }

  const expectedSampleCount = profile.samplesPerWorkload
    * SQLITE_PROFILE_WORKLOADS.length;
  if (profile.samples.length !== expectedSampleCount) {
    failures.push(`The profile contains ${profile.samples.length} samples; expected ${expectedSampleCount}.`);
  }
  for (const workload of SQLITE_PROFILE_WORKLOADS) {
    const count = profile.samples.filter((sample) => sample.workload === workload).length;
    if (count !== profile.samplesPerWorkload) {
      failures.push(`${workload} contains ${count} samples; expected ${profile.samplesPerWorkload}.`);
    }
  }
  for (const sample of profile.samples) {
    collectSampleFailures(sample, failures);
  }
  return failures;
}

function collectSampleFailures(
  sample: SQLiteProfileSample,
  failures: string[],
): void {
  const label = `${sample.workload} sample ${sample.sample}`;
  if (sample.queryPlans.length === 0 || sample.queryPlans.some((plan) => plan.rows.length === 0)) {
    failures.push(`${label} has no query plans.`);
  }
  for (const [name, expected] of Object.entries(EXPECTED_PRAGMAS)) {
    const actual = sample.pragmas[name];
    if (actual !== expected) {
      failures.push(`${label} requires PRAGMA ${name}=${expected}; received ${String(actual)}.`);
    }
  }
  const measurements = [
    sample.durationMs,
    sample.returnedBytes,
    ...Object.values(sample.memory),
  ];
  if (measurements.some((value) => !Number.isFinite(value) || value < 0)) {
    failures.push(`${label} contains an invalid duration, byte count, or memory value.`);
  }
}

function collectRecoveryFailures(
  recovery: SQLiteRecoveryCertification,
  failures: string[],
): void {
  if (recovery.forcedMigrationFailure.status === "fail") {
    failures.push(`Forced migration failure: ${recovery.forcedMigrationFailure.error}`);
  }
  if (recovery.insufficientDisk.status === "fail") {
    failures.push(`Insufficient disk: ${recovery.insufficientDisk.error}`);
  }
  if (recovery.retention.status === "fail") {
    failures.push(`Generation retention: ${recovery.retention.error}`);
  }
}

function collectCacheBudgetFailures(
  cacheBudgets: SQLiteCacheBudgetCertification,
  failures: string[],
): void {
  if (
    cacheBudgets.activeKiB !== SQLITE_ACTIVE_CACHE_KIB
    || cacheBudgets.activePragma !== -SQLITE_ACTIVE_CACHE_KIB
  ) {
    failures.push(`Active cache budget requires ${SQLITE_ACTIVE_CACHE_KIB} KiB and PRAGMA cache_size=-${SQLITE_ACTIVE_CACHE_KIB}.`);
  }
  if (
    cacheBudgets.backgroundKiB !== SQLITE_BACKGROUND_CACHE_KIB
    || cacheBudgets.backgroundPragma !== -SQLITE_BACKGROUND_CACHE_KIB
  ) {
    failures.push(`Background cache budget requires ${SQLITE_BACKGROUND_CACHE_KIB} KiB and PRAGMA cache_size=-${SQLITE_BACKGROUND_CACHE_KIB}.`);
  }
}
