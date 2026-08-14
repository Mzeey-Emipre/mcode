import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";

/** Terminal v1 public contract version. */
export const TERMINAL_CONTRACT_VERSION = 1 as const;
/** Maximum unsigned 64-bit integer. */
export const TERMINAL_U64_MAX = 18_446_744_073_709_551_615n;
/** Maximum UTF-8 bytes in one Terminal command or frame payload. */
export const TERMINAL_MAX_PAYLOAD_BYTES = 65_536;
/** Maximum retained Terminal checkpoint bytes. */
export const TERMINAL_MAX_CHECKPOINT_BYTES = 8_388_608;
/** Maximum active and retained Terminal sessions per application. */
export const TERMINAL_MAX_SESSIONS = 20;
/** Default active and retained Terminal session capacity. */
export const TERMINAL_DEFAULT_SESSION_LIMIT = 20;
/** Maximum Terminal columns. */
export const TERMINAL_MAX_COLS = 1_000;
/** Maximum Terminal rows. */
export const TERMINAL_MAX_ROWS = 500;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const U64_PATTERN = /^(0|[1-9][0-9]{0,19})$/;
const CUSTOM_PROFILE_PATTERN = /^custom:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const utf8Length = (value: string): number => new TextEncoder().encode(value).length;

/** Strict lower-case RFC 4122 UUID schema used by Terminal contracts. */
export const TerminalUuidSchema = lazySchema(() => z.string().regex(UUID_PATTERN));

/** Canonical decimal unsigned 64-bit integer schema for JSON boundaries. */
export const TerminalU64Schema = lazySchema(() =>
  z
    .string()
    .regex(U64_PATTERN)
    .refine(
      (value) => U64_PATTERN.test(value) && BigInt(value) <= TERMINAL_U64_MAX,
      "Value exceeds u64",
    ),
);

/** Strict UTC timestamp schema used by Terminal contracts. */
export const TerminalTimestampSchema = lazySchema(() =>
  z.string().max(30).datetime({ offset: false }),
);

/** Terminal platform identifiers. */
export const TerminalPlatformSchema = lazySchema(() =>
  z.enum(["windows", "macos", "linux"]),
);

/** Workspace or thread scope for a shell session. */
export const TerminalScopeSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("workspace"), workspaceId: TerminalUuidSchema() }).strict(),
    z
      .object({
        kind: z.literal("thread"),
        workspaceId: TerminalUuidSchema(),
        threadId: TerminalUuidSchema(),
      })
      .strict(),
  ]),
);

/** Public shell-session lifecycle states. */
export const TerminalSessionStateSchema = lazySchema(() =>
  z.enum(["starting", "running", "exiting", "exited", "failed"]),
);

/** Certified shell profile identifiers for Terminal v1. */
export const TerminalCertifiedProfileIdSchema = lazySchema(() =>
  z.enum([
    "certified:windows-powershell-5.1",
    "certified:windows-powershell-7",
    "certified:windows-cmd",
    "certified:windows-git-bash",
    "certified:windows-wsl",
    "certified:macos-zsh",
    "certified:macos-bash",
    "certified:linux-bash",
    "certified:linux-zsh",
  ]),
);

/** Server-generated custom shell profile identifier schema. */
export const TerminalCustomProfileIdSchema = lazySchema(() =>
  z.string().regex(CUSTOM_PROFILE_PATTERN),
);

/** Any selectable Terminal profile identifier, including Automatic. */
export const TerminalProfileReferenceSchema = lazySchema(() =>
  z.union([
    z.literal("automatic"),
    TerminalCertifiedProfileIdSchema(),
    TerminalCustomProfileIdSchema(),
  ]),
);

/** Valid Terminal profile display name schema. */
export const TerminalProfileNameSchema = lazySchema(() =>
  z
    .string()
    .trim()
    .min(1)
    .max(64)
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "Control characters are forbidden"),
);

/** Valid absolute path or bare executable name schema. */
export const TerminalExecutableSchema = lazySchema(() =>
  z
    .string()
    .min(1)
    .max(1_024)
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value))
    .refine(
      (value) =>
        /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(value) || !/[\\/]/.test(value),
      "Executable must be an absolute path or bare name",
    ),
);

/** Bounded Terminal profile argument vector schema. */
export const TerminalProfileArgumentsSchema = lazySchema(() =>
  z
    .array(z.string().max(1_024))
    .max(32)
    .refine((values) => values.reduce((sum, value) => sum + utf8Length(value), 0) <= 8_192, {
      message: "Profile arguments exceed 8 KiB",
    }),
);

/** Resolved immutable shell profile descriptor. */
export const TerminalResolvedProfileSchema = lazySchema(() =>
  z
    .object({
      id: z.union([TerminalCertifiedProfileIdSchema(), TerminalCustomProfileIdSchema()]),
      name: TerminalProfileNameSchema(),
      executable: TerminalExecutableSchema(),
      arguments: TerminalProfileArgumentsSchema(),
      source: z.enum(["certified", "custom"]),
      platform: TerminalPlatformSchema(),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.source === "certified" && !value.id.startsWith("certified:")) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Certified source requires certified ID" });
      }
      if (value.source === "custom" && !value.id.startsWith("custom:")) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Custom source requires custom ID" });
      }
    }),
);

/** Persistable custom shell profile descriptor. */
export const TerminalCustomProfileSchema = lazySchema(() =>
  z
    .object({
      id: TerminalCustomProfileIdSchema(),
      name: TerminalProfileNameSchema(),
      executable: TerminalExecutableSchema(),
      arguments: TerminalProfileArgumentsSchema(),
    })
    .strict(),
);

/** Public immutable launch snapshot for one shell session. */
export const TerminalLaunchSnapshotSchema = lazySchema(() =>
  z
    .object({
      requestedProfileId: TerminalProfileReferenceSchema(),
      resolvedProfile: TerminalResolvedProfileSchema(),
      scope: TerminalScopeSchema(),
      arguments: TerminalProfileArgumentsSchema(),
    })
    .strict()
    .superRefine((value, context) => {
      if (JSON.stringify(value.arguments) !== JSON.stringify(value.resolvedProfile.arguments)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Launch arguments must match the resolved profile" });
      }
    }),
);

/** Exit metadata retained with an exited or failed Terminal session. */
export const TerminalExitMetadataSchema = lazySchema(() =>
  z
    .object({
      code: z.number().int().min(-2_147_483_648).max(2_147_483_647).nullable(),
      signal: z.number().int().min(0).max(65_535).nullable(),
      reason: z.enum([
        "natural",
        "user-close",
        "host-crash",
        "containment-failure",
        "protocol-failure",
      ]),
    })
    .strict(),
);

/** Public snapshot for a live session or retained tombstone. */
export const TerminalSessionSnapshotSchema = lazySchema(() =>
  z
    .object({
      contractVersion: z.literal(TERMINAL_CONTRACT_VERSION),
      sessionId: TerminalUuidSchema(),
      scope: TerminalScopeSchema(),
      state: TerminalSessionStateSchema(),
      hostGeneration: TerminalU64Schema(),
      launch: TerminalLaunchSnapshotSchema(),
      createdAt: TerminalTimestampSchema(),
      lastCommandSeq: TerminalU64Schema(),
      lastOutputSeq: TerminalU64Schema(),
      exit: TerminalExitMetadataSchema().nullable(),
      tombstone: z.boolean(),
    })
    .strict()
    .superRefine((value, context) => {
      const retained = value.state === "exited" || value.state === "failed";
      if (retained !== value.tombstone || retained !== (value.exit !== null)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Only exited or failed sessions contain exit metadata and tombstones",
        });
      }
      if (JSON.stringify(value.scope) !== JSON.stringify(value.launch.scope)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Session scope must match the launch snapshot" });
      }
    }),
);

/** Descriptor returned before hidden attachment hydration. */
export const TerminalAttachmentDescriptorSchema = lazySchema(() =>
  z
    .object({
      contractVersion: z.literal(TERMINAL_CONTRACT_VERSION),
      sessionId: TerminalUuidSchema(),
      attachmentId: TerminalUuidSchema(),
      attachmentEpoch: TerminalU64Schema(),
      hostGeneration: TerminalU64Schema(),
      hydrationId: TerminalUuidSchema(),
      inputEnabled: z.literal(false),
      serverHighBytes: z.literal(1_048_576),
      serverLowBytes: z.literal(262_144),
      clientHighBytes: z.literal(262_144),
      clientLowBytes: z.literal(65_536),
    })
    .strict(),
);

/** Explicit description of unavailable replay bytes. */
export const TerminalGapSchema = lazySchema(() =>
  z
    .object({
      kind: z.literal("replay"),
      firstMissingSeq: TerminalU64Schema(),
      lastMissingSeq: TerminalU64Schema(),
      retainedFromSeq: TerminalU64Schema(),
      retainedThroughSeq: TerminalU64Schema(),
      reason: z.enum(["evicted", "stale-checkpoint", "generation-reset", "checkpoint-rejected"]),
    })
    .strict()
    .superRefine((value, context) => {
      if (BigInt(value.firstMissingSeq) > BigInt(value.lastMissingSeq)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Missing sequence range is reversed" });
      }
      if (BigInt(value.retainedFromSeq) > BigInt(value.retainedThroughSeq)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Retained sequence range is reversed" });
      }
    }),
);

/** Complete hidden-hydration result. */
export const TerminalHydrationDescriptorSchema = lazySchema(() =>
  z
    .object({
      hydrationId: TerminalUuidSchema(),
      mode: z.enum(["delta", "checkpoint-delta", "reset-tail-gap"]),
      requestedAfterSeq: TerminalU64Schema(),
      checkpointThroughSeq: TerminalU64Schema().nullable(),
      firstOutputSeq: TerminalU64Schema().nullable(),
      lastOutputSeq: TerminalU64Schema().nullable(),
      gap: TerminalGapSchema().nullable(),
      chunkCount: z.number().int().min(0).max(128),
      totalBytes: z.number().int().min(0).max(TERMINAL_MAX_CHECKPOINT_BYTES),
    })
    .strict()
    .superRefine((value, context) => {
      if ((value.mode === "reset-tail-gap") !== (value.gap !== null)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Only reset hydration contains a gap" });
      }
      if ((value.firstOutputSeq === null) !== (value.lastOutputSeq === null)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Output sequence range must be complete" });
      }
      if (
        value.firstOutputSeq !== null &&
        value.lastOutputSeq !== null &&
        BigInt(value.firstOutputSeq) > BigInt(value.lastOutputSeq)
      ) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Output sequence range is reversed" });
      }
    }),
);

/** Closed Terminal v1 error codes. */
export const TerminalErrorCodeSchema = lazySchema(() =>
  z.enum([
    "INVALID_SCOPE",
    "PROFILE_NOT_FOUND",
    "PROFILE_UNAVAILABLE",
    "PROFILE_IN_USE",
    "SLOT_LIMIT_REACHED",
    "HOST_STARTING",
    "HOST_UNHEALTHY",
    "STALE_HOST_GENERATION",
    "STALE_ATTACHMENT",
    "COMMAND_OUT_OF_ORDER",
    "INPUT_STALLED",
    "INPUT_DELIVERY_UNKNOWN",
    "REPLAY_GAP",
    "CHECKPOINT_REJECTED",
    "CONTAINMENT_FAILED",
    "SESSION_NOT_FOUND",
    "SESSION_NOT_RUNNING",
    "EXIT_FLUSH_FAILED",
    "PROTOCOL_MISMATCH",
    "BACKEND_RESTART_REQUIRED",
    "SETTINGS_INVALID",
    "SETTINGS_WRITE_BLOCKED",
    "WORKSPACE_NOT_FOUND",
  ]),
);

/** Retry classifications for Terminal operations. */
export const TerminalRetryClassSchema = lazySchema(() =>
  z.enum(["SAFE_RETRY", "UNKNOWN_DELIVERY", "REATTACH", "NEW_SESSION", "RESTART"]),
);

/** Bounded references that prevent deletion of a custom Terminal profile. */
const TerminalProfileInUseReferencesSchema = lazySchema(() =>
  z
    .object({
      globalDefault: z.boolean(),
      workspaceIds: z.array(TerminalUuidSchema()).max(32),
    })
    .strict(),
);

/** Typed data attached to a profile-in-use failure. */
export const TerminalProfileInUseDataSchema = lazySchema(() =>
  z.object({ references: TerminalProfileInUseReferencesSchema() }).strict(),
);

/** Typed public Terminal failure. */
export const TerminalErrorSchema = lazySchema(() =>
  z
    .object({
      code: TerminalErrorCodeSchema(),
      message: z.string().min(1).max(512),
      retry: TerminalRetryClassSchema(),
      correlationId: z.string().min(1).max(64),
      data: TerminalProfileInUseDataSchema().optional(),
    })
    .strict(),
);

/** Terminal v1 backend capability report. */
export const TerminalV1BackendCapabilitiesSchema = lazySchema(() =>
  z
    .object({
      contractVersion: z.literal(TERMINAL_CONTRACT_VERSION),
      backend: z.enum(["modern", "legacy"]),
      selectedAt: TerminalTimestampSchema(),
      publicFrameVersion: z.literal(1),
      recovery: z.object({ replay: z.literal(true), checkpoint: z.literal(true), gap: z.literal(true) }).strict(),
      host: z
        .object({
          state: z.enum(["starting", "healthy", "degraded", "unhealthy", "stopped"]),
          generation: TerminalU64Schema(),
        })
        .strict(),
      sessionLimit: z.number().int().min(1).max(TERMINAL_MAX_SESSIONS),
    })
    .strict(),
);

/** Workspace or thread Terminal scope. */
export type TerminalScope = z.infer<ReturnType<typeof TerminalScopeSchema>>;
/** Supported Terminal host platform. */
export type TerminalPlatform = z.infer<ReturnType<typeof TerminalPlatformSchema>>;
/** Public Terminal session lifecycle state. */
export type TerminalSessionState = z.infer<ReturnType<typeof TerminalSessionStateSchema>>;
/** Any Terminal profile reference. */
export type TerminalProfileReference = z.infer<ReturnType<typeof TerminalProfileReferenceSchema>>;
/** Resolved Terminal profile. */
export type TerminalResolvedProfile = z.infer<ReturnType<typeof TerminalResolvedProfileSchema>>;
/** Persisted custom Terminal profile. */
export type TerminalCustomProfile = z.infer<ReturnType<typeof TerminalCustomProfileSchema>>;
/** Public Terminal launch snapshot. */
export type TerminalLaunchSnapshot = z.infer<ReturnType<typeof TerminalLaunchSnapshotSchema>>;
/** Terminal exit metadata. */
export type TerminalExitMetadata = z.infer<ReturnType<typeof TerminalExitMetadataSchema>>;
/** Public Terminal session snapshot. */
export type TerminalSessionSnapshot = z.infer<ReturnType<typeof TerminalSessionSnapshotSchema>>;
/** Terminal attachment descriptor. */
export type TerminalAttachmentDescriptor = z.infer<ReturnType<typeof TerminalAttachmentDescriptorSchema>>;
/** Terminal replay gap. */
export type TerminalGap = z.infer<ReturnType<typeof TerminalGapSchema>>;
/** Terminal hydration descriptor. */
export type TerminalHydrationDescriptor = z.infer<ReturnType<typeof TerminalHydrationDescriptorSchema>>;
/** Terminal error code. */
export type TerminalErrorCode = z.infer<ReturnType<typeof TerminalErrorCodeSchema>>;
/** Terminal retry class. */
export type TerminalRetryClass = z.infer<ReturnType<typeof TerminalRetryClassSchema>>;
/** Typed data attached to a public Terminal failure. */
export type TerminalProfileInUseData = z.infer<ReturnType<typeof TerminalProfileInUseDataSchema>>;
/** Public Terminal error. */
export type TerminalError = z.infer<ReturnType<typeof TerminalErrorSchema>>;
/** Terminal v1 backend capability report. */
export type TerminalV1BackendCapabilities = z.infer<ReturnType<typeof TerminalV1BackendCapabilitiesSchema>>;
