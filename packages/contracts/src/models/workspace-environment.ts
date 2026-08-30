import { z } from "zod";
import { TerminalExecutableSchema, TerminalProfileArgumentsSchema } from "./terminal.js";
import { lazySchema } from "../utils/lazySchema.js";

/** Version of the private workspace environment document. */
export const WORKSPACE_ENVIRONMENT_VERSION = "0.0.1" as const;
/** Version of the canonical payload that binds an approval to a shared command. */
export const WORKSPACE_ENVIRONMENT_APPROVAL_CONTRACT_VERSION = "0.0.1" as const;
/** Maximum UTF-8 bytes accepted for one platform script. */
export const WORKSPACE_ENVIRONMENT_SCRIPT_MAX_BYTES = 32 * 1024;
/** Maximum UTF-8 bytes accepted for one platform command object. */
export const WORKSPACE_ENVIRONMENT_COMMAND_MAX_BYTES = 64 * 1024;
/** Maximum UTF-8 bytes accepted for the complete environment document. */
export const WORKSPACE_ENVIRONMENT_DOCUMENT_MAX_BYTES = 128 * 1024;
/** Maximum UTF-8 bytes retained from one manual Setup command. */
export const WORKSPACE_ENVIRONMENT_SETUP_OUTPUT_MAX_BYTES = 512 * 1024;
/** Maximum UTF-8 bytes retained from one Project Action terminal transcript. */
export const WORKSPACE_ENVIRONMENT_ACTION_TRANSCRIPT_MAX_BYTES = 512 * 1024;

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

/** The persisted location selected for one Project environment document. */
export const WorkspaceEnvironmentStorageModeSchema = z.enum(["system", "shared"]);
export type WorkspaceEnvironmentStorageMode = z.infer<typeof WorkspaceEnvironmentStorageModeSchema>;

/** Identifies either the Project Setup command or one stable Project Action command. */
export const WorkspaceEnvironmentCommandTargetSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("setup") }).strict(),
    z.object({ kind: z.literal("action"), actionId: z.string().min(1).max(256) }).strict(),
  ]),
);
export type WorkspaceEnvironmentCommandTarget = z.infer<
  ReturnType<typeof WorkspaceEnvironmentCommandTargetSchema>
>;

/** Exact shared command facts that require the user's approval before execution. */
export const WorkspaceEnvironmentCommandApprovalSchema = lazySchema(() =>
  z.object({
    target: WorkspaceEnvironmentCommandTargetSchema(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
);
export type WorkspaceEnvironmentCommandApproval = z.infer<
  ReturnType<typeof WorkspaceEnvironmentCommandApprovalSchema>
>;

/** Public lifecycle states for one manual Setup attempt. */
export const WorkspaceEnvironmentSetupStatusSchema = z.enum([
  "awaiting-approval",
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

const actionTranscriptSchema = z.string().superRefine((value, ctx) => {
  if (new TextEncoder().encode(value).byteLength > WORKSPACE_ENVIRONMENT_ACTION_TRANSCRIPT_MAX_BYTES) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Action transcripts must be at most ${WORKSPACE_ENVIRONMENT_ACTION_TRANSCRIPT_MAX_BYTES} bytes`,
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
    approval: WorkspaceEnvironmentCommandApprovalSchema().nullable().optional(),
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
  }).strict().superRefine(validateManualSetupAttempt),
);
export type WorkspaceEnvironmentSetupAttempt = z.infer<
  ReturnType<typeof WorkspaceEnvironmentSetupAttemptSchema>
>;

type ManualSetupAttemptValidationInput = {
  readonly status: WorkspaceEnvironmentSetupStatus;
  readonly outcome: WorkspaceEnvironmentSetupOutcome | null;
  readonly snapshot: { readonly approval?: unknown | null };
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly exitCode: number | null;
  readonly cleanupPending: boolean;
};

function validateManualSetupAttempt(attempt: ManualSetupAttemptValidationInput, context: z.RefinementCtx): void {
  reportValidation(activeSetupHasOutcome(attempt), context, ["outcome"], "Running Setup attempts cannot have an outcome");
  reportValidation(completedSetupLacksOutcome(attempt), context, ["outcome"], "Completed Setup attempts require an outcome");
  reportValidation(attempt.status === "passed" && attempt.outcome !== "success", context, ["outcome"], "Passed Setup attempts require a success outcome");
  reportValidation(attempt.status === "failed" && !isManualSetupFailureOutcome(attempt.outcome), context, ["outcome"], "Failed Setup attempts require a failure outcome");
  reportValidation(attempt.status === "unavailable" && attempt.outcome !== "unavailable", context, ["outcome"], "Unavailable Setup attempts require an unavailable outcome");
  reportValidation(attempt.status === "running" && hasInvalidRunningSetupLifecycle(attempt), context, [], "Running Setup attempts require an active lifecycle");
  reportValidation(attempt.status === "awaiting-approval" && hasInvalidApprovalSetupLifecycle(attempt), context, [], "Approval-waiting Setup attempts require an approved command snapshot");
  reportValidation(completedSetupLacksFinishTime(attempt), context, ["finishedAt"], "Completed Setup attempts require a finish time");
  reportValidation(manualSetupRequiresStartTime(attempt) && attempt.startedAt === null, context, ["startedAt"], "This Setup outcome requires a start time");
  reportValidation(attempt.outcome === "success" && attempt.exitCode !== 0, context, ["exitCode"], "Successful Setup attempts require exit code zero");
  reportValidation(manualSetupForbidsExitCode(attempt) && attempt.exitCode !== null, context, ["exitCode"], "This Setup outcome cannot include an exit code");
  reportValidation(attempt.cleanupPending && attempt.outcome !== "containment_failure", context, ["cleanupPending"], "Only containment failures can require cleanup");
}

function reportValidation(condition: boolean, context: z.RefinementCtx, path: (string | number)[], message: string): void {
  if (condition) context.addIssue({ code: z.ZodIssueCode.custom, path, message });
}

function isActiveSetup(status: WorkspaceEnvironmentSetupStatus): boolean {
  return ["running", "awaiting-approval"].includes(status);
}

function activeSetupHasOutcome(attempt: ManualSetupAttemptValidationInput): boolean {
  return isActiveSetup(attempt.status) && attempt.outcome !== null;
}

function completedSetupLacksOutcome(attempt: ManualSetupAttemptValidationInput): boolean {
  return !isActiveSetup(attempt.status) && attempt.outcome === null;
}

function isManualSetupFailureOutcome(outcome: WorkspaceEnvironmentSetupOutcome | null): boolean {
  return ["command_failure", "launch_failure", "configuration_failure", "timeout", "containment_failure"].includes(outcome ?? "");
}

function hasInvalidRunningSetupLifecycle(attempt: ManualSetupAttemptValidationInput): boolean {
  return attempt.startedAt === null || attempt.finishedAt !== null || attempt.exitCode !== null || attempt.cleanupPending;
}

function hasInvalidApprovalSetupLifecycle(attempt: ManualSetupAttemptValidationInput): boolean {
  return attempt.startedAt !== null || attempt.finishedAt !== null || attempt.exitCode !== null || attempt.cleanupPending || attempt.snapshot.approval == null;
}

function completedSetupLacksFinishTime(attempt: ManualSetupAttemptValidationInput): boolean {
  return !isActiveSetup(attempt.status) && attempt.finishedAt === null;
}

function manualSetupRequiresStartTime(attempt: ManualSetupAttemptValidationInput): boolean {
  return attempt.status === "passed" || ["command_failure", "launch_failure", "timeout", "containment_failure"].includes(attempt.outcome ?? "");
}

function manualSetupForbidsExitCode(attempt: ManualSetupAttemptValidationInput): boolean {
  return ["launch_failure", "configuration_failure", "timeout", "containment_failure", "unavailable"].includes(attempt.outcome ?? "");
}

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

/** Public lifecycle states for one retained Project Action run. */
export const WorkspaceEnvironmentActionRunStatusSchema = z.enum([
  "awaiting-approval",
  "running",
  "completed",
  "failed",
  "interrupted",
  "unavailable",
]);
/** Public lifecycle state for one retained Project Action run. */
export type WorkspaceEnvironmentActionRunStatus = z.infer<
  typeof WorkspaceEnvironmentActionRunStatusSchema
>;

/** Immutable launch details retained for one Project Action run. */
export const WorkspaceEnvironmentActionLaunchSnapshotSchema = lazySchema(() =>
  z.object({
    platform: WorkspaceEnvironmentPlatformSchema,
    script: scriptSchema.nullable(),
    checkoutPath: z.string().min(1).max(32 * 1024).nullable(),
    terminal: z.object({
      executable: TerminalExecutableSchema(),
      arguments: TerminalProfileArgumentsSchema(),
    }).strict().nullable(),
    environmentNames: z.array(z.string().min(1).max(256)).max(512),
    approval: WorkspaceEnvironmentCommandApprovalSchema().nullable().optional(),
  }).strict(),
);
/** Immutable public launch details retained for one Project Action run. */
export type WorkspaceEnvironmentActionLaunchSnapshot = z.infer<
  ReturnType<typeof WorkspaceEnvironmentActionLaunchSnapshotSchema>
>;

/** Latest retained result for the stable {threadId, actionId} Project Action slot. */
export const WorkspaceEnvironmentActionRunSchema = lazySchema(() =>
  z.object({
    threadId: z.string().min(1).max(256),
    workspaceId: z.string().min(1).max(256),
    actionId: z.string().min(1).max(256),
    runId: z.string().min(1).max(256),
    revision: z.number().int().nonnegative().max(2_147_483_647),
    terminalSessionId: z.string().min(1).max(256).nullable(),
    actionName: z.string().min(1).max(256),
    status: WorkspaceEnvironmentActionRunStatusSchema,
    snapshot: WorkspaceEnvironmentActionLaunchSnapshotSchema(),
    createdAt: z.string().datetime(),
    startedAt: z.string().datetime().nullable(),
    finishedAt: z.string().datetime().nullable(),
    exitCode: z.number().int().nullable(),
    transcript: actionTranscriptSchema,
    transcriptTruncated: z.boolean(),
  }).strict().superRefine(validateWorkspaceActionRun),
);
/** Latest retained result for one stable Project Action slot. */
export type WorkspaceEnvironmentActionRun = z.infer<
  ReturnType<typeof WorkspaceEnvironmentActionRunSchema>
>;

type WorkspaceActionRunValidationInput = {
  readonly status: WorkspaceEnvironmentActionRunStatus;
  readonly snapshot: { readonly approval?: unknown | null };
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly exitCode: number | null;
};

function validateWorkspaceActionRun(run: WorkspaceActionRunValidationInput, context: z.RefinementCtx): void {
  reportValidation(run.status === "running" && hasInvalidRunningActionLifecycle(run), context, [], "Running Action runs require an active lifecycle");
  reportValidation(run.status === "awaiting-approval" && hasInvalidApprovalActionLifecycle(run), context, [], "Approval-waiting Action runs require an approved command snapshot");
  reportValidation(!isActiveActionRun(run.status) && run.finishedAt === null, context, ["finishedAt"], "Completed Action runs require a finish time");
  reportValidation(run.status === "completed" && run.exitCode !== 0, context, ["exitCode"], "Completed Action runs require exit code zero");
  reportValidation(["interrupted", "unavailable"].includes(run.status) && run.exitCode !== null, context, ["exitCode"], "Interrupted and unavailable Action runs cannot include an exit code");
  reportValidation(["failed", "completed"].includes(run.status) && run.startedAt === null, context, ["startedAt"], "Exited Action runs require a start time");
}

function hasInvalidRunningActionLifecycle(run: WorkspaceActionRunValidationInput): boolean {
  return run.startedAt === null || run.finishedAt !== null || run.exitCode !== null;
}

function hasInvalidApprovalActionLifecycle(run: WorkspaceActionRunValidationInput): boolean {
  return run.startedAt !== null || run.finishedAt !== null || run.exitCode !== null || run.snapshot.approval == null;
}

function isActiveActionRun(status: WorkspaceEnvironmentActionRunStatus): boolean {
  return status === "running" || status === "awaiting-approval";
}

/** Request to list the retained Project Action results for one Thread. */
export const WorkspaceEnvironmentActionListInputSchema = lazySchema(() =>
  z.object({ threadId: z.string().min(1).max(256) }).strict(),
);
/** Request to list retained Project Action results for one Thread. */
export type WorkspaceEnvironmentActionListInput = z.infer<
  ReturnType<typeof WorkspaceEnvironmentActionListInputSchema>
>;

/** Bounded retained Project Action results for one Thread. */
export const WorkspaceEnvironmentActionListResultSchema = lazySchema(() =>
  z.object({ runs: z.array(WorkspaceEnvironmentActionRunSchema()).max(256) }).strict(),
);
/** Bounded retained Project Action results for one Thread. */
export type WorkspaceEnvironmentActionListResult = z.infer<
  ReturnType<typeof WorkspaceEnvironmentActionListResultSchema>
>;

/** Request to start, stop, or inspect the retained Action slot. */
export const WorkspaceEnvironmentActionSlotInputSchema = lazySchema(() =>
  z.object({
    threadId: z.string().min(1).max(256),
    actionId: z.string().min(1).max(256),
  }).strict(),
);
/** Request targeting one stable Project Action slot. */
export type WorkspaceEnvironmentActionSlotInput = z.infer<
  ReturnType<typeof WorkspaceEnvironmentActionSlotInputSchema>
>;

/** Result for one retained Project Action slot request. */
export const WorkspaceEnvironmentActionGetResultSchema = lazySchema(() =>
  z.object({ run: WorkspaceEnvironmentActionRunSchema().nullable() }).strict(),
);
/** Result for one retained Project Action slot request. */
export type WorkspaceEnvironmentActionGetResult = z.infer<
  ReturnType<typeof WorkspaceEnvironmentActionGetResultSchema>
>;

/** Durable gate states for Turns in a managed New worktree. */
export const WorkspaceEnvironmentSetupGateStateSchema = z.enum([
  "blocked",
  "released-by-pass",
  "released-by-continue",
  "not-required",
]);
export type WorkspaceEnvironmentSetupGateState = z.infer<typeof WorkspaceEnvironmentSetupGateStateSchema>;

/** Durable lifecycle states for an automatic Project Setup attempt. */
export const WorkspaceEnvironmentAutomaticSetupAttemptStateSchema = z.enum([
  "awaiting-approval",
  "queued",
  "running",
  "passed",
  "failed",
  "interrupted",
]);
export type WorkspaceEnvironmentAutomaticSetupAttemptState = z.infer<
  typeof WorkspaceEnvironmentAutomaticSetupAttemptStateSchema
>;

/** Durable lifecycle states for a Turn queued behind automatic Setup. */
export const WorkspaceEnvironmentQueuedTurnStateSchema = z.enum([
  "queued",
  "released",
  "dispatching",
  "dispatched",
  "cancelled",
]);
export type WorkspaceEnvironmentQueuedTurnState = z.infer<
  typeof WorkspaceEnvironmentQueuedTurnStateSchema
>;

/** Safe reasons rendered for an automatic Setup gate that remains blocked. */
export const WorkspaceEnvironmentAutomaticSetupReasonSchema = z.enum([
  "setup_configuration_invalid",
  "setup_approval_required",
  "setup_unavailable",
  "setup_failed",
  "setup_interrupted",
]);
export type WorkspaceEnvironmentAutomaticSetupReason = z.infer<
  typeof WorkspaceEnvironmentAutomaticSetupReasonSchema
>;

/** Public durable result for one automatic Setup attempt. */
export const WorkspaceEnvironmentAutomaticSetupAttemptSchema = lazySchema(() =>
  z.object({
    id: z.string().min(1).max(256),
    state: WorkspaceEnvironmentAutomaticSetupAttemptStateSchema,
    reason: WorkspaceEnvironmentAutomaticSetupReasonSchema.nullable(),
    snapshot: WorkspaceEnvironmentSetupLaunchSnapshotSchema().nullable(),
    outcome: WorkspaceEnvironmentSetupOutcomeSchema.nullable(),
    createdAt: z.string().datetime(),
    startedAt: z.string().datetime().nullable(),
    finishedAt: z.string().datetime().nullable(),
    exitCode: z.number().int().nullable(),
    output: setupOutputSchema,
    outputTruncated: z.boolean(),
  }).strict().superRefine(validateAutomaticSetupAttempt),
);
export type WorkspaceEnvironmentAutomaticSetupAttempt = z.infer<
  ReturnType<typeof WorkspaceEnvironmentAutomaticSetupAttemptSchema>
>;

type AutomaticSetupAttemptValidationInput = {
  readonly state: WorkspaceEnvironmentAutomaticSetupAttemptState;
  readonly reason: WorkspaceEnvironmentAutomaticSetupReason | null;
  readonly snapshot: { readonly approval?: unknown | null } | null;
  readonly outcome: WorkspaceEnvironmentSetupOutcome | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly exitCode: number | null;
  readonly output: string;
  readonly outputTruncated: boolean;
};

function validateAutomaticSetupAttempt(attempt: AutomaticSetupAttemptValidationInput, context: z.RefinementCtx): void {
  reportValidation(attempt.state === "queued" && hasQueuedSetupResult(attempt), context, [], "Pending automatic Setup attempts cannot have a result");
  reportValidation(attempt.state === "awaiting-approval" && hasInvalidAutomaticApprovalSetup(attempt), context, [], "Approval-waiting automatic Setup attempts require the exact shared command snapshot");
  reportValidation(attempt.state === "running" && hasInvalidAutomaticRunningSetup(attempt), context, [], "Running automatic Setup attempts require an active lifecycle");
  reportValidation(attempt.state === "passed" && hasInvalidPassedAutomaticSetup(attempt), context, [], "Passed automatic Setup attempts require start and finish times");
  reportValidation(["failed", "interrupted"].includes(attempt.state) && (attempt.finishedAt === null || attempt.reason === null), context, [], "Failed or interrupted automatic Setup attempts require a safe reason");
  reportValidation(attempt.state === "failed" && hasInvalidFailedAutomaticSetup(attempt), context, [], "Failed automatic Setup attempts require a launch snapshot and failure outcome");
  reportValidation(attempt.state === "interrupted" && hasInterruptedSetupResult(attempt), context, [], "Interrupted automatic Setup attempts cannot claim a terminal command result");
}

function hasQueuedSetupResult(attempt: AutomaticSetupAttemptValidationInput): boolean {
  return attempt.startedAt !== null || attempt.finishedAt !== null || attempt.reason !== null || attempt.snapshot !== null || attempt.outcome !== null || attempt.exitCode !== null || hasAutomaticSetupOutput(attempt);
}

function hasInvalidAutomaticApprovalSetup(attempt: AutomaticSetupAttemptValidationInput): boolean {
  return hasUnexpectedApprovalSetupState(attempt) || !hasAutomaticSetupApproval(attempt.snapshot);
}

function hasUnexpectedApprovalSetupState(attempt: AutomaticSetupAttemptValidationInput): boolean {
  return attempt.startedAt !== null || attempt.finishedAt !== null || attempt.reason !== "setup_approval_required" || attempt.outcome !== null || attempt.exitCode !== null || hasAutomaticSetupOutput(attempt);
}

function hasAutomaticSetupApproval(snapshot: AutomaticSetupAttemptValidationInput["snapshot"]): boolean {
  return snapshot?.approval != null;
}

function hasInvalidAutomaticRunningSetup(attempt: AutomaticSetupAttemptValidationInput): boolean {
  return attempt.startedAt === null || attempt.finishedAt !== null || attempt.reason !== null || attempt.snapshot === null || attempt.outcome !== null || attempt.exitCode !== null || hasAutomaticSetupOutput(attempt);
}

function hasInvalidPassedAutomaticSetup(attempt: AutomaticSetupAttemptValidationInput): boolean {
  return attempt.startedAt === null || attempt.finishedAt === null || attempt.reason !== null || attempt.snapshot === null || attempt.outcome !== "success" || attempt.exitCode !== 0;
}

function hasInvalidFailedAutomaticSetup(attempt: AutomaticSetupAttemptValidationInput): boolean {
  return attempt.snapshot === null || attempt.outcome === null || attempt.outcome === "success";
}

function hasInterruptedSetupResult(attempt: AutomaticSetupAttemptValidationInput): boolean {
  return attempt.outcome !== null || attempt.exitCode !== null || hasAutomaticSetupOutput(attempt);
}

function hasAutomaticSetupOutput(attempt: AutomaticSetupAttemptValidationInput): boolean {
  return attempt.output !== "" || attempt.outputTruncated;
}

/** Public lifecycle record for one Turn held behind automatic Setup. */
export const WorkspaceEnvironmentQueuedTurnSchema = lazySchema(() =>
  z.object({
    id: z.string().min(1).max(256),
    messageId: z.string().min(1).max(256),
    state: WorkspaceEnvironmentQueuedTurnStateSchema,
    createdAt: z.string().datetime(),
    dispatchedAt: z.string().datetime().nullable(),
  }).strict().superRefine((queuedTurn, ctx) => {
    if (queuedTurn.state === "dispatched" && queuedTurn.dispatchedAt === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Dispatched queued Turns require a dispatch time" });
    }
    if (queuedTurn.state !== "dispatched" && queuedTurn.dispatchedAt !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Only dispatched queued Turns have a dispatch time" });
    }
  }),
);
export type WorkspaceEnvironmentQueuedTurn = z.infer<
  ReturnType<typeof WorkspaceEnvironmentQueuedTurnSchema>
>;

/** Reconnect-authoritative snapshot of the automatic Setup lifecycle for one Thread. */
export const WorkspaceEnvironmentAutomaticSetupSnapshotSchema = lazySchema(() =>
  z.object({
    gate: WorkspaceEnvironmentSetupGateStateSchema,
    attempt: WorkspaceEnvironmentAutomaticSetupAttemptSchema().nullable(),
    queuedTurns: z.array(WorkspaceEnvironmentQueuedTurnSchema()),
  }).strict(),
);
export type WorkspaceEnvironmentAutomaticSetupSnapshot = z.infer<
  ReturnType<typeof WorkspaceEnvironmentAutomaticSetupSnapshotSchema>
>;

/** Request to read one automatic Setup lifecycle snapshot. */
export const WorkspaceEnvironmentAutomaticSetupGetInputSchema = lazySchema(() =>
  z.object({ threadId: z.string().min(1).max(256) }).strict(),
);
export type WorkspaceEnvironmentAutomaticSetupGetInput = z.infer<
  ReturnType<typeof WorkspaceEnvironmentAutomaticSetupGetInputSchema>
>;

/** Request to release queued Turns without rerunning Setup. */
export const WorkspaceEnvironmentAutomaticSetupContinueInputSchema = lazySchema(() =>
  z.object({ threadId: z.string().min(1).max(256) }).strict(),
);
export type WorkspaceEnvironmentAutomaticSetupContinueInput = z.infer<
  ReturnType<typeof WorkspaceEnvironmentAutomaticSetupContinueInputSchema>
>;

/** Request to cancel one Turn that is still queued behind Setup. */
export const WorkspaceEnvironmentQueuedTurnCancelInputSchema = lazySchema(() =>
  z.object({
    threadId: z.string().min(1).max(256),
    queuedTurnId: z.string().min(1).max(256),
  }).strict(),
);
export type WorkspaceEnvironmentQueuedTurnCancelInput = z.infer<
  ReturnType<typeof WorkspaceEnvironmentQueuedTurnCancelInputSchema>
>;

/** Request to stop the active automatic Setup attempt for one Thread. */
export const WorkspaceEnvironmentAutomaticSetupStopInputSchema = lazySchema(() =>
  z.object({ threadId: z.string().min(1).max(256) }).strict(),
);
export type WorkspaceEnvironmentAutomaticSetupStopInput = z.infer<
  ReturnType<typeof WorkspaceEnvironmentAutomaticSetupStopInputSchema>
>;

/** Request to create one new automatic Setup attempt from the current Project environment. */
export const WorkspaceEnvironmentAutomaticSetupRetryInputSchema = lazySchema(() =>
  z.object({ threadId: z.string().min(1).max(256) }).strict(),
);
export type WorkspaceEnvironmentAutomaticSetupRetryInput = z.infer<
  ReturnType<typeof WorkspaceEnvironmentAutomaticSetupRetryInputSchema>
>;

/** Request to open one interactive recovery Terminal for a managed Thread. */
export const WorkspaceEnvironmentAutomaticSetupTerminalInputSchema = lazySchema(() =>
  z.object({ threadId: z.string().min(1).max(256) }).strict(),
);
export type WorkspaceEnvironmentAutomaticSetupTerminalInput = z.infer<
  ReturnType<typeof WorkspaceEnvironmentAutomaticSetupTerminalInputSchema>
>;

/** Interactive recovery Terminal created for one automatic Setup gate. */
export const WorkspaceEnvironmentAutomaticSetupTerminalSchema = lazySchema(() =>
  z.object({
    ptyId: z.string().min(1).max(256),
    shell: z.string().min(1).max(1024),
  }).strict(),
);
export type WorkspaceEnvironmentAutomaticSetupTerminal = z.infer<
  ReturnType<typeof WorkspaceEnvironmentAutomaticSetupTerminalSchema>
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
    storageMode: WorkspaceEnvironmentStorageModeSchema.optional(),
  }).strict(),
);
export type WorkspaceEnvironmentReadResult = z.infer<
  ReturnType<typeof WorkspaceEnvironmentReadResultSchema>
>;

/** Request for replacing a workspace environment document. */
export const WorkspaceEnvironmentReadInputSchema = lazySchema(() =>
  z.object({
    workspaceId: z.string().min(1).max(256),
    threadId: z.string().min(1).max(256).optional(),
  }).strict(),
);
export type WorkspaceEnvironmentReadInput = z.infer<
  ReturnType<typeof WorkspaceEnvironmentReadInputSchema>
>;

/** Request for replacing a workspace environment document. */
export const WorkspaceEnvironmentSaveInputSchema = lazySchema(() =>
  z.object({
    workspaceId: z.string().min(1).max(256),
    threadId: z.string().min(1).max(256).optional(),
    sourceRevision: z.string().nullable(),
    document: WorkspaceEnvironmentDocumentSchema(),
  }).strict(),
);
export type WorkspaceEnvironmentSaveInput = z.infer<
  ReturnType<typeof WorkspaceEnvironmentSaveInputSchema>
>;

/** Request to select the exclusive persisted location for one Project environment. */
export const WorkspaceEnvironmentStorageSetInputSchema = lazySchema(() =>
  z.object({
    workspaceId: z.string().min(1).max(256),
    threadId: z.string().min(1).max(256).optional(),
    storageMode: WorkspaceEnvironmentStorageModeSchema,
  }).strict(),
);
export type WorkspaceEnvironmentStorageSetInput = z.infer<
  ReturnType<typeof WorkspaceEnvironmentStorageSetInputSchema>
>;

/** Request to approve the exact shared command that the user reviewed. */
export const WorkspaceEnvironmentCommandApproveInputSchema = lazySchema(() =>
  z.object({
    threadId: z.string().min(1).max(256),
    target: WorkspaceEnvironmentCommandTargetSchema(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
);
export type WorkspaceEnvironmentCommandApproveInput = z.infer<
  ReturnType<typeof WorkspaceEnvironmentCommandApproveInputSchema>
>;

/** Request to clear all stored shared-command approvals for one Project. */
export const WorkspaceEnvironmentCommandApprovalClearInputSchema = lazySchema(() =>
  z.object({ workspaceId: z.string().min(1).max(256) }).strict(),
);
export type WorkspaceEnvironmentCommandApprovalClearInput = z.infer<
  ReturnType<typeof WorkspaceEnvironmentCommandApprovalClearInputSchema>
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
    "WORKSPACE_ENVIRONMENT_ACTION_RUNNING",
    "WORKSPACE_ENVIRONMENT_ACTION_NOT_FOUND",
    "WORKSPACE_ENVIRONMENT_APPROVAL_STALE",
    "WORKSPACE_ENVIRONMENT_APPROVAL_NOT_REQUIRED",
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
