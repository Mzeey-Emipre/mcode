import "reflect-metadata";
import { statSync } from "node:fs";
import { cpus } from "node:os";
import { performance } from "node:perf_hooks";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { NarrativeEntry } from "@mcode/contracts";
import { HookExecutionRepo } from "../../../../features/agents/events/persistence/hook-execution-repo.js";
import { MessageRepo } from "../../../../features/agents/conversation/persistence/message-repo.js";
import { PlanQuestionAnswersRepo } from "../../../../features/agents/planning/persistence/plan-question-answers-repo.js";
import { ThoughtSegmentRepo } from "../../../../features/agents/conversation/narrative/persistence/thought-segment-repo.js";
import { ToolCallRecordRepo } from "../../../../features/agents/tools/persistence/tool-call-record-repo.js";
import { loadConversationPage } from "../../../../features/agents/conversation/read-model/conversation-page.js";
import { NarrativeStore } from "../../../../features/agents/conversation/narrative/narrative-store.js";
import { CanonicalAgentBoundary } from "../../../../features/agents/canonical/canonical-agent-boundary.js";
import {
  PARENT_ASSISTANT_TEXT_RETAINED_LIMITS,
  ParentAssistantTextCheckpointService,
} from "../../../../features/agents/turns/parent-assistant-text-checkpoint-service.js";
import { openDatabase } from "../database.js";
import { ACTIVE_TURN_WRITE_BATCH_LIMITS } from "../bounded-write-batches.js";

/** Workloads measured by the repeatable SQLite performance profile. */
export const SQLITE_PROFILE_WORKLOADS = [
  "startup-and-migrations",
  "active-turn-writes",
  "conversation-read-100",
  "conversation-read-1000",
  "cleanup",
] as const;

/** Name of one SQLite profile workload. */
export type SQLiteProfileWorkloadName = (typeof SQLITE_PROFILE_WORKLOADS)[number];

/** CLI options accepted by the SQLite performance profile. */
export interface SQLiteProfileCliOptions {
  samples: number;
  thresholdPercent: number;
  baselinePath?: string;
  outputPath?: string;
  certify: boolean;
  help: boolean;
}

/** One row returned by SQLite's query planner. */
export interface SQLiteQueryPlanRow {
  id: number;
  parent: number;
  detail: string;
}

/** SQL text and planner output for one statement used by a workload. */
export interface SQLiteQueryPlan {
  name: string;
  sql: string;
  rows: SQLiteQueryPlanRow[];
}

/** Process-memory observations around one synchronous workload. */
export interface SQLiteProfileMemory {
  rssBeforeBytes: number;
  rssAfterBytes: number;
  rssPeakBytes: number;
  heapUsedBeforeBytes: number;
  heapUsedAfterBytes: number;
  heapUsedPeakBytes: number;
  externalBeforeBytes: number;
  externalAfterBytes: number;
  externalPeakBytes: number;
}

/** One measured execution of a SQLite workload. */
export interface SQLiteProfileSample {
  workload: SQLiteProfileWorkloadName;
  sample: number;
  durationMs: number;
  returnedBytes: number;
  memory: SQLiteProfileMemory;
  queryPlans: SQLiteQueryPlan[];
  pragmas: Record<string, string | number>;
  activeTurnWrite?: {
    rowsChanged: number;
    batches: number;
    boundedRows: number;
    boundedBytes: number;
  };
}

/** Distribution summary for one measured value. */
export interface SQLiteProfileDistribution {
  min: number;
  max: number;
  mean: number;
  median: number;
  p95: number;
  standardDeviation: number;
}

/** Aggregated measurements for one workload. */
export interface SQLiteProfileAggregate {
  workload: SQLiteProfileWorkloadName;
  samples: number;
  durationMs: SQLiteProfileDistribution;
  returnedBytes: SQLiteProfileDistribution;
  rssPeakBytes: SQLiteProfileDistribution;
  heapUsedPeakBytes: SQLiteProfileDistribution;
  externalPeakBytes: SQLiteProfileDistribution;
}

/** Candidate-versus-baseline result for one workload metric. */
export interface SQLiteProfileMetricComparison {
  workload: SQLiteProfileWorkloadName;
  metric: "durationMs" | "returnedBytes" | "rssPeakBytes" | "heapUsedPeakBytes" | "externalPeakBytes";
  baselineMedian: number;
  candidateMedian: number;
  changePercent: number | null;
  thresholdPercent: number;
  status: "pass" | "regression";
}

/** Candidate-versus-baseline comparison included in a profile report. */
export interface SQLiteProfileComparison {
  baselinePath: string;
  thresholdPercent: number;
  regressions: SQLiteProfileMetricComparison[];
  metrics: SQLiteProfileMetricComparison[];
  warnings: string[];
}

/** Complete result emitted by the SQLite performance profile. */
export interface SQLiteProfileReport {
  schemaVersion: 2;
  createdAt: string;
  samplesPerWorkload: number;
  activeTurnWritePolicy: {
    retainedStatements: readonly string[];
    batchLimits: typeof ACTIVE_TURN_WRITE_BATCH_LIMITS;
  };
  seed: {
    messages: 1200;
    assistantNarrativeRows: 1800;
    contentBytesPerMessage: number;
  };
  checkpointPolicy: SQLiteCheckpointPolicyProfile;
  runtime: {
    platform: NodeJS.Platform;
    architecture: string;
    nodeVersion: string;
    electronVersion: string | null;
    sqliteVersion: string;
    cpu: string;
  };
  samples: SQLiteProfileSample[];
  aggregates: SQLiteProfileAggregate[];
  comparison?: SQLiteProfileComparison;
}

/** Fixed final-response text traffic; tool activity is outside this checkpoint workload. */
export interface SQLiteCheckpointProviderModel {
  deltasPerSecond: number;
  shortRunDeltaBytes: number;
  oneHourProjectionDeltaBytes: number;
  maxChunkBytes: number;
  retainedByteCapacityHorizon: {
    maxRetainedBytes: number;
    acceptedDeltas: number;
    virtualDurationMs: number;
  };
}

/** Exact retained-data and timing evidence for one checkpoint age policy. */
export interface SQLiteCheckpointPolicyMeasurement {
  maxAgeMs: number;
  durableChunkCount: number;
  transactions: number;
  commits: number;
  retainedRows: number;
  retainedBytes: number;
  deltasPerChunk: SQLiteProfileDistribution;
  virtualChunkWindowMs: SQLiteProfileDistribution;
  elapsedDurationMs: number;
  appendChunkLatencyMs: SQLiteProfileDistribution;
}

/** One SQLite-backed checkpoint policy workload with interleaved provider streams. */
export interface SQLiteCheckpointPolicyWorkload {
  streams: 1 | 5;
  virtualDurationMs: number;
  policies: SQLiteCheckpointPolicyMeasurement[];
}

/** One simulated long-duration checkpoint policy result with no wall-clock wait. */
export interface SQLiteCheckpointPolicyProjection {
  maxAgeMs: number;
  durableChunkCount: number;
  transactions: number;
  commits: number;
  retainedRows: number;
  retainedBytes: number;
  deltasPerChunk: SQLiteProfileDistribution;
  virtualChunkWindowMs: SQLiteProfileDistribution;
}

/** Checkpoint-policy evidence included in the maintained SQLite profile report. */
export interface SQLiteCheckpointPolicyProfile {
  providerModel: SQLiteCheckpointProviderModel;
  measuredWorkloads: SQLiteCheckpointPolicyWorkload[];
  oneHourSimulation: {
    streams: 1;
    virtualDurationMs: number;
    policies: SQLiteCheckpointPolicyProjection[];
  };
}

const DEFAULT_SAMPLES = 20;
const MIN_SAMPLES = 3;
const MAX_SAMPLES = 50;
const DEFAULT_THRESHOLD_PERCENT = 5;
const SEEDED_MESSAGE_COUNT = 1200 as const;
const SEEDED_ASSISTANT_COUNT = SEEDED_MESSAGE_COUNT / 2;
const SEEDED_NARRATIVE_ROWS = SEEDED_ASSISTANT_COUNT * 3 as 1800;
const FIXED_TIMESTAMP = "2026-01-01T00:00:00.000Z";
const WORKSPACE_ID = "sqlite-profile-workspace";
const THREAD_ID = "sqlite-profile-thread";
const CONTENT = "Mcode deterministic SQLite profile content. ".repeat(8);
const CHECKPOINT_PROVIDER_MODEL: SQLiteCheckpointProviderModel = {
  deltasPerSecond: 50,
  shortRunDeltaBytes: 512,
  oneHourProjectionDeltaBytes: 1,
  maxChunkBytes: 16 * 1024,
  retainedByteCapacityHorizon: {
    maxRetainedBytes: PARENT_ASSISTANT_TEXT_RETAINED_LIMITS.maxBytes,
    acceptedDeltas: PARENT_ASSISTANT_TEXT_RETAINED_LIMITS.maxBytes / 512,
    virtualDurationMs: (PARENT_ASSISTANT_TEXT_RETAINED_LIMITS.maxBytes / 512) * (1000 / 50),
  },
};
const CHECKPOINT_POLICY_MAX_AGES_MS = [40, 100, 250, 500, 1000] as const;
const CHECKPOINT_MEASURED_DURATION_MS = 1000;
const CHECKPOINT_ONE_HOUR_MS = 60 * 60 * 1000;
const CHECKPOINT_DELTA_TEXT = "x".repeat(CHECKPOINT_PROVIDER_MODEL.shortRunDeltaBytes);
const ACTIVE_TURN_RETAINED_STATEMENTS = [
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
] as const;

/** Finite statement retention and transaction bounds for active-turn persistence. */
export const ACTIVE_TURN_WRITE_POLICY = {
  retainedStatements: ACTIVE_TURN_RETAINED_STATEMENTS,
  batchLimits: ACTIVE_TURN_WRITE_BATCH_LIMITS,
} as const;

const PROTECTED_CONVERSATION_HISTORY_INDEXES = [
  ["tool_call_records", "idx_tool_call_records_message_sort_order"],
  ["thought_segments", "idx_thought_segments_message_sort_order"],
  ["hook_executions", "idx_hook_executions_message_sort_order"],
  ["plan_question_answers", "idx_plan_question_answers_thread_answered_at"],
] as const;

const distributionSchema = z.object({
  min: z.number().finite().nonnegative(),
  max: z.number().finite().nonnegative(),
  mean: z.number().finite().nonnegative(),
  median: z.number().finite().nonnegative(),
  p95: z.number().finite().nonnegative(),
  standardDeviation: z.number().finite().nonnegative(),
});

const aggregateSchema = z.object({
  workload: z.enum(SQLITE_PROFILE_WORKLOADS),
  samples: z.number().int().min(MIN_SAMPLES).max(MAX_SAMPLES),
  durationMs: distributionSchema,
  returnedBytes: distributionSchema,
  rssPeakBytes: distributionSchema,
  heapUsedPeakBytes: distributionSchema,
  externalPeakBytes: distributionSchema,
});

const baselineReportSchema = z.object({
  schemaVersion: z.literal(2),
  runtime: z.object({
    platform: z.string(),
    architecture: z.string(),
    nodeVersion: z.string(),
    electronVersion: z.string().nullable(),
    sqliteVersion: z.string(),
    cpu: z.string(),
  }),
  aggregates: z.array(aggregateSchema).length(SQLITE_PROFILE_WORKLOADS.length).superRefine((aggregates, context) => {
    const workloads = new Set(aggregates.map((aggregate) => aggregate.workload));
    if (workloads.size !== SQLITE_PROFILE_WORKLOADS.length) {
      context.addIssue({ code: "custom", message: "Baseline aggregates must contain each workload exactly once." });
    }
  }),
});

type BaselineReport = z.infer<typeof baselineReportSchema>;

interface MeasuredResult<T> {
  value: T;
  durationMs: number;
  returnedBytes: number;
  memory: SQLiteProfileMemory;
}

interface WorkloadDatabase {
  db: Database.Database;
  dbPath: string;
}

const QUERY_PLANS: Record<SQLiteProfileWorkloadName, Record<string, { sql: string; params: readonly unknown[] }>> = {
  "startup-and-migrations": {
    latestMigration: {
      sql: "SELECT id, hash, created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1",
      params: [],
    },
  },
  "active-turn-writes": {
    nextSequence: {
      sql: "SELECT COALESCE(MAX(sequence), 0) FROM messages WHERE thread_id = ?",
      params: [THREAD_ID],
    },
  },
  "conversation-read-100": {
  },
  "conversation-read-1000": {
  },
  cleanup: {
    threadDelete: {
      sql: "DELETE FROM threads WHERE id = ?",
      params: [THREAD_ID],
    },
  },
};

/** Parse and bound command-line options for the SQLite performance profile. */
export function parseSQLiteProfileCliOptions(args: readonly string[]): SQLiteProfileCliOptions {
  const options: SQLiteProfileCliOptions = {
    samples: DEFAULT_SAMPLES,
    thresholdPercent: DEFAULT_THRESHOLD_PERCENT,
    certify: false,
    help: false,
  };

  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--certify") {
      options.certify = true;
      continue;
    }

    const [name, inlineValue] = argument.split("=", 2);
    if (!["--samples", "--threshold-percent", "--baseline", "--output"].includes(name)) {
      throw new Error(`Unknown option: ${argument}`);
    }
    const value = inlineValue ?? args[++index];
    if (!value) {
      throw new Error(`Missing value for ${name}.`);
    }

    switch (name) {
      case "--samples":
        options.samples = parseBoundedInteger(value, name, MIN_SAMPLES, MAX_SAMPLES);
        break;
      case "--threshold-percent":
        options.thresholdPercent = parseBoundedNumber(value, name, 0.01, 100);
        break;
      case "--baseline":
        options.baselinePath = value;
        break;
      case "--output":
        options.outputPath = value;
        break;
    }
  }

  return options;
}

/** Validate an untrusted baseline report before comparison. */
export function parseSQLiteProfileBaseline(value: unknown): BaselineReport {
  if (
    typeof value !== "object"
    || value === null
    || !("schemaVersion" in value)
    || value.schemaVersion !== 2
  ) {
    throw new Error("SQLite profile baseline schemaVersion must be 2.");
  }
  return baselineReportSchema.parse(value);
}

/** Compare aggregate medians and identify metrics above the configured threshold. */
export function compareSQLiteProfileReports(
  candidate: Pick<SQLiteProfileReport, "runtime" | "aggregates">,
  baseline: BaselineReport,
  baselinePath: string,
  thresholdPercent = DEFAULT_THRESHOLD_PERCENT,
): SQLiteProfileComparison {
  const metrics: SQLiteProfileMetricComparison[] = [];
  const metricNames = [
    "durationMs",
    "returnedBytes",
    "rssPeakBytes",
    "heapUsedPeakBytes",
    "externalPeakBytes",
  ] as const;

  for (const workload of SQLITE_PROFILE_WORKLOADS) {
    const candidateAggregate = candidate.aggregates.find((item) => item.workload === workload);
    const baselineAggregate = baseline.aggregates.find((item) => item.workload === workload);
    if (!candidateAggregate || !baselineAggregate) {
      throw new Error(`Profile report is missing the ${workload} aggregate.`);
    }

    for (const metric of metricNames) {
      const baselineMedian = baselineAggregate[metric].median;
      const candidateMedian = candidateAggregate[metric].median;
      const changePercent = baselineMedian === 0
        ? null
        : ((candidateMedian - baselineMedian) / baselineMedian) * 100;
      const isRegression = baselineMedian === 0
        ? candidateMedian > 0
        : changePercent! > thresholdPercent;
      metrics.push({
        workload,
        metric,
        baselineMedian,
        candidateMedian,
        changePercent,
        thresholdPercent,
        status: isRegression ? "regression" : "pass",
      });
    }
  }

  const warnings: string[] = [];
  for (const key of ["platform", "architecture", "nodeVersion", "electronVersion", "sqliteVersion", "cpu"] as const) {
    if (candidate.runtime[key] !== baseline.runtime[key]) {
      warnings.push(`Runtime mismatch for ${key}: baseline=${baseline.runtime[key] ?? "none"}, candidate=${candidate.runtime[key] ?? "none"}.`);
    }
  }

  return {
    baselinePath,
    thresholdPercent,
    regressions: metrics.filter((metric) => metric.status === "regression"),
    metrics,
    warnings,
  };
}

/** Run all five workloads against isolated deterministic databases. */
export async function runSQLiteProfile(
  samplesPerWorkload: number,
  createDatabase: (workload: SQLiteProfileWorkloadName, sample: number) => WorkloadDatabase,
): Promise<SQLiteProfileReport> {
  if (!Number.isInteger(samplesPerWorkload) || samplesPerWorkload < MIN_SAMPLES || samplesPerWorkload > MAX_SAMPLES) {
    throw new Error(`samplesPerWorkload must be an integer from ${MIN_SAMPLES} to ${MAX_SAMPLES}.`);
  }

  const samples: SQLiteProfileSample[] = [];
  let sqliteVersion = "unknown";

  for (let sample = 1; sample <= samplesPerWorkload; sample++) {
    for (const workload of SQLITE_PROFILE_WORKLOADS) {
      if (workload === "startup-and-migrations") {
        const before = process.memoryUsage();
        const started = performance.now();
        const workloadDatabase = createDatabase(workload, sample);
        try {
          const completed = performance.now();
          const after = process.memoryUsage();
          const startupResult = {
            migrations: (workloadDatabase.db.prepare("SELECT COUNT(*) AS count FROM __drizzle_migrations").get() as { count: number }).count,
            tables: (workloadDatabase.db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table'").get() as { count: number }).count,
            databaseBytes: statSync(workloadDatabase.dbPath).size,
          };
          sqliteVersion = readSQLiteVersion(workloadDatabase.db);
          samples.push({
            workload,
            sample,
            durationMs: completed - started,
            returnedBytes: Buffer.byteLength(JSON.stringify(startupResult), "utf8"),
            memory: memoryObservation(before, after),
            queryPlans: captureQueryPlans(workloadDatabase.db, workload),
            pragmas: capturePragmas(workloadDatabase.db),
          });
        } finally {
          workloadDatabase.db.close();
        }
        continue;
      }

      const workloadDatabase = createDatabase(workload, sample);
      try {
        sqliteVersion = readSQLiteVersion(workloadDatabase.db);
        samples.push(await runWorkload(workloadDatabase.db, workload, sample));
      } finally {
        workloadDatabase.db.close();
      }
    }
  }

  const checkpointPolicyDatabase = createDatabase("active-turn-writes", 0);
  let checkpointPolicy: SQLiteCheckpointPolicyProfile;
  try {
    sqliteVersion = readSQLiteVersion(checkpointPolicyDatabase.db);
    checkpointPolicy = runSQLiteCheckpointPolicyProfile(checkpointPolicyDatabase.db);
  } finally {
    checkpointPolicyDatabase.db.close();
  }

  return {
    schemaVersion: 2,
    createdAt: new Date().toISOString(),
    samplesPerWorkload,
    activeTurnWritePolicy: ACTIVE_TURN_WRITE_POLICY,
    checkpointPolicy,
    seed: {
      messages: SEEDED_MESSAGE_COUNT,
      assistantNarrativeRows: SEEDED_NARRATIVE_ROWS,
      contentBytesPerMessage: Buffer.byteLength(CONTENT, "utf8"),
    },
    runtime: {
      platform: process.platform,
      architecture: process.arch,
      nodeVersion: process.version,
      electronVersion: process.versions.electron ?? null,
      sqliteVersion,
      cpu: cpus()[0]?.model ?? "unknown",
    },
    samples,
    aggregates: aggregateSamples(samples),
  };
}

/** Open a file-backed profile database with the application's migrations and pragmas. */
export function openSQLiteProfileDatabase(dbPath: string): WorkloadDatabase {
  return { db: openDatabase({ dbPath }), dbPath };
}

async function runWorkload(
  db: Database.Database,
  workload: SQLiteProfileWorkloadName,
  sample: number,
): Promise<SQLiteProfileSample> {
  let measured: MeasuredResult<unknown>;
  switch (workload) {
    case "startup-and-migrations":
      throw new Error("Startup must be measured while the database opens.");
    case "active-turn-writes":
      seedWorkspaceAndThread(db);
      measured = await measureAsync(() => writeActiveTurn(db));
      break;
    case "conversation-read-100":
      seedConversation(db);
      measured = measureSync(() => readConversation(db, 100));
      break;
    case "conversation-read-1000":
      seedConversation(db);
      measured = measureSync(() => readConversation(db, 1000));
      break;
    case "cleanup":
      seedConversation(db);
      measured = measureSync(() => db.prepare("DELETE FROM threads WHERE id = ?").run(THREAD_ID));
      break;
  }

  const queryPlans = workload === "conversation-read-100"
    ? captureConversationReadQueryPlans(db, 100)
    : workload === "conversation-read-1000"
      ? captureConversationReadQueryPlans(db, 1000)
      : captureQueryPlans(db, workload);
  if (workload === "conversation-read-100" || workload === "conversation-read-1000") {
    assertConversationHistoryQueryPlans(queryPlans);
  }

  return {
    workload,
    sample,
    durationMs: measured.durationMs,
    returnedBytes: measured.returnedBytes,
    memory: measured.memory,
    queryPlans,
    pragmas: capturePragmas(db),
    ...(workload === "active-turn-writes"
      ? { activeTurnWrite: measured.value as SQLiteProfileSample["activeTurnWrite"] }
      : {}),
  };
}

function seedWorkspaceAndThread(db: Database.Database): void {
  db.prepare(
    "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(WORKSPACE_ID, "SQLite profile", "/mcode/sqlite-profile", FIXED_TIMESTAMP, FIXED_TIMESTAMP);
  db.prepare(
    "INSERT INTO threads (id, workspace_id, title, branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(THREAD_ID, WORKSPACE_ID, "SQLite profile thread", "main", FIXED_TIMESTAMP, FIXED_TIMESTAMP);
}

function seedConversation(db: Database.Database): void {
  seedWorkspaceAndThread(db);
  const insertMessage = db.prepare(
    "INSERT INTO messages (id, thread_id, role, content, timestamp, sequence) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const insertTool = db.prepare(
    "INSERT INTO tool_call_records (id, message_id, tool_name, input_summary, output_summary, status, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const insertThought = db.prepare(
    "INSERT INTO thought_segments (id, message_id, text, started_at, ended_at, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const insertHook = db.prepare(
    "INSERT INTO hook_executions (id, message_id, hook_name, tool_name, phase, payload, duration_ms, did_block, started_at, ended_at, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );

  db.transaction(() => {
    for (let sequence = 1; sequence <= SEEDED_MESSAGE_COUNT; sequence++) {
      const role = sequence % 2 === 0 ? "assistant" : "user";
      const messageId = `profile-message-${sequence.toString().padStart(4, "0")}`;
      insertMessage.run(messageId, THREAD_ID, role, CONTENT, FIXED_TIMESTAMP, sequence);
      if (role !== "assistant") continue;
      insertTool.run(`profile-tool-${sequence}`, messageId, "Read", "src/file.ts", "ok", "completed", 1);
      insertThought.run(`profile-thought-${sequence}`, messageId, "Measured thought", FIXED_TIMESTAMP, FIXED_TIMESTAMP, 0);
      insertHook.run(`profile-hook-${sequence}`, messageId, "PreToolUse", "Read", "pre", "{}", 1, 0, FIXED_TIMESTAMP, FIXED_TIMESTAMP, 2);
    }
  })();
}

interface SimulatedCheckpointChunk {
  stream: number;
  firstSequence: number;
  itemCount: number;
}

interface CheckpointSimulation {
  durableChunkCount: number;
  retainedBytes: number;
  deltasPerChunk: number[];
  virtualChunkWindowMs: number[];
}

interface PendingCheckpointChunk {
  firstSequence: number;
  itemCount: number;
  byteLength: number;
  startedAtMs: number;
}

/** Run final-response text checkpoint appends and project one-byte hourly row growth. */
export function runSQLiteCheckpointPolicyProfile(db: Database.Database): SQLiteCheckpointPolicyProfile {
  seedCheckpointProfileWorkspace(db);
  return {
    providerModel: CHECKPOINT_PROVIDER_MODEL,
    measuredWorkloads: ([1, 5] as const).map((streams) => ({
      streams,
      virtualDurationMs: CHECKPOINT_MEASURED_DURATION_MS,
      policies: CHECKPOINT_POLICY_MAX_AGES_MS.map((maxAgeMs) =>
        measureCheckpointPolicy(db, streams, CHECKPOINT_MEASURED_DURATION_MS, maxAgeMs),
      ),
    })),
    oneHourSimulation: {
      streams: 1,
      virtualDurationMs: CHECKPOINT_ONE_HOUR_MS,
      policies: CHECKPOINT_POLICY_MAX_AGES_MS.map((maxAgeMs) => {
        const simulation = simulateCheckpointPolicy(
          1,
          CHECKPOINT_ONE_HOUR_MS,
          maxAgeMs,
          CHECKPOINT_PROVIDER_MODEL.oneHourProjectionDeltaBytes,
        );
        return {
          maxAgeMs,
          durableChunkCount: simulation.durableChunkCount,
          transactions: simulation.durableChunkCount,
          commits: simulation.durableChunkCount,
          retainedRows: simulation.durableChunkCount,
          retainedBytes: simulation.retainedBytes,
          deltasPerChunk: summarizeSQLiteProfileSamples(simulation.deltasPerChunk),
          virtualChunkWindowMs: summarizeSQLiteProfileSamples(simulation.virtualChunkWindowMs),
        };
      }),
    },
  };
}

function seedCheckpointProfileWorkspace(db: Database.Database): void {
  db.prepare(
    "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(WORKSPACE_ID, "SQLite checkpoint profile", "/mcode/sqlite-checkpoint-profile", FIXED_TIMESTAMP, FIXED_TIMESTAMP);
}

function measureCheckpointPolicy(
  db: Database.Database,
  streams: 1 | 5,
  virtualDurationMs: number,
  maxAgeMs: number,
): SQLiteCheckpointPolicyMeasurement {
  const executions = Array.from({ length: streams }, (_, stream) =>
    seedCheckpointProfileExecution(db, streams, maxAgeMs, stream),
  );
  const checkpoints = new ParentAssistantTextCheckpointService(db);
  const appendChunkLatenciesMs: number[] = [];
  let transactions = 0;
  let commits = 0;
  const started = performance.now();
  const simulation = simulateCheckpointPolicy(
    streams,
    virtualDurationMs,
    maxAgeMs,
    CHECKPOINT_PROVIDER_MODEL.shortRunDeltaBytes,
    (chunk) => {
      const execution = executions[chunk.stream]!;
      const inputs = Array.from({ length: chunk.itemCount }, (_, offset) => ({
        executionId: execution.executionId,
        threadId: execution.threadId,
        turnId: execution.turnId,
        sequence: chunk.firstSequence + offset,
        text: CHECKPOINT_DELTA_TEXT,
      }));
      const appendStarted = performance.now();
      const result = checkpoints.appendChunk(inputs);
      appendChunkLatenciesMs.push(performance.now() - appendStarted);
      transactions += 1;
      if (result.outcome !== "committed") {
        throw new Error(`Checkpoint profile expected a durable commit, received ${result.outcome}.`);
      }
      commits += 1;
    },
  );
  const elapsedDurationMs = performance.now() - started;
  const retained = readCheckpointRetention(db, executions.map((execution) => execution.executionId));

  if (transactions !== simulation.durableChunkCount || commits !== simulation.durableChunkCount) {
    throw new Error("Checkpoint profile append calls did not match the simulated chunk count.");
  }
  if (retained.rows !== simulation.durableChunkCount || retained.bytes !== simulation.retainedBytes) {
    throw new Error("Checkpoint profile SQLite retention did not match the simulated chunks.");
  }

  return {
    maxAgeMs,
    durableChunkCount: simulation.durableChunkCount,
    transactions,
    commits,
    retainedRows: retained.rows,
    retainedBytes: retained.bytes,
    deltasPerChunk: summarizeSQLiteProfileSamples(simulation.deltasPerChunk),
    virtualChunkWindowMs: summarizeSQLiteProfileSamples(simulation.virtualChunkWindowMs),
    elapsedDurationMs,
    appendChunkLatencyMs: summarizeSQLiteProfileSamples(appendChunkLatenciesMs),
  };
}

function seedCheckpointProfileExecution(
  db: Database.Database,
  streams: number,
  maxAgeMs: number,
  stream: number,
): { executionId: string; threadId: string; turnId: string } {
  const identifier = `checkpoint-${streams}-${maxAgeMs}-${stream}`;
  const threadId = `sqlite-profile-${identifier}-thread`;
  const turnId = `sqlite-profile-${identifier}-turn`;
  const executionId = `00000000-0000-4000-8000-${(streams * 10_000 + maxAgeMs * 10 + stream).toString().padStart(12, "0")}`;
  db.prepare(
    "INSERT INTO threads (id, workspace_id, title, branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(threadId, WORKSPACE_ID, "SQLite checkpoint profile", "main", FIXED_TIMESTAMP, FIXED_TIMESTAMP);
  const messages = new MessageRepo(db);
  new CanonicalAgentBoundary(db, () => undefined).startParentTurn({
    thread: {
      id: threadId,
      workspaceId: WORKSPACE_ID,
      providerId: "profile",
      createdAt: FIXED_TIMESTAMP,
    },
    turnId,
    executionId,
    permissionMode: "supervised",
    providerIdentities: [],
    projectUserMessage: () => messages.create(threadId, "user", CONTENT, 1),
  });
  return { executionId, threadId, turnId };
}

function readCheckpointRetention(
  db: Database.Database,
  executionIds: readonly string[],
): { rows: number; bytes: number } {
  const statement = db.prepare(`
    SELECT COUNT(*) AS rows, COALESCE(SUM(byte_length), 0) AS bytes
    FROM parent_assistant_text_checkpoint_chunks
    WHERE execution_id = ?
  `);
  return executionIds.reduce((retained, executionId) => {
    const row = statement.get(executionId) as { rows: number; bytes: number };
    return { rows: retained.rows + row.rows, bytes: retained.bytes + row.bytes };
  }, { rows: 0, bytes: 0 });
}

function simulateCheckpointPolicy(
  streams: number,
  virtualDurationMs: number,
  maxAgeMs: number,
  deltaBytes: number,
  onChunk?: (chunk: SimulatedCheckpointChunk) => void,
): CheckpointSimulation {
  const deltasPerStream = (virtualDurationMs * CHECKPOINT_PROVIDER_MODEL.deltasPerSecond) / 1000;
  if (!Number.isInteger(deltasPerStream)) {
    throw new Error("Checkpoint profile duration must contain a whole number of provider deltas.");
  }

  const intervalMs = 1000 / CHECKPOINT_PROVIDER_MODEL.deltasPerSecond;
  const pending: Array<PendingCheckpointChunk | undefined> = Array.from({ length: streams });
  const deltasPerChunk: number[] = [];
  const virtualChunkWindowMs: number[] = [];
  let durableChunkCount = 0;
  let retainedBytes = 0;
  const commit = (stream: number, committedAtMs: number): void => {
    const chunk = pending[stream];
    if (!chunk) return;
    pending[stream] = undefined;
    durableChunkCount += 1;
    retainedBytes += chunk.byteLength;
    deltasPerChunk.push(chunk.itemCount);
    virtualChunkWindowMs.push(committedAtMs - chunk.startedAtMs);
    onChunk?.({
      stream,
      firstSequence: chunk.firstSequence,
      itemCount: chunk.itemCount,
    });
  };

  for (let deltaIndex = 0; deltaIndex < deltasPerStream; deltaIndex++) {
    const nowMs = deltaIndex * intervalMs;
    for (let stream = 0; stream < streams; stream++) {
      const chunk = pending[stream];
      if (chunk && nowMs >= chunk.startedAtMs + maxAgeMs) {
        commit(stream, chunk.startedAtMs + maxAgeMs);
      }
    }
    for (let stream = 0; stream < streams; stream++) {
      const chunk = pending[stream] ?? {
        firstSequence: deltaIndex + 1,
        itemCount: 0,
        byteLength: 0,
        startedAtMs: nowMs,
      };
      chunk.itemCount += 1;
      chunk.byteLength += deltaBytes;
      pending[stream] = chunk;
      if (chunk.byteLength >= CHECKPOINT_PROVIDER_MODEL.maxChunkBytes) {
        commit(stream, nowMs);
      }
    }
  }
  for (let stream = 0; stream < streams; stream++) commit(stream, virtualDurationMs);

  return { durableChunkCount, retainedBytes, deltasPerChunk, virtualChunkWindowMs };
}

async function writeActiveTurn(db: Database.Database): Promise<NonNullable<SQLiteProfileSample["activeTurnWrite"]>> {
  const messageRepo = new MessageRepo(db);
  const toolRepo = new ToolCallRecordRepo(db);
  const thoughtRepo = new ThoughtSegmentRepo(db);
  const hookRepo = new HookExecutionRepo(db);
  const sink = new CanonicalAgentBoundary(db, () => undefined);
  const executionId = "00000000-0000-4000-8000-000000000001";
  const turnId = "sqlite-profile-turn";
  sink.startParentTurn({
    thread: {
      id: THREAD_ID,
      workspaceId: WORKSPACE_ID,
      providerId: "profile",
      createdAt: FIXED_TIMESTAMP,
    },
    turnId,
    executionId,
    permissionMode: "supervised",
    providerIdentities: [],
    projectUserMessage: () => messageRepo.create(THREAD_ID, "user", CONTENT, 1),
  });
  const assistant = messageRepo.createAssistantIdempotent({
    id: "active-assistant",
    threadId: THREAD_ID,
    content: CONTENT,
    sequence: 2,
    isInternal: true,
  });
  const tools = Array.from({ length: 65 }, (_, index) => ({
    toolCallId: `active-tool-${index}`,
    messageId: assistant.id,
    toolName: "Read",
    inputSummary: `src/file-${index}.ts`,
    outputSummary: "ok",
    status: "completed" as const,
    startedAt: FIXED_TIMESTAMP,
    completedAt: FIXED_TIMESTAMP,
    sortOrder: index,
  }));
  const thoughts = [{
    id: "active-thought",
    messageId: assistant.id,
    text: "Measured thought",
    startedAt: FIXED_TIMESTAMP,
    endedAt: FIXED_TIMESTAMP,
    sortOrder: 65,
  }];
  const hooks = [{
    id: "active-hook",
    messageId: assistant.id,
    hookName: "PreToolUse",
    toolName: "Read",
    phase: "pre",
    payload: "{}",
    durationMs: 1,
    didBlock: false,
    startedAt: FIXED_TIMESTAMP,
    endedAt: FIXED_TIMESTAMP,
    sortOrder: 66,
  }];
  const toolBatches = await toolRepo.bulkCreateBatched(tools);
  const thoughtBatches = await thoughtRepo.bulkCreateBatched(thoughts);
  const hookBatches = await hookRepo.bulkCreateBatched(hooks);
  const narrative: NarrativeEntry[] = [
    ...toolRepo.listByMessage(assistant.id).map((record) => ({
      kind: "toolCall" as const,
      sequence: 2,
      sortOrder: record.sort_order,
      record,
    })),
    ...thoughtRepo.listByMessage(assistant.id).map((record) => ({
      kind: "narrationSegment" as const,
      sequence: 2,
      sortOrder: record.sort_order,
      record,
    })),
    ...hookRepo.listByMessage(assistant.id).map((record) => ({
      kind: "hook" as const,
      sequence: 2,
      sortOrder: record.sort_order,
      record,
    })),
  ];
  const canonicalBatches = await sink.finishParentTurnBatched({
    threadId: THREAD_ID,
    turnId,
    executionId,
    providerId: "profile",
    providerIdentities: [],
    outcome: "completed",
    projectTurn: () => ({ message: { ...assistant, is_internal: false }, narrative }),
    finalizeCompatibility: () => messageRepo.publishAssistant(assistant.id),
  });
  const changes = db.prepare("SELECT total_changes() AS count").get() as { count: number };
  const batchResults = [toolBatches, thoughtBatches, hookBatches, canonicalBatches.writeBatches];
  return {
    rowsChanged: changes.count,
    batches: batchResults.reduce((total, result) => total + result.batches, 0),
    boundedRows: batchResults.reduce((total, result) => total + result.rows, 0),
    boundedBytes: batchResults.reduce((total, result) => total + result.bytes, 0),
  };
}

function readConversation(db: Database.Database, limit: 100 | 1000): unknown {
  const messageRepo = new MessageRepo(db);
  return loadConversationPage(
    {
      messageRepo,
      narrativeStore: new NarrativeStore(
        messageRepo,
        new ToolCallRecordRepo(db),
        new ThoughtSegmentRepo(db),
        new HookExecutionRepo(db),
      ),
      planQuestionAnswersRepo: new PlanQuestionAnswersRepo(db),
    },
    { threadId: THREAD_ID, limit },
  );
}

function measureSync<T>(work: () => T): MeasuredResult<T> {
  const before = process.memoryUsage();
  const started = performance.now();
  const value = work();
  const durationMs = performance.now() - started;
  const after = process.memoryUsage();
  return {
    value,
    durationMs,
    returnedBytes: Buffer.byteLength(JSON.stringify(value) ?? "", "utf8"),
    memory: memoryObservation(before, after),
  };
}

async function measureAsync<T>(work: () => Promise<T>): Promise<MeasuredResult<T>> {
  const before = process.memoryUsage();
  const started = performance.now();
  const value = await work();
  const durationMs = performance.now() - started;
  const after = process.memoryUsage();
  return {
    value,
    durationMs,
    returnedBytes: Buffer.byteLength(JSON.stringify(value) ?? "", "utf8"),
    memory: memoryObservation(before, after),
  };
}

function memoryObservation(
  before: NodeJS.MemoryUsage,
  after: NodeJS.MemoryUsage,
): SQLiteProfileMemory {
  return {
    rssBeforeBytes: before.rss,
    rssAfterBytes: after.rss,
    rssPeakBytes: Math.max(before.rss, after.rss),
    heapUsedBeforeBytes: before.heapUsed,
    heapUsedAfterBytes: after.heapUsed,
    heapUsedPeakBytes: Math.max(before.heapUsed, after.heapUsed),
    externalBeforeBytes: before.external,
    externalAfterBytes: after.external,
    externalPeakBytes: Math.max(before.external, after.external),
  };
}

function readSQLiteVersion(db: Database.Database): string {
  const row = db.prepare("SELECT sqlite_version() AS version").get() as { version: string };
  return row.version;
}

function captureQueryPlans(
  db: Database.Database,
  workload: SQLiteProfileWorkloadName,
): SQLiteQueryPlan[] {
  return Object.entries(QUERY_PLANS[workload]).map(([name, query]) => {
    const rows = db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.params) as Array<{
      id: number;
      parent: number;
      detail: string;
    }>;
    return {
      name,
      sql: query.sql,
      rows: rows.map(({ id, parent, detail }) => ({ id, parent, detail })),
    };
  });
}

function captureConversationReadQueryPlans(
  db: Database.Database,
  limit: 100 | 1000,
): SQLiteQueryPlan[] {
  const captured: Array<{ sql: string; params: unknown[] }> = [];
  const originalPrepare = db.prepare.bind(db);
  const instrumentedPrepare = ((source: string) => {
    const statement = originalPrepare(source);
    if (!/^\s*(SELECT|WITH)\b/i.test(source)) return statement;

    return new Proxy(statement, {
      get(target, property, receiver) {
        if (property === "all" || property === "get") {
          return (...params: unknown[]) => {
            captured.push({ sql: source, params });
            const method = target[property] as (...args: unknown[]) => unknown;
            return method.apply(target, params);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as Database.Database["prepare"];

  (db as unknown as { prepare: Database.Database["prepare"] }).prepare = instrumentedPrepare;
  try {
    readConversation(db, limit);
  } finally {
    (db as unknown as { prepare: Database.Database["prepare"] }).prepare = originalPrepare;
  }

  return captured.map((query, index) => {
    const rows = originalPrepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.params) as Array<{
      id: number;
      parent: number;
      detail: string;
    }>;
    return {
      name: `readQuery${index + 1}`,
      sql: query.sql,
      rows: rows.map(({ id, parent, detail }) => ({ id, parent, detail })),
    };
  });
}

/** Reject conversation-history plans that lose a retained ordering index or restore scan or sort work. */
export function assertConversationHistoryQueryPlans(plans: readonly SQLiteQueryPlan[]): void {
  for (const [table, index] of PROTECTED_CONVERSATION_HISTORY_INDEXES) {
    const queryPlan = plans.find((plan) =>
      /^\s*SELECT\b/i.test(plan.sql)
      && new RegExp(`\\bFROM\\s+${table}\\b`, "i").test(plan.sql)
    );
    if (!queryPlan) {
      throw new Error(`Conversation history profile did not capture the ${table} query.`);
    }

    const details = queryPlan.rows.map((row) => row.detail);
    if (details.some((detail) => detail.includes("USE TEMP B-TREE"))) {
      throw new Error(`Conversation history query for ${table} uses a temporary sort.`);
    }
    if (details.some((detail) => new RegExp(`^SCAN ${table}\\b`, "i").test(detail))) {
      throw new Error(`Conversation history query for ${table} uses a full scan.`);
    }
    if (!details.some((detail) => detail.includes(`USING INDEX ${index}`)
      || detail.includes(`USING COVERING INDEX ${index}`))) {
      throw new Error(`Conversation history query for ${table} does not use ${index}.`);
    }
  }
}

function capturePragmas(db: Database.Database): Record<string, string | number> {
  const simple = (name: string): string | number => {
    const value = db.pragma(name, { simple: true });
    if (typeof value !== "string" && typeof value !== "number") {
      throw new Error(`PRAGMA ${name} returned an unsupported value.`);
    }
    return value;
  };
  return {
    journal_mode: simple("journal_mode"),
    synchronous: simple("synchronous"),
    foreign_keys: simple("foreign_keys"),
    busy_timeout: simple("busy_timeout"),
    cache_size: simple("cache_size"),
    mmap_size: simple("mmap_size"),
    wal_autocheckpoint: simple("wal_autocheckpoint"),
    journal_size_limit: simple("journal_size_limit"),
    page_size: simple("page_size"),
    temp_store: simple("temp_store"),
  };
}

function aggregateSamples(samples: readonly SQLiteProfileSample[]): SQLiteProfileAggregate[] {
  return SQLITE_PROFILE_WORKLOADS.map((workload) => {
    const workloadSamples = samples.filter((sample) => sample.workload === workload);
    return {
      workload,
      samples: workloadSamples.length,
      durationMs: summarizeSQLiteProfileSamples(workloadSamples.map((sample) => sample.durationMs)),
      returnedBytes: summarizeSQLiteProfileSamples(workloadSamples.map((sample) => sample.returnedBytes)),
      rssPeakBytes: summarizeSQLiteProfileSamples(workloadSamples.map((sample) => sample.memory.rssPeakBytes)),
      heapUsedPeakBytes: summarizeSQLiteProfileSamples(workloadSamples.map((sample) => sample.memory.heapUsedPeakBytes)),
      externalPeakBytes: summarizeSQLiteProfileSamples(workloadSamples.map((sample) => sample.memory.externalPeakBytes)),
    };
  });
}

/** Summarize raw profile values without discarding variance. */
export function summarizeSQLiteProfileSamples(values: readonly number[]): SQLiteProfileDistribution {
  if (values.length === 0) throw new Error("Cannot summarize an empty sample set.");
  const sorted = [...values].sort((left, right) => left - right);
  const mean = sorted.reduce((total, value) => total + value, 0) / sorted.length;
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
  const variance = sorted.reduce((total, value) => total + (value - mean) ** 2, 0) / sorted.length;
  return {
    min: sorted[0]!,
    max: sorted.at(-1)!,
    mean,
    median,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
    standardDeviation: Math.sqrt(variance),
  };
}

function parseBoundedInteger(value: string, name: string, min: number, max: number): number {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  return parseBoundedNumber(value, name, min, max);
}

function parseBoundedNumber(value: string, name: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be from ${min} to ${max}.`);
  }
  return parsed;
}
