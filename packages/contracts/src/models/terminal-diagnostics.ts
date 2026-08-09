import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";
import {
  TERMINAL_CONTRACT_VERSION,
  TERMINAL_MAX_SESSIONS,
  TerminalTimestampSchema,
  TerminalU64Schema,
  TerminalUuidSchema,
} from "./terminal.js";

/** Stable content-free Terminal metric identifiers. */
export const TerminalMetricIdSchema = lazySchema(() =>
  z.enum([
    "session.create.ms",
    "input.keydownToWrite.ms",
    "output.receiptToEmulator.ms",
    "output.receiptToPaint.ms",
    "attachment.hydration.ms",
    "attachment.replay.ms",
    "session.switch.ms",
    "session.resize.ms",
    "session.exitFlush.ms",
    "process.cleanup.ms",
    "queue.pressure.bytes",
    "input.unacknowledged.bytes",
    "replay.retained.bytes",
    "host.rss.bytes",
    "host.eventLoopLag.ms",
    "replay.gap.count",
    "attachment.ackStall.count",
    "attachment.revoked.count",
    "checkpoint.rejected.count",
    "protocol.violation.count",
    "cleanup.forced.count",
    "host.restart.count",
    "exitBarrier.failed.count",
  ]),
);

type MetricId = z.infer<ReturnType<typeof TerminalMetricIdSchema>>;
const TERMINAL_MAX_HOST_RESTART_COUNT = 20;
const unitForMetric = (metric: MetricId): "ms" | "bytes" | "count" => {
  if (metric.endsWith(".ms")) return "ms";
  if (metric.endsWith(".bytes")) return "bytes";
  return "count";
};
const maxForMetric = (metric: MetricId): number => {
  if (metric === "host.rss.bytes") return Number.MAX_SAFE_INTEGER;
  if (metric === "host.restart.count") return TERMINAL_MAX_HOST_RESTART_COUNT;
  if (metric.endsWith(".ms")) return 600_000;
  if (metric.endsWith(".bytes")) return 8_388_608;
  return 2_048;
};

/** Content-free Terminal host health snapshot. */
export const TerminalHealthSnapshotSchema = lazySchema(() =>
  z
    .object({
      contractVersion: z.literal(TERMINAL_CONTRACT_VERSION),
      state: z.enum(["starting", "healthy", "degraded", "unhealthy", "stopped"]),
      hostGeneration: TerminalU64Schema(),
      activeSessions: z.number().int().min(0).max(TERMINAL_MAX_SESSIONS),
      lastHeartbeatMsAgo: z.number().int().min(0).max(60_000).nullable(),
      queueBytes: z.number().int().min(0).max(1_048_576),
      eventLoopLagMs: z.number().min(0).max(10_000),
      hostRssBytes: TerminalU64Schema(),
    })
    .strict(),
);

/** One bounded content-free Terminal diagnostic event. */
export const TerminalDiagnosticEventSchema = lazySchema(() =>
  z
    .object({
      eventId: TerminalUuidSchema(),
      at: TerminalTimestampSchema(),
      metric: TerminalMetricIdSchema(),
      unit: z.enum(["ms", "bytes", "count"]),
      value: z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER),
      outcome: z.enum(["ok", "degraded", "failed"]),
      correlationId: z.string().min(1).max(64),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.unit !== unitForMetric(value.metric)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Metric unit does not match its identifier" });
      }
      if (value.value > maxForMetric(value.metric)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Metric value exceeds its bound" });
      }
    }),
);

/** Aggregated Terminal diagnostic counter. */
export const TerminalDiagnosticCounterSchema = lazySchema(() =>
  z.object({ metric: TerminalMetricIdSchema(), value: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict(),
);

/** Aggregated Terminal diagnostic histogram. */
export const TerminalDiagnosticHistogramSchema = lazySchema(() =>
  z
    .object({
      metric: TerminalMetricIdSchema(),
      unit: z.enum(["ms", "bytes", "count"]),
      count: z.number().int().min(0).max(100_000),
      p50: z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER),
      p95: z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER),
      p99: z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.unit !== unitForMetric(value.metric)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Metric unit does not match its identifier" });
      }
      const max = maxForMetric(value.metric);
      if (value.p50 > value.p95 || value.p95 > value.p99 || value.p99 > max) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Histogram percentiles are invalid" });
      }
    }),
);

const uniqueMetrics = (values: ReadonlyArray<{ metric: string }>): boolean =>
  new Set(values.map((value) => value.metric)).size === values.length;

/** Bounded redacted Terminal diagnostics bundle. */
export const TerminalDiagnosticsBundleSchema = lazySchema(() =>
  z
    .object({
      contractVersion: z.literal(TERMINAL_CONTRACT_VERSION),
      generatedAt: TerminalTimestampSchema(),
      backend: z.enum(["modern", "legacy"]),
      health: TerminalHealthSnapshotSchema(),
      events: z.array(TerminalDiagnosticEventSchema()).max(2_048),
      counters: z.array(TerminalDiagnosticCounterSchema()).max(64),
      histograms: z.array(TerminalDiagnosticHistogramSchema()).max(64),
    })
    .strict()
    .superRefine((value, context) => {
      if (!uniqueMetrics(value.counters)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Counter metric IDs must be unique" });
      }
      if (!uniqueMetrics(value.histograms)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Histogram metric IDs must be unique" });
      }
    }),
);

/** Terminal metric identifier. */
export type TerminalMetricId = z.infer<ReturnType<typeof TerminalMetricIdSchema>>;
/** Terminal host health snapshot. */
export type TerminalHealthSnapshot = z.infer<ReturnType<typeof TerminalHealthSnapshotSchema>>;
/** Terminal diagnostic event. */
export type TerminalDiagnosticEvent = z.infer<ReturnType<typeof TerminalDiagnosticEventSchema>>;
/** Terminal diagnostics bundle. */
export type TerminalDiagnosticsBundle = z.infer<ReturnType<typeof TerminalDiagnosticsBundleSchema>>;
