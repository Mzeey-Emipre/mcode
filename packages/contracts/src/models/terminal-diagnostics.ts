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
      state: z.enum([
        "starting",
        "healthy",
        "degraded",
        "unhealthy",
        "stopped",
      ]),
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
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Metric unit does not match its identifier",
        });
      }
      if (value.value > maxForMetric(value.metric)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Metric value exceeds its bound",
        });
      }
    }),
);

/** Aggregated Terminal diagnostic counter. */
export const TerminalDiagnosticCounterSchema = lazySchema(() =>
  z
    .object({
      metric: TerminalMetricIdSchema(),
      value: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
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
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Metric unit does not match its identifier",
        });
      }
      const max = maxForMetric(value.metric);
      if (value.p50 > value.p95 || value.p95 > value.p99 || value.p99 > max) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Histogram percentiles are invalid",
        });
      }
    }),
);

const uniqueMetrics = (values: ReadonlyArray<{ metric: string }>): boolean =>
  new Set(values.map((value) => value.metric)).size === values.length;

const Sha256Schema = () => z.string().regex(/^[a-f0-9]{64}$/);
const GitCommitSchema = () => z.string().regex(/^[a-f0-9]{40}$/);
const EvidenceNameSchema = () =>
  z
    .string()
    .min(1)
    .max(255)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/);

/** Attestation for one packaged Terminal runtime artifact. */
export const TerminalPackagedArtifactAttestationSchema = lazySchema(() =>
  z
    .object({
      kind: z.enum([
        "pty-host",
        "node-pty",
        "koffi",
        "conpty-runtime",
        "node-pty-runtime",
      ]),
      path: z.string().min(1).max(2_048),
      origin: z.string().min(1).max(256),
      architecture: z.enum(["x64", "arm64"]).optional(),
      modulesAbi: z
        .string()
        .regex(/^\d{1,6}$/)
        .optional(),
      bytes: z
        .number()
        .int()
        .min(1)
        .max(256 * 1024 * 1024),
      compressedBytes: z
        .number()
        .int()
        .min(1)
        .max(16 * 1024 * 1024),
      sha256: Sha256Schema(),
    })
    .strict(),
);

/** Native and PTY-host evidence captured from one unpacked target package. */
export const TerminalArtifactAttestationSchema = lazySchema(() =>
  z
    .object({
      contractVersion: z.literal(TERMINAL_CONTRACT_VERSION),
      target: z
        .object({
          platform: z.enum(["win32", "darwin", "linux"]),
          arch: z.enum(["x64", "arm64"]),
          modulesAbi: z.string().regex(/^\d{1,6}$/),
        })
        .strict(),
      dependencies: z
        .object({
          "node-pty": z.string().min(1).max(64),
          koffi: z.string().min(1).max(64),
        })
        .strict(),
      runtime: z
        .object({
          node: z.string().regex(/^\d+\.\d+\.\d+(?:[-+].+)?$/),
          electron: z.string().regex(/^\d+\.\d+\.\d+(?:[-+].+)?$/),
        })
        .strict(),
      compressedBytes: z
        .number()
        .int()
        .min(1)
        .max(16 * 1024 * 1024),
      compressedLimitBytes: z
        .number()
        .int()
        .min(1)
        .max(16 * 1024 * 1024),
      packageFileCount: z.number().int().min(1).max(8_192),
      artifacts: z
        .array(TerminalPackagedArtifactAttestationSchema())
        .min(3)
        .max(16),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.compressedBytes > value.compressedLimitBytes) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Terminal artifacts exceed the compressed package limit",
        });
      }
      const kinds = new Set(value.artifacts.map((artifact) => artifact.kind));
      for (const requiredKind of ["pty-host", "node-pty", "koffi"]) {
        if (!kinds.has(requiredKind as "pty-host" | "node-pty" | "koffi")) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Terminal attestation is missing ${requiredKind}`,
          });
        }
      }
      if (
        new Set(value.artifacts.map((artifact) => artifact.path)).size !==
        value.artifacts.length
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Terminal artifact paths must be unique",
        });
      }
    }),
);

/** One staged desktop distributable or update metadata file. */
export const TerminalReleaseArtifactSchema = lazySchema(() =>
  z
    .object({
      name: EvidenceNameSchema(),
      kind: z.enum([
        "nsis",
        "zip",
        "dmg",
        "appimage",
        "deb",
        "blockmap",
        "update-metadata",
        "sha256-manifest",
        "sha256-signature",
      ]),
      bytes: z
        .number()
        .int()
        .min(1)
        .max(4 * 1024 * 1024 * 1024),
      sha256: Sha256Schema(),
    })
    .strict(),
);

/** One platform signing or notarization check. */
export const TerminalReleaseSignatureCheckSchema = lazySchema(() =>
  z
    .object({
      kind: z.enum([
        "authenticode",
        "developer-id",
        "notarization",
        "staple",
        "gatekeeper",
        "release-key",
      ]),
      status: z.enum(["passed", "skipped"]),
      subject: EvidenceNameSchema(),
    })
    .strict(),
);

/** Target evidence emitted after one desktop artifact set is built and staged. */
export const TerminalTargetEvidenceManifestSchema = lazySchema(() =>
  z
    .object({
      contractVersion: z.literal(TERMINAL_CONTRACT_VERSION),
      kind: z.literal("terminal-target-evidence"),
      generatedAt: TerminalTimestampSchema(),
      commit: GitCommitSchema(),
      version: z.string().min(1).max(128),
      channel: z.enum(["pull-request", "nightly", "stable"]),
      expectedLegacy: z.boolean(),
      target: z
        .object({
          platform: z.enum(["windows", "macos", "linux"]),
          arch: z.enum(["x64", "arm64"]),
          runner: z.string().min(1).max(128),
          osRelease: z.string().min(1).max(256),
          cpuCount: z.number().int().min(1).max(1_024),
          memoryBytes: TerminalU64Schema(),
        })
        .strict(),
      versions: z
        .object({
          electron: z.string().min(1).max(64),
          node: z.string().min(1).max(64),
          xterm: z.string().min(1).max(64),
          ptyHostContract: z.literal("1"),
        })
        .strict(),
      signingRequired: z.boolean(),
      signatures: z.array(TerminalReleaseSignatureCheckSchema()).max(16),
      artifacts: z.array(TerminalReleaseArtifactSchema()).min(2).max(64),
      terminal: TerminalArtifactAttestationSchema(),
    })
    .strict()
    .superRefine(validateTerminalTargetEvidence),
);

type TerminalTargetEvidenceValidationInput = {
  readonly artifacts: readonly { readonly name: string; readonly kind: string }[];
  readonly signingRequired: boolean;
  readonly signatures: readonly { readonly kind: string; readonly status: string }[];
  readonly target: { readonly platform: "windows" | "macos" | "linux"; readonly arch: string };
  readonly terminal: { readonly target: { readonly platform: string; readonly arch: string } };
};

function validateTerminalTargetEvidence(value: TerminalTargetEvidenceValidationInput, context: z.RefinementCtx): void {
  validateUniqueArtifactNames(value, context);
  validateSigningChecks(value, context);
  validateRequiredArtifactKinds(value, context);
  validateRequiredSignatureKinds(value, context);
  validateAttestationTarget(value, context);
}

function validateUniqueArtifactNames(value: TerminalTargetEvidenceValidationInput, context: z.RefinementCtx): void {
  if (new Set(value.artifacts.map((artifact) => artifact.name)).size === value.artifacts.length) return;
  context.addIssue({ code: z.ZodIssueCode.custom, message: "Release artifact names must be unique" });
}

function validateSigningChecks(value: TerminalTargetEvidenceValidationInput, context: z.RefinementCtx): void {
  if (!value.signingRequired || value.signatures.every((check) => check.status === "passed")) return;
  context.addIssue({ code: z.ZodIssueCode.custom, message: "Required signing checks must pass" });
}

function validateRequiredArtifactKinds(value: TerminalTargetEvidenceValidationInput, context: z.RefinementCtx): void {
  validateRequiredKinds(
    new Set(value.artifacts.map((artifact) => artifact.kind)),
    requiredArtifactKinds(value.target.platform),
    "",
    context,
  );
}

function validateRequiredSignatureKinds(value: TerminalTargetEvidenceValidationInput, context: z.RefinementCtx): void {
  validateRequiredKinds(
    new Set(value.signatures.map((signature) => signature.kind)),
    requiredSignatureKinds(value.target.platform),
    " evidence",
    context,
  );
}

function validateRequiredKinds(kinds: ReadonlySet<string>, requiredKinds: readonly string[], suffix: string, context: z.RefinementCtx): void {
  for (const kind of requiredKinds) {
    if (!kinds.has(kind)) context.addIssue({ code: z.ZodIssueCode.custom, message: `Target evidence is missing ${kind}${suffix}` });
  }
}

function requiredArtifactKinds(platform: TerminalTargetEvidenceValidationInput["target"]["platform"]): readonly string[] {
  return { windows: ["nsis", "zip"], macos: ["dmg", "zip"], linux: ["appimage", "deb"] }[platform];
}

function requiredSignatureKinds(platform: TerminalTargetEvidenceValidationInput["target"]["platform"]): readonly string[] {
  if (platform === "windows") return ["authenticode"];
  if (platform === "linux") return ["release-key"];
  return ["developer-id", "notarization", "staple", "gatekeeper"];
}

function validateAttestationTarget(value: TerminalTargetEvidenceValidationInput, context: z.RefinementCtx): void {
  const platform = { windows: "win32", macos: "darwin", linux: "linux" }[value.target.platform];
  if (value.terminal.target.platform === platform && value.terminal.target.arch === value.target.arch) return;
  context.addIssue({ code: z.ZodIssueCode.custom, message: "Terminal attestation target must match the release target" });
}

/** Reference to one validated target evidence manifest in a release aggregate. */
export const TerminalTargetEvidenceReferenceSchema = lazySchema(() =>
  z
    .object({
      targetId: z.enum([
        "windows-x64",
        "macos-x64",
        "macos-arm64",
        "linux-x64",
      ]),
      path: z.string().min(1).max(1_024),
      sha256: Sha256Schema(),
      artifactCount: z.number().int().min(2).max(64),
    })
    .strict(),
);

/** Aggregate evidence that gates publication of one complete desktop release set. */
export const TerminalReleaseEvidenceManifestSchema = lazySchema(() =>
  z
    .object({
      contractVersion: z.literal(TERMINAL_CONTRACT_VERSION),
      kind: z.literal("terminal-release-evidence"),
      generatedAt: TerminalTimestampSchema(),
      commit: GitCommitSchema(),
      version: z.string().min(1).max(128),
      channel: z.enum(["pull-request", "nightly", "stable"]),
      expectedLegacy: z.boolean(),
      signingRequired: z.boolean(),
      nativeDependencies: z
        .object({
          "node-pty": z.string().min(1).max(64),
          koffi: z.string().min(1).max(64),
        })
        .strict(),
      targets: z.array(TerminalTargetEvidenceReferenceSchema()).min(1).max(4),
      artifacts: z.array(TerminalReleaseArtifactSchema()).max(16),
    })
    .strict()
    .superRefine((value, context) => {
      if (
        new Set(value.targets.map((target) => target.targetId)).size !==
        value.targets.length
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Aggregate target IDs must be unique",
        });
      }
      if (
        new Set(value.artifacts.map((artifact) => artifact.name)).size !==
        value.artifacts.length
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Aggregate artifact names must be unique",
        });
      }
    }),
);

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
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Counter metric IDs must be unique",
        });
      }
      if (!uniqueMetrics(value.histograms)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Histogram metric IDs must be unique",
        });
      }
    }),
);

/** Terminal metric identifier. */
export type TerminalMetricId = z.infer<
  ReturnType<typeof TerminalMetricIdSchema>
>;
/** Terminal host health snapshot. */
export type TerminalHealthSnapshot = z.infer<
  ReturnType<typeof TerminalHealthSnapshotSchema>
>;
/** Terminal diagnostic event. */
export type TerminalDiagnosticEvent = z.infer<
  ReturnType<typeof TerminalDiagnosticEventSchema>
>;
/** Terminal diagnostics bundle. */
export type TerminalDiagnosticsBundle = z.infer<
  ReturnType<typeof TerminalDiagnosticsBundleSchema>
>;
/** Target release evidence manifest. */
export type TerminalTargetEvidenceManifest = z.infer<
  ReturnType<typeof TerminalTargetEvidenceManifestSchema>
>;
/** Aggregate release evidence manifest. */
export type TerminalReleaseEvidenceManifest = z.infer<
  ReturnType<typeof TerminalReleaseEvidenceManifestSchema>
>;
