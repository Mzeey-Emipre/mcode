import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSQLiteCertificationReport,
  runSQLiteCacheBudgetCertification,
  runSQLiteRecoveryCertification,
} from "../sqlite-certification.js";
import {
  ACTIVE_TURN_WRITE_POLICY,
  SQLITE_PROFILE_WORKLOADS,
  type SQLiteProfileReport,
} from "../sqlite-profile.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const distribution = {
  min: 1,
  max: 1,
  mean: 1,
  median: 1,
  p95: 1,
  standardDeviation: 0,
};

function passingProfile(): SQLiteProfileReport {
  const runtime = {
    platform: process.platform,
    architecture: process.arch,
    nodeVersion: process.version,
    electronVersion: process.versions.electron ?? null,
    sqliteVersion: "3.49.0",
    cpu: "Certification CPU",
  };
  return {
    schemaVersion: 2,
    createdAt: "2026-08-10T00:00:00.000Z",
    samplesPerWorkload: 3,
    activeTurnWritePolicy: ACTIVE_TURN_WRITE_POLICY,
    seed: {
      messages: 1200,
      assistantNarrativeRows: 1800,
      contentBytesPerMessage: 1,
    },
    runtime,
    samples: [1, 2, 3].flatMap((sample) =>
      SQLITE_PROFILE_WORKLOADS.map((workload, index) => ({
        workload,
        sample,
        durationMs: 1,
        returnedBytes: 1,
        memory: {
          rssBeforeBytes: 1,
          rssAfterBytes: 1,
          rssPeakBytes: 1,
          heapUsedBeforeBytes: 1,
          heapUsedAfterBytes: 1,
          heapUsedPeakBytes: 1,
          externalBeforeBytes: 1,
          externalAfterBytes: 1,
          externalPeakBytes: 1,
        },
        queryPlans: [{
          name: `plan-${index}`,
          sql: "SELECT 1",
          rows: [{ id: 1, parent: 0, detail: "SCAN CONSTANT ROW" }],
        }],
        pragmas: {
          journal_mode: "wal",
          synchronous: 2,
          foreign_keys: 1,
          busy_timeout: 5_000,
          cache_size: -2_048,
          mmap_size: 0,
        },
      }))),
    aggregates: SQLITE_PROFILE_WORKLOADS.map((workload) => ({
      workload,
      samples: 3,
      durationMs: distribution,
      returnedBytes: distribution,
      rssPeakBytes: distribution,
      heapUsedPeakBytes: distribution,
      externalPeakBytes: distribution,
    })),
    comparison: {
      baselinePath: "approved-baseline.json",
      thresholdPercent: 5,
      regressions: [],
      metrics: [],
      warnings: [],
    },
  };
}

describe("SQLite release certification", () => {
  it("proves migration recovery, disk rejection, and five-generation retention", () => {
    const directory = mkdtempSync(join(tmpdir(), "mcode-sqlite-certification-"));
    directories.push(directory);

    const recovery = runSQLiteRecoveryCertification(directory);

    expect(recovery).toEqual({
      forcedMigrationFailure: {
        status: "pass",
        restoredDatabase: true,
        backupGenerations: 1,
      },
      insufficientDisk: {
        status: "pass",
        rejectedBeforeMutation: true,
        backupGenerations: 0,
      },
      retention: {
        status: "pass",
        retainedGenerations: 5,
        publicTextIdentifierPreserved: true,
        appliedMigrations: 7,
      },
    });

    expect(runSQLiteCacheBudgetCertification(join(directory, "cache-budget"))).toEqual({
      activeKiB: 2_048,
      backgroundKiB: 500,
      activePragma: -2_048,
      backgroundPragma: -500,
    });
  }, 15_000);

  it("passes only when the profile contains complete release evidence", () => {
    const report = createSQLiteCertificationReport(passingProfile(), {
      forcedMigrationFailure: {
        status: "pass",
        restoredDatabase: true,
        backupGenerations: 1,
      },
      insufficientDisk: {
        status: "pass",
        rejectedBeforeMutation: true,
        backupGenerations: 0,
      },
      retention: {
        status: "pass",
        retainedGenerations: 5,
        publicTextIdentifierPreserved: true,
        appliedMigrations: 7,
      },
    }, {
      activeKiB: 2_048,
      backgroundKiB: 500,
      activePragma: -2_048,
      backgroundPragma: -500,
    });

    expect(report.status).toBe("pass");
    expect(report.failures).toEqual([]);
    expect(report.cacheBudgets).toEqual({
      activeKiB: 2_048,
      backgroundKiB: 500,
      activePragma: -2_048,
      backgroundPragma: -500,
    });
    expect(report.profile.samples).toHaveLength(SQLITE_PROFILE_WORKLOADS.length * 3);
  });

  it("fails for regressions, runtime drift, missing plans, or incorrect pragmas", () => {
    const profile = passingProfile();
    profile.comparison!.regressions.push({
      workload: "active-turn-writes",
      metric: "durationMs",
      baselineMedian: 1,
      candidateMedian: 1.1,
      changePercent: 10,
      thresholdPercent: 5,
      status: "regression",
    });
    profile.comparison!.warnings.push("Runtime mismatch for cpu.");
    profile.samples[0]!.queryPlans = [];
    profile.samples[1]!.pragmas.synchronous = 1;

    const report = createSQLiteCertificationReport(profile, {
      forcedMigrationFailure: { status: "fail", error: "restore failed" },
      insufficientDisk: { status: "fail", error: "preflight did not reject" },
      retention: { status: "fail", error: "retained six generations" },
    }, {
      activeKiB: 2_048,
      backgroundKiB: 500,
      activePragma: -2_048,
      backgroundPragma: -600,
    });

    expect(report.status).toBe("fail");
    expect(report.failures).toEqual(expect.arrayContaining([
      expect.stringContaining("active-turn-writes durationMs regressed"),
      "Runtime mismatch for cpu.",
      expect.stringContaining("startup-and-migrations sample 1 has no query plans"),
      expect.stringContaining("active-turn-writes sample 1 requires PRAGMA synchronous=2"),
      "Forced migration failure: restore failed",
      "Insufficient disk: preflight did not reject",
      "Generation retention: retained six generations",
      expect.stringContaining("Background cache budget requires 500 KiB"),
    ]));
  });
});
