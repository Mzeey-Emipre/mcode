import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openMemoryDatabase } from "../../database.js";
import {
  ACTIVE_TURN_WRITE_POLICY,
  SQLITE_PROFILE_WORKLOADS,
  assertConversationHistoryQueryPlans,
  compareSQLiteProfileReports,
  parseSQLiteProfileBaseline,
  parseSQLiteProfileCliOptions,
  runSQLiteCheckpointPolicyProfile,
  summarizeSQLiteProfileSamples,
  type SQLiteProfileAggregate,
  type SQLiteQueryPlan,
  type SQLiteProfileReport,
} from "../sqlite-profile.js";

const distribution = (median: number) => ({
  min: median,
  max: median,
  mean: median,
  median,
  p95: median,
  standardDeviation: 0,
});

function aggregates(value: number): SQLiteProfileAggregate[] {
  return SQLITE_PROFILE_WORKLOADS.map((workload) => ({
    workload,
    samples: 20,
    durationMs: distribution(value),
    returnedBytes: distribution(value),
    rssPeakBytes: distribution(value),
    heapUsedPeakBytes: distribution(value),
    externalPeakBytes: distribution(value),
  }));
}

const runtime: SQLiteProfileReport["runtime"] = {
  platform: "win32",
  architecture: "x64",
  nodeVersion: "v22.0.0",
  electronVersion: "35.0.0",
  sqliteVersion: "3.49.0",
  cpu: "Profile CPU",
};

describe("parseSQLiteProfileCliOptions", () => {
  it("uses enough default samples to expose variance", () => {
    expect(parseSQLiteProfileCliOptions([])).toEqual({
      samples: 20,
      thresholdPercent: 5,
      certify: false,
      help: false,
    });
  });

  it("parses explicit comparison options", () => {
    expect(parseSQLiteProfileCliOptions([
      "--samples=9",
      "--baseline",
      "baseline.json",
      "--output=result.json",
      "--threshold-percent",
      "6.5",
      "--certify",
    ])).toEqual({
      samples: 9,
      baselinePath: "baseline.json",
      outputPath: "result.json",
      thresholdPercent: 6.5,
      certify: true,
      help: false,
    });
  });

  it("rejects a single sample and unknown options", () => {
    expect(() => parseSQLiteProfileCliOptions(["--samples", "1"])).toThrow(
      "--samples must be from 3 to 50",
    );
    expect(() => parseSQLiteProfileCliOptions(["--quick"])).toThrow("Unknown option");
  });
});

describe("compareSQLiteProfileReports", () => {
  it("flags medians above five percent but accepts the boundary", () => {
    const baseline = parseSQLiteProfileBaseline({
      schemaVersion: 2,
      runtime,
      aggregates: aggregates(100),
    });
    const candidateAggregates = aggregates(105);
    candidateAggregates[0]!.durationMs = distribution(105.01);

    const comparison = compareSQLiteProfileReports(
      { runtime, aggregates: candidateAggregates },
      baseline,
      "baseline.json",
    );

    expect(comparison.regressions).toEqual([
      expect.objectContaining({
        workload: "startup-and-migrations",
        metric: "durationMs",
        status: "regression",
      }),
    ]);
    expect(comparison.metrics.find((metric) =>
      metric.workload === "active-turn-writes" && metric.metric === "durationMs"
    )?.status).toBe("pass");
  });

  it("reports runtime mismatches without hiding the comparison", () => {
    const baseline = parseSQLiteProfileBaseline({
      schemaVersion: 2,
      runtime: { ...runtime, nodeVersion: "v20.0.0" },
      aggregates: aggregates(100),
    });

    const comparison = compareSQLiteProfileReports(
      { runtime, aggregates: aggregates(100) },
      baseline,
      "baseline.json",
    );

    expect(comparison.regressions).toHaveLength(0);
    expect(comparison.warnings).toEqual([
      "Runtime mismatch for nodeVersion: baseline=v20.0.0, candidate=v22.0.0.",
    ]);
  });
});

describe("parseSQLiteProfileBaseline", () => {
  it("rejects an incomplete baseline report", () => {
    expect(() => parseSQLiteProfileBaseline({ schemaVersion: 1 })).toThrow(
      "schemaVersion must be 2",
    );
  });

  it("rejects duplicate workload aggregates", () => {
    const duplicateAggregates = aggregates(100);
    duplicateAggregates[4] = { ...duplicateAggregates[0]! };
    expect(() => parseSQLiteProfileBaseline({
      schemaVersion: 2,
      runtime,
      aggregates: duplicateAggregates,
    })).toThrow("each workload exactly once");
  });
});

describe("summarizeSQLiteProfileSamples", () => {
  it("reports the median, p95, and population standard deviation", () => {
    expect(summarizeSQLiteProfileSamples([1, 2, 3, 4, 100])).toEqual({
      min: 1,
      max: 100,
      mean: 22,
      median: 3,
      p95: 100,
      standardDeviation: Math.sqrt(1522),
    });
  });
});

describe("conversation history query plans", () => {
  const protectedPlans: SQLiteQueryPlan[] = [
    [
      "tool_call_records",
      "idx_tool_call_records_message_sort_order",
      "SELECT id FROM tool_call_records WHERE message_id IN (?) ORDER BY message_id, sort_order",
    ],
    [
      "thought_segments",
      "idx_thought_segments_message_sort_order",
      "SELECT id FROM thought_segments WHERE message_id IN (?) ORDER BY message_id, sort_order",
    ],
    [
      "hook_executions",
      "idx_hook_executions_message_sort_order",
      "SELECT id FROM hook_executions WHERE message_id IN (?) ORDER BY message_id, sort_order",
    ],
    [
      "plan_question_answers",
      "idx_plan_question_answers_thread_answered_at",
      "SELECT assistant_message_id FROM plan_question_answers WHERE thread_id = ? ORDER BY answered_at",
    ],
  ].map(([table, index, sql], position) => ({
    name: `readQuery${position + 1}`,
    sql,
    rows: [{ id: 1, parent: 0, detail: `SEARCH ${table} USING INDEX ${index} (message_id=?)` }],
  }));

  it("accepts each protected history query when its ordering index removes scan and sort work", () => {
    expect(() => assertConversationHistoryQueryPlans(protectedPlans)).not.toThrow();
  });

  it("rejects temporary sorts and full scans on protected history queries", () => {
    const temporarySort = protectedPlans.map((plan, index) => index === 0
      ? { ...plan, rows: [...plan.rows, { id: 2, parent: 0, detail: "USE TEMP B-TREE FOR ORDER BY" }] }
      : plan);
    const fullScan = protectedPlans.map((plan, index) => index === 1
      ? { ...plan, rows: [{ id: 1, parent: 0, detail: "SCAN thought_segments" }] }
      : plan);

    expect(() => assertConversationHistoryQueryPlans(temporarySort)).toThrow("temporary sort");
    expect(() => assertConversationHistoryQueryPlans(fullScan)).toThrow("full scan");
  });
});

describe("runSQLiteProfile", () => {
  it("records the finite active-turn statement set and transaction limits", () => {
    expect(ACTIVE_TURN_WRITE_POLICY).toEqual({
      retainedStatements: [
        "messages.create",
        "messages.createAssistantIdempotent",
        "messages.publishAssistant",
        "tool_call_records.insert",
        "thought_segments.insert",
        "hook_executions.insert",
        "canonical_agent_threads.upsert",
        "canonical_agent_turns.upsert",
        "canonical_agent_items.upsert",
        "canonical_agent_events.insert",
        "canonical_agent_ingest_checkpoints.upsert",
      ],
      batchLimits: { maxRows: 64, maxBytes: 262_144, maxElapsedMs: 4 },
    });
  });
});

describe("checkpoint policy profile", () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("executes exact one- and five-stream chunks and projects one-hour row growth", () => {
    db = openMemoryDatabase();
    const profile = runSQLiteCheckpointPolicyProfile(db);

    expect(profile.providerModel).toMatchObject({
      deltasPerSecond: 50,
      shortRunDeltaBytes: 512,
      oneHourProjectionDeltaBytes: 1,
      maxChunkBytes: 16 * 1024,
      retainedByteCapacityHorizon: {
        maxRetainedBytes: 256 * 1024,
        acceptedDeltas: 512,
        virtualDurationMs: 10_240,
      },
    });
    expect(profile.measuredWorkloads.map((workload) => ({
      streams: workload.streams,
      policies: workload.policies.map((policy) => ({
        maxAgeMs: policy.maxAgeMs,
        durableChunkCount: policy.durableChunkCount,
        transactions: policy.transactions,
        commits: policy.commits,
        retainedRows: policy.retainedRows,
        retainedBytes: policy.retainedBytes,
      })),
    }))).toEqual([
      {
        streams: 1,
        policies: [
          { maxAgeMs: 40, durableChunkCount: 25, transactions: 25, commits: 25, retainedRows: 25, retainedBytes: 25_600 },
          { maxAgeMs: 100, durableChunkCount: 10, transactions: 10, commits: 10, retainedRows: 10, retainedBytes: 25_600 },
          { maxAgeMs: 250, durableChunkCount: 4, transactions: 4, commits: 4, retainedRows: 4, retainedBytes: 25_600 },
          { maxAgeMs: 500, durableChunkCount: 2, transactions: 2, commits: 2, retainedRows: 2, retainedBytes: 25_600 },
          { maxAgeMs: 1000, durableChunkCount: 2, transactions: 2, commits: 2, retainedRows: 2, retainedBytes: 25_600 },
        ],
      },
      {
        streams: 5,
        policies: [
          { maxAgeMs: 40, durableChunkCount: 125, transactions: 125, commits: 125, retainedRows: 125, retainedBytes: 128_000 },
          { maxAgeMs: 100, durableChunkCount: 50, transactions: 50, commits: 50, retainedRows: 50, retainedBytes: 128_000 },
          { maxAgeMs: 250, durableChunkCount: 20, transactions: 20, commits: 20, retainedRows: 20, retainedBytes: 128_000 },
          { maxAgeMs: 500, durableChunkCount: 10, transactions: 10, commits: 10, retainedRows: 10, retainedBytes: 128_000 },
          { maxAgeMs: 1000, durableChunkCount: 10, transactions: 10, commits: 10, retainedRows: 10, retainedBytes: 128_000 },
        ],
      },
    ]);
    expect(profile.oneHourSimulation.policies.map((policy) => ({
      maxAgeMs: policy.maxAgeMs,
      durableChunkCount: policy.durableChunkCount,
      transactions: policy.transactions,
      commits: policy.commits,
      retainedRows: policy.retainedRows,
      retainedBytes: policy.retainedBytes,
    }))).toEqual([
      { maxAgeMs: 40, durableChunkCount: 90_000, transactions: 90_000, commits: 90_000, retainedRows: 90_000, retainedBytes: 180_000 },
      { maxAgeMs: 100, durableChunkCount: 36_000, transactions: 36_000, commits: 36_000, retainedRows: 36_000, retainedBytes: 180_000 },
      { maxAgeMs: 250, durableChunkCount: 13_847, transactions: 13_847, commits: 13_847, retainedRows: 13_847, retainedBytes: 180_000 },
      { maxAgeMs: 500, durableChunkCount: 7_200, transactions: 7_200, commits: 7_200, retainedRows: 7_200, retainedBytes: 180_000 },
      { maxAgeMs: 1000, durableChunkCount: 3_600, transactions: 3_600, commits: 3_600, retainedRows: 3_600, retainedBytes: 180_000 },
    ]);
    expect(profile.measuredWorkloads[0]!.policies.at(-1)).toMatchObject({
      maxAgeMs: 1000,
      deltasPerChunk: { max: 32 },
      virtualChunkWindowMs: { max: 620 },
    });
  });
});
