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

const TerminalProductSmokeFaultSchema = z.enum([
  "startup-health-failure",
  "post-start-host-exit",
  "containment-failure",
  "missing-native-artifact",
]);
const TerminalProductSmokeHashSchema = z.record(Sha256Schema()).refine(
  (value) => Object.keys(value).length <= 512,
  "Product smoke hash inventory is oversized",
);

/** Receipt emitted by one exact staged packaged Electron product lane. */
export const TerminalProductSmokeReceiptSchema = lazySchema(() =>
  z
    .object({
      contractVersion: z.literal(TERMINAL_CONTRACT_VERSION),
      kind: z.literal("packaged-terminal-product-smoke"),
      generatedAt: TerminalTimestampSchema(),
      status: z.literal("passed"),
      fault: TerminalProductSmokeFaultSchema.nullable(),
      startupFallbackDurationMs: z.number().int().min(0).max(5_000).nullable(),
      observations: z
        .object({
          capabilities: z
            .object({
              initial: z.object({
                contractVersion: z.number().int().min(0).max(1),
                backend: z.enum(["legacy", "modern"]),
                host: z.object({ state: z.string().min(1).max(32), generation: z.string().regex(/^\d+$/) }).optional(),
                releaseTest: z.object({ hostPid: z.number().int().min(1).max(4_294_967_295) }).optional(),
              }).strict(),
              history: z.array(z.object({
                contractVersion: z.number().int().min(0).max(1),
                backend: z.enum(["legacy", "modern"]),
                host: z.object({ state: z.string().min(1).max(32), generation: z.string().regex(/^\d+$/) }).optional(),
                releaseTest: z.object({ hostPid: z.number().int().min(1).max(4_294_967_295) }).optional(),
              }).strict()).min(1).max(64),
            })
            .strict(),
          sessions: z.array(z.object({
            sessionId: z.string().min(1).max(128),
            state: z.string().min(1).max(32),
            hostGeneration: z.string().regex(/^\d+$/),
            exitReason: z.string().max(64).nullable(),
          }).strict()).max(128),
          retry: z.object({
            contractVersion: z.number().int().min(0).max(1),
            backend: z.enum(["legacy", "modern"]),
            host: z.object({ state: z.string().min(1).max(32), generation: z.string().regex(/^\d+$/) }).optional(),
            releaseTest: z.object({ hostPid: z.number().int().min(1).max(4_294_967_295) }).optional(),
          }).strict().nullable(),
          newSession: z.object({
            sessionId: z.string().min(1).max(128),
            state: z.string().min(1).max(32),
            hostGeneration: z.string().regex(/^\d+$/),
            exitReason: z.string().max(64).nullable(),
          }).strict().nullable(),
          typedErrors: z.array(z.string().min(1).max(128)).max(32),
        })
        .strict(),
      isolation: z
        .object({
          mode: z.enum(["windows-firewall", "linux-network-namespace", "macos-network-sandbox"]),
          loopbackAllowed: z.literal(true),
          group: z.string().regex(/^McodeTerminalRelease-\d+-[a-f0-9]{12}$/).optional(),
          cleanupRequired: z.boolean().optional(),
        })
        .strict(),
      renderer: z
        .object({
          cols: z.number().int().min(1).max(1_000),
          rows: z.number().int().min(1).max(1_000),
          cursor: z.object({ x: z.number().int().min(0), y: z.number().int().min(0) }).strict(),
          lines: z.array(z.object({ text: z.string().max(16_384), wrapped: z.boolean() }).strict()).max(1_024),
          normalizedLines: z.array(z.string().max(16_384)).max(1_024),
        })
        .strict(),
      workload: z
        .object({
          id: z.literal("process-cleanup"),
          synchronizationMarker: z.literal("WF:cleanup:parent"),
        })
        .strict(),
      cleanup: z
        .object({
          pids: z.array(z.number().int().min(1).max(4_294_967_295)).max(8),
          hostPids: z.array(z.number().int().min(1).max(4_294_967_295)).min(1).max(2),
          aliveAfterCleanup: z.array(z.number().int().min(1).max(4_294_967_295)).max(8),
          cleanupDurationMs: z.number().int().min(0).max(3_000),
          passed: z.literal(true),
        })
        .strict(),
      packageHashesBefore: TerminalProductSmokeHashSchema,
      packageHashesAfter: TerminalProductSmokeHashSchema,
    })
    .strict()
    .superRefine((value, context) => {
      const initial = value.observations.capabilities.initial;
      const history = value.observations.capabilities.history;
      const generations = new Set(history.map((capability) => capability.host?.generation).filter(Boolean));
      const failedSession = value.observations.sessions.some(
        (session) => session.state === "failed" || session.exitReason !== null,
      );
      const current = history.at(-1);
      if (value.fault === null && initial.backend !== "modern") {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Clean product smoke must select modern" });
      }
      if (value.fault === null && value.observations.retry !== null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Clean product smoke must not report a retry backend",
        });
      }
      const startupFault = value.fault === "startup-health-failure" || value.fault === "missing-native-artifact";
      if (startupFault && value.startupFallbackDurationMs === null) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Startup fallback timing is missing" });
      }
      if (!startupFault && value.startupFallbackDurationMs !== null) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Non-startup product smoke must not report startup timing" });
      }
      if (value.fault === null && (failedSession || generations.size !== 1)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Clean product smoke reported a fault outcome",
        });
      }
      if (value.fault !== null && value.fault !== "startup-health-failure" && value.fault !== "missing-native-artifact" && initial.backend !== "modern") {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Post-start product smoke must retain modern" });
      }
      if (
        (value.fault === "startup-health-failure" ||
          value.fault === "missing-native-artifact") &&
        (initial.backend !== "legacy" ||
          value.observations.retry?.backend !== "modern")
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Startup fault did not select legacy for the boot",
        });
      }
      if (
        (value.fault === "post-start-host-exit" ||
          value.fault === "containment-failure") &&
        (initial.backend !== "modern" ||
          value.observations.retry !== null ||
          generations.size !== 2 ||
          current?.host?.state !== "healthy" ||
          !failedSession ||
          value.observations.newSession?.state !== "running" ||
          value.observations.typedErrors.length === 0 && !value.observations.sessions.some((session) => session.exitReason !== null))
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Post-start fault did not prove bounded modern recovery",
        });
      }
      if (value.renderer.lines.length !== value.renderer.normalizedLines.length) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Renderer probe lines are not normalized" });
      }
      if (value.isolation.mode === "windows-firewall" && (!value.isolation.group || value.isolation.cleanupRequired !== true)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Windows isolation must include a cleanup receipt" });
      }
      if (value.cleanup.hostPids.some((pid) => !value.cleanup.pids.includes(pid))) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "PTY host PIDs are missing from cleanup polling" });
      }
      if (new Set(value.cleanup.pids).size !== value.cleanup.pids.length) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Cleanup PIDs must be unique" });
      }
      if (new Set(value.cleanup.hostPids).size !== value.cleanup.hostPids.length) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "PTY host PIDs must be unique" });
      }
      const observedHostPids = new Set([
        ...history
          .map((capability) => capability.releaseTest?.hostPid)
          .filter((pid): pid is number => pid !== undefined),
        ...(value.observations.retry?.releaseTest?.hostPid ? [value.observations.retry.releaseTest.hostPid] : []),
      ]);
      if (value.cleanup.hostPids.some((pid) => !observedHostPids.has(pid))) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Cleanup contains an unobserved PTY host PID" });
      }
      if ([...observedHostPids].some((pid) => !value.cleanup.hostPids.includes(pid) || !value.cleanup.pids.includes(pid))) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Observed PTY host PIDs are missing from cleanup evidence" });
      }
      if (JSON.stringify(value.packageHashesBefore) !== JSON.stringify(value.packageHashesAfter)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Packaged resources changed during product smoke" });
      }
    }),
);

/** Complete clean plus four-fault product evidence for one release target. */
export const TerminalProductSmokeEvidenceSchema = lazySchema(() =>
  z
    .object({
      clean: TerminalProductSmokeReceiptSchema(),
      faults: z.array(TerminalProductSmokeReceiptSchema()).length(4),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.clean.fault !== null) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Product smoke clean receipt is faulted" });
      }
      const expected = new Set(TerminalProductSmokeFaultSchema.options);
      const faultValues = value.faults.map((receipt) => receipt.fault);
      const faults = faultValues.filter(
        (fault): fault is NonNullable<(typeof faultValues)[number]> => fault !== null,
      );
      if (faults.length !== faultValues.length || new Set(faults).size !== 4 || faults.some((fault) => !expected.has(fault))) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Product smoke must contain each bounded fault exactly once" });
      }
    }),
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
      terminalProduct: TerminalProductSmokeEvidenceSchema(),
    })
    .strict()
    .superRefine((value, context) => {
      if (
        new Set(value.artifacts.map((artifact) => artifact.name)).size !==
        value.artifacts.length
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Release artifact names must be unique",
        });
      }
      if (
        value.signingRequired &&
        value.signatures.some((check) => check.status !== "passed")
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Required signing checks must pass",
        });
      }
      const artifactKinds = new Set(
        value.artifacts.map((artifact) => artifact.kind),
      );
      const requiredArtifactKinds = {
        windows: ["nsis", "zip"],
        macos: ["dmg", "zip"],
        linux: ["appimage", "deb"],
      }[value.target.platform];
      for (const requiredKind of requiredArtifactKinds) {
        if (
          !artifactKinds.has(
            requiredKind as "nsis" | "zip" | "dmg" | "appimage" | "deb",
          )
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Target evidence is missing ${requiredKind}`,
          });
        }
      }
      const signatureKinds = new Set(
        value.signatures.map((check) => check.kind),
      );
      const requiredSignatureKinds =
        value.target.platform === "windows"
          ? ["authenticode"]
          : value.target.platform === "linux"
            ? ["release-key"]
            : ["developer-id", "notarization", "staple", "gatekeeper"];
      for (const requiredKind of requiredSignatureKinds) {
        if (
          !signatureKinds.has(
            requiredKind as
              | "authenticode"
              | "developer-id"
              | "notarization"
              | "staple"
              | "gatekeeper"
              | "release-key",
          )
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Target evidence is missing ${requiredKind} evidence`,
          });
        }
      }
      const nativePlatform = {
        windows: "win32",
        macos: "darwin",
        linux: "linux",
      }[value.target.platform];
      if (
        value.terminal.target.platform !== nativePlatform ||
        value.terminal.target.arch !== value.target.arch
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Terminal attestation target must match the release target",
        });
      }
    }),
);

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
/** One packaged Terminal product smoke receipt. */
export type TerminalProductSmokeReceipt = z.infer<
  ReturnType<typeof TerminalProductSmokeReceiptSchema>
>;
/** Complete packaged Terminal product smoke evidence. */
export type TerminalProductSmokeEvidence = z.infer<
  ReturnType<typeof TerminalProductSmokeEvidenceSchema>
>;
/** Target release evidence manifest. */
export type TerminalTargetEvidenceManifest = z.infer<
  ReturnType<typeof TerminalTargetEvidenceManifestSchema>
>;
/** Aggregate release evidence manifest. */
export type TerminalReleaseEvidenceManifest = z.infer<
  ReturnType<typeof TerminalReleaseEvidenceManifestSchema>
>;
