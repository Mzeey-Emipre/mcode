import { z } from "zod";
import { TerminalExecutableSchema, TerminalProfileArgumentsSchema } from "./terminal.js";
import { lazySchema } from "../utils/lazySchema.js";

/** Version of the private workspace environment document. */
export const WORKSPACE_ENVIRONMENT_VERSION = "0.0.1" as const;
/** Maximum UTF-8 bytes accepted for one platform script. */
export const WORKSPACE_ENVIRONMENT_SCRIPT_MAX_BYTES = 32 * 1024;
/** Maximum UTF-8 bytes accepted for one platform command object. */
export const WORKSPACE_ENVIRONMENT_COMMAND_MAX_BYTES = 64 * 1024;
/** Maximum UTF-8 bytes accepted for the complete environment document. */
export const WORKSPACE_ENVIRONMENT_DOCUMENT_MAX_BYTES = 128 * 1024;
/** Maximum UTF-8 bytes retained from one manual Setup command. */
export const WORKSPACE_ENVIRONMENT_SETUP_OUTPUT_MAX_BYTES = 512 * 1024;

/** Stable validation reasons returned by the workspace environment boundary. */
export const WorkspaceEnvironmentValidationReasonSchema = z.enum([
  "unsupported_version",
  "empty_script",
  "script_too_large",
  "command_too_large",
  "document_too_large",
  "null_byte",
  "duplicate_action_id",
  "invalid_value",
]);
export type WorkspaceEnvironmentValidationReason = z.infer<
  typeof WorkspaceEnvironmentValidationReasonSchema
>;

/** A structured field-level workspace environment validation issue. */
export const WorkspaceEnvironmentValidationIssueSchema = z.object({
  path: z.array(z.union([z.string(), z.number()])),
  code: z.string().min(1),
  reason: WorkspaceEnvironmentValidationReasonSchema,
  message: z.string().min(1),
}).strict();
export type WorkspaceEnvironmentValidationIssue = z.infer<
  typeof WorkspaceEnvironmentValidationIssueSchema
>;

const scriptSchema = z.string().superRefine((value, ctx) => {
  if (value.includes("\0")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Scripts must not contain null bytes",
      params: { code: "NULL_BYTE", reason: "null_byte" },
    });
  }
  if (new TextEncoder().encode(value).byteLength > WORKSPACE_ENVIRONMENT_SCRIPT_MAX_BYTES) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Scripts must be at most ${WORKSPACE_ENVIRONMENT_SCRIPT_MAX_BYTES} bytes`,
      params: { code: "SCRIPT_TOO_LARGE", reason: "script_too_large" },
    });
  }
});

/** A Platform command with optional default and operating-system scripts. */
export const WorkspaceEnvironmentCommandSchema = lazySchema(() =>
  z.object({
    default: scriptSchema.optional(),
    windows: scriptSchema.optional(),
    macos: scriptSchema.optional(),
    linux: scriptSchema.optional(),
  }).strict().superRefine((command, ctx) => {
    const scripts = Object.values(command).filter((script): script is string =>
      typeof script === "string" && script.trim().length > 0,
    );
    if (scripts.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["default"],
        message: "A command must contain at least one non-empty script",
        params: { code: "EMPTY_SCRIPT", reason: "empty_script" },
      });
    }
    const bytes = new TextEncoder().encode(JSON.stringify(command)).byteLength;
    if (bytes > WORKSPACE_ENVIRONMENT_COMMAND_MAX_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Commands must be at most ${WORKSPACE_ENVIRONMENT_COMMAND_MAX_BYTES} bytes`,
        params: { code: "COMMAND_TOO_LARGE", reason: "command_too_large" },
      });
    }
  }),
);
export type WorkspaceEnvironmentCommand = z.infer<
  ReturnType<typeof WorkspaceEnvironmentCommandSchema>
>;

/** Operating systems that can select a Platform command override. */
export const WorkspaceEnvironmentPlatformSchema = z.enum(["windows", "macos", "linux"]);
export type WorkspaceEnvironmentPlatform = z.infer<typeof WorkspaceEnvironmentPlatformSchema>;

/** Public lifecycle states for one manual Setup attempt. */
export const WorkspaceEnvironmentSetupStatusSchema = z.enum([
  "running",
  "passed",
  "failed",
  "unavailable",
]);
export type WorkspaceEnvironmentSetupStatus = z.infer<
  typeof WorkspaceEnvironmentSetupStatusSchema
>;

/** Stable terminal and configuration outcomes for manual Setup attempts. */
export const WorkspaceEnvironmentSetupOutcomeSchema = z.enum([
  "success",
  "command_failure",
  "launch_failure",
  "configuration_failure",
  "timeout",
  "containment_failure",
  "unavailable",
]);
export type WorkspaceEnvironmentSetupOutcome = z.infer<
  typeof WorkspaceEnvironmentSetupOutcomeSchema
>;

const setupOutputSchema = z.string().superRefine((value, ctx) => {
  if (new TextEncoder().encode(value).byteLength > WORKSPACE_ENVIRONMENT_SETUP_OUTPUT_MAX_BYTES) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Setup output must be at most ${WORKSPACE_ENVIRONMENT_SETUP_OUTPUT_MAX_BYTES} bytes`,
    });
  }
});

/** Immutable launch details captured before a manual Setup process begins. */
export const WorkspaceEnvironmentSetupLaunchSnapshotSchema = lazySchema(() =>
  z.object({
    platform: WorkspaceEnvironmentPlatformSchema,
    script: scriptSchema.nullable(),
    checkoutPath: z.string().min(1).max(32 * 1024).nullable(),
    terminal: z.object({
      executable: TerminalExecutableSchema(),
      arguments: TerminalProfileArgumentsSchema(),
    }).strict().nullable(),
  }).strict(),
);
export type WorkspaceEnvironmentSetupLaunchSnapshot = z.infer<
  ReturnType<typeof WorkspaceEnvironmentSetupLaunchSnapshotSchema>
>;

/** Immutable public result of a manual Setup command for one Thread. */
export const WorkspaceEnvironmentSetupAttemptSchema = lazySchema(() =>
  z.object({
    id: z.string().min(1).max(256),
    threadId: z.string().min(1).max(256),
    workspaceId: z.string().min(1).max(256),
    status: WorkspaceEnvironmentSetupStatusSchema,
    outcome: WorkspaceEnvironmentSetupOutcomeSchema.nullable(),
    snapshot: WorkspaceEnvironmentSetupLaunchSnapshotSchema(),
    createdAt: z.string().datetime(),
    startedAt: z.string().datetime().nullable(),
    finishedAt: z.string().datetime().nullable(),
    exitCode: z.number().int().nullable(),
    output: setupOutputSchema,
    outputTruncated: z.boolean(),
    cleanupPending: z.boolean(),
  }).strict().superRefine((attempt, ctx) => {
    if (attempt.status === "running" && attempt.outcome !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["outcome"], message: "Running Setup attempts cannot have an outcome" });
    }
    if (attempt.status !== "running" && attempt.outcome === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["outcome"], message: "Completed Setup attempts require an outcome" });
    }
    if (attempt.status === "passed" && attempt.outcome !== "success") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["outcome"], message: "Passed Setup attempts require a success outcome" });
    }
    if (
      attempt.status === "failed" &&
      attempt.outcome !== "command_failure" &&
      attempt.outcome !== "launch_failure" &&
      attempt.outcome !== "configuration_failure" &&
      attempt.outcome !== "timeout" &&
      attempt.outcome !== "containment_failure"
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["outcome"], message: "Failed Setup attempts require a failure outcome" });
    }
    if (attempt.status === "unavailable" && attempt.outcome !== "unavailable") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["outcome"], message: "Unavailable Setup attempts require an unavailable outcome" });
    }
    if (attempt.status === "running" && (attempt.startedAt === null || attempt.finishedAt !== null || attempt.exitCode !== null || attempt.cleanupPending)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Running Setup attempts require an active lifecycle" });
    }
    if (attempt.status !== "running" && attempt.finishedAt === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["finishedAt"], message: "Completed Setup attempts require a finish time" });
    }
    if (
      (attempt.status === "passed" ||
        attempt.outcome === "command_failure" ||
        attempt.outcome === "launch_failure" ||
        attempt.outcome === "timeout" ||
        attempt.outcome === "containment_failure") &&
      attempt.startedAt === null
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["startedAt"], message: "This Setup outcome requires a start time" });
    }
    if (attempt.outcome === "success" && attempt.exitCode !== 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["exitCode"], message: "Successful Setup attempts require exit code zero" });
    }
    if (
      (attempt.outcome === "launch_failure" ||
        attempt.outcome === "configuration_failure" ||
        attempt.outcome === "timeout" ||
        attempt.outcome === "containment_failure" ||
        attempt.outcome === "unavailable") &&
      attempt.exitCode !== null
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["exitCode"], message: "This Setup outcome cannot include an exit code" });
    }
    if (attempt.cleanupPending && attempt.outcome !== "containment_failure") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["cleanupPending"], message: "Only containment failures can require cleanup" });
    }
  }),
);
export type WorkspaceEnvironmentSetupAttempt = z.infer<
  ReturnType<typeof WorkspaceEnvironmentSetupAttemptSchema>
>;

/** Request to start a manual Setup attempt for a Thread. */
export const WorkspaceEnvironmentSetupStartInputSchema = lazySchema(() =>
  z.object({ threadId: z.string().min(1).max(256) }).strict(),
);
export type WorkspaceEnvironmentSetupStartInput = z.infer<
  ReturnType<typeof WorkspaceEnvironmentSetupStartInputSchema>
>;

/** Request to read the latest manual Setup attempt for a Thread. */
export const WorkspaceEnvironmentSetupGetInputSchema = lazySchema(() =>
  z.object({ threadId: z.string().min(1).max(256) }).strict(),
);
export type WorkspaceEnvironmentSetupGetInput = z.infer<
  ReturnType<typeof WorkspaceEnvironmentSetupGetInputSchema>
>;

/** Result of reading the latest manual Setup attempt for a Thread. */
export const WorkspaceEnvironmentSetupGetResultSchema = lazySchema(() =>
  z.object({ attempt: WorkspaceEnvironmentSetupAttemptSchema().nullable() }).strict(),
);
export type WorkspaceEnvironmentSetupGetResult = z.infer<
  ReturnType<typeof WorkspaceEnvironmentSetupGetResultSchema>
>;

/** A named workspace environment action with an opaque stable identity. */
export const WorkspaceEnvironmentActionSchema = lazySchema(() =>
  z.object({
    id: z.string().min(1).max(256),
    name: z.string().trim().min(1).max(256),
    command: WorkspaceEnvironmentCommandSchema(),
  }).strict(),
);
export type WorkspaceEnvironmentAction = z.infer<
  ReturnType<typeof WorkspaceEnvironmentActionSchema>
>;

/** Private system-local workspace environment document. */
export const WorkspaceEnvironmentDocumentSchema = lazySchema(() =>
  z.object({
    version: z.string(),
    setup: WorkspaceEnvironmentCommandSchema().optional(),
    actions: z.array(WorkspaceEnvironmentActionSchema()).max(256),
  }).strict().superRefine((document, ctx) => {
    if (document.version !== WORKSPACE_ENVIRONMENT_VERSION) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["version"],
        message: `Unsupported workspace environment version: ${document.version}`,
        params: { code: "UNSUPPORTED_VERSION", reason: "unsupported_version" },
      });
    }
    const seen = new Set<string>();
    document.actions.forEach((action, index) => {
      if (seen.has(action.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["actions", index, "id"],
          message: `Action id must be unique: ${action.id}`,
          params: { code: "DUPLICATE_ACTION_ID", reason: "duplicate_action_id" },
        });
      }
      seen.add(action.id);
    });
    const bytes = new TextEncoder().encode(JSON.stringify(document)).byteLength;
    if (bytes > WORKSPACE_ENVIRONMENT_DOCUMENT_MAX_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Environment documents must be at most ${WORKSPACE_ENVIRONMENT_DOCUMENT_MAX_BYTES} bytes`,
        params: { code: "DOCUMENT_TOO_LARGE", reason: "document_too_large" },
      });
    }
  }),
);
export type WorkspaceEnvironmentDocument = z.infer<
  ReturnType<typeof WorkspaceEnvironmentDocumentSchema>
>;

/** Default document used before a workspace has a saved environment. */
export const DEFAULT_WORKSPACE_ENVIRONMENT_DOCUMENT: WorkspaceEnvironmentDocument = {
  version: WORKSPACE_ENVIRONMENT_VERSION,
  actions: [],
};

/** Result of reading a workspace environment, including its opaque revision. */
export const WorkspaceEnvironmentReadResultSchema = lazySchema(() =>
  z.object({
    document: WorkspaceEnvironmentDocumentSchema(),
    revision: z.string().nullable(),
    status: z.enum(["present", "absent"]),
  }).strict(),
);
export type WorkspaceEnvironmentReadResult = z.infer<
  ReturnType<typeof WorkspaceEnvironmentReadResultSchema>
>;

/** Request for replacing a workspace environment document. */
export const WorkspaceEnvironmentSaveInputSchema = lazySchema(() =>
  z.object({
    workspaceId: z.string().min(1).max(256),
    sourceRevision: z.string().nullable(),
    document: WorkspaceEnvironmentDocumentSchema(),
  }).strict(),
);
export type WorkspaceEnvironmentSaveInput = z.infer<
  ReturnType<typeof WorkspaceEnvironmentSaveInputSchema>
>;

/** Structured errors exposed by the workspace environment lifecycle boundary. */
export const WorkspaceEnvironmentErrorSchema = z.object({
  code: z.enum([
    "WORKSPACE_ENVIRONMENT_VALIDATION",
    "WORKSPACE_ENVIRONMENT_UNSUPPORTED_VERSION",
    "WORKSPACE_ENVIRONMENT_STALE",
    "WORKSPACE_ENVIRONMENT_NOT_FOUND",
    "WORKSPACE_ENVIRONMENT_SETUP_CAPACITY",
    "WORKSPACE_ENVIRONMENT_SETUP_UNAVAILABLE",
  ]),
  message: z.string().min(1),
  issues: z.array(WorkspaceEnvironmentValidationIssueSchema).optional(),
}).strict();

/** Convert a Zod result into the stable field-level error shape used by transport. */
export function workspaceEnvironmentValidationIssues(
  error: z.ZodError,
): WorkspaceEnvironmentValidationIssue[] {
  return error.issues.map((issue) => {
    const params = "params" in issue && issue.params && typeof issue.params === "object"
      ? issue.params as Record<string, unknown>
      : {};
    const reason = WorkspaceEnvironmentValidationReasonSchema.safeParse(params.reason).success
      ? params.reason as WorkspaceEnvironmentValidationReason
      : "invalid_value";
    const code = typeof params.code === "string"
      ? params.code
      : issue.code === "unrecognized_keys"
        ? "UNKNOWN_KEY"
        : issue.code.toUpperCase();
    return {
      path: issue.path,
      code,
      reason,
      message: issue.message,
    };
  });
}
