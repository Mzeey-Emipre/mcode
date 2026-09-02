import { z } from "zod";
import { lazySchema } from "./utils/lazySchema.js";

/** Maximum retained output entries for one thread startup. */
export const THREAD_STARTUP_TRANSCRIPT_MAX_ENTRIES = 32;
/** Maximum characters in one retained startup output entry. */
export const THREAD_STARTUP_TRANSCRIPT_ENTRY_MAX_CHARS = 4_096;
/** Maximum characters retained across one startup transcript. */
export const THREAD_STARTUP_TRANSCRIPT_MAX_CHARS = 16_384;

/** Startup flow selected before a durable thread may exist. */
export const ThreadStartupKindSchema = z.enum([
  "direct",
  "managed-worktree",
  "pull-request-review",
]);
/** Startup flow selected before a durable thread may exist. */
export type ThreadStartupKind = z.infer<typeof ThreadStartupKindSchema>;

/** Ordered lifecycle phases shared by startup flows. */
export const ThreadStartupPhaseSchema = z.enum([
  "thread",
  "worktree",
  "setup",
  "agent",
]);
/** Ordered lifecycle phases shared by startup flows. */
export type ThreadStartupPhase = z.infer<typeof ThreadStartupPhaseSchema>;

/** Overall startup lifecycle state. */
export const ThreadStartupStateSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
/** Overall startup lifecycle state. */
export type ThreadStartupState = z.infer<typeof ThreadStartupStateSchema>;

/** State of one ordered startup phase. */
export const ThreadStartupStepStateSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "skipped",
]);
/** State of one ordered startup phase. */
export type ThreadStartupStepState = z.infer<typeof ThreadStartupStepStateSchema>;

/** Intent to stop a startup flow. It does not imply process termination. */
export const ThreadStartupCancellationSchema = z.enum(["none", "requested"]);
/** Intent to stop a startup flow. It does not imply process termination. */
export type ThreadStartupCancellation = z.infer<typeof ThreadStartupCancellationSchema>;

/** One ordered phase snapshot within a startup record. */
export const ThreadStartupStepSchema = lazySchema(() =>
  z.object({
    phase: ThreadStartupPhaseSchema,
    state: ThreadStartupStepStateSchema,
  }).strict(),
);
/** One ordered phase snapshot within a startup record. */
export type ThreadStartupStep = z.infer<ReturnType<typeof ThreadStartupStepSchema>>;

/** Bounded text retained from one startup phase. */
export const ThreadStartupTranscriptEntrySchema = lazySchema(() =>
  z.object({
    phase: ThreadStartupPhaseSchema,
    content: z.string().max(THREAD_STARTUP_TRANSCRIPT_ENTRY_MAX_CHARS),
    createdAt: z.string().datetime({ offset: true }),
  }).strict(),
);
/** Bounded text retained from one startup phase. */
export type ThreadStartupTranscriptEntry = z.infer<
  ReturnType<typeof ThreadStartupTranscriptEntrySchema>
>;

/** Structured startup failure detail. */
export const ThreadStartupErrorSchema = lazySchema(() =>
  z.object({
    code: z.string().trim().min(1).max(64),
    message: z.string().trim().min(1).max(512),
    retryable: z.boolean(),
  }).strict(),
);
/** Structured startup failure detail. */
export type ThreadStartupError = z.infer<ReturnType<typeof ThreadStartupErrorSchema>>;

const phasesByKind: Record<ThreadStartupKind, readonly ThreadStartupPhase[]> = {
  direct: ["thread", "agent"],
  "managed-worktree": ["thread", "worktree", "setup", "agent"],
  "pull-request-review": ["thread", "worktree", "agent"],
};

/** Full server-authoritative startup lifecycle snapshot. */
export interface ThreadStartup {
  startupId: string;
  workspaceId: string;
  kind: ThreadStartupKind;
  state: ThreadStartupState;
  phase: ThreadStartupPhase;
  steps: ThreadStartupStep[];
  transcript: ThreadStartupTranscriptEntry[];
  cancellation: ThreadStartupCancellation;
  revision: number;
  threadId?: string;
  error?: ThreadStartupError;
  createdAt: string;
  updatedAt: string;
}

/** Full server-authoritative startup lifecycle snapshot. */
export const ThreadStartupSchema: () => z.ZodType<ThreadStartup> = lazySchema(() =>
  z.object({
    startupId: z.string().uuid(),
    workspaceId: z.string().trim().min(1).max(128),
    kind: ThreadStartupKindSchema,
    state: ThreadStartupStateSchema,
    phase: ThreadStartupPhaseSchema,
    steps: z.array(ThreadStartupStepSchema()).min(1).max(4),
    transcript: z.array(ThreadStartupTranscriptEntrySchema())
      .max(THREAD_STARTUP_TRANSCRIPT_MAX_ENTRIES),
    cancellation: ThreadStartupCancellationSchema,
    revision: z.number().int().positive(),
    threadId: z.string().uuid().optional(),
    error: ThreadStartupErrorSchema().optional(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  }).strict().superRefine(validateThreadStartup) as z.ZodType<ThreadStartup>,
);

/** Command used by an integration to open or reuse one startup record. */
export const ThreadStartupStartInputSchema = lazySchema(() =>
  z.object({
    startupId: z.string().uuid(),
    workspaceId: z.string().trim().min(1).max(128),
    kind: ThreadStartupKindSchema,
  }).strict(),
);
/** Command used by an integration to open or reuse one startup record. */
export type ThreadStartupStartInput = z.infer<ReturnType<typeof ThreadStartupStartInputSchema>>;

/** Request for one startup snapshot. */
export const ThreadStartupGetInputSchema = lazySchema(() =>
  z.object({ startupId: z.string().uuid() }).strict(),
);
/** Request for one startup snapshot. */
export type ThreadStartupGetInput = z.infer<ReturnType<typeof ThreadStartupGetInputSchema>>;

/** Request for startup snapshots in one workspace. */
export const ThreadStartupListInputSchema = lazySchema(() =>
  z.object({ workspaceId: z.string().trim().min(1).max(128) }).strict(),
);
/** Request for startup snapshots in one workspace. */
export type ThreadStartupListInput = z.infer<ReturnType<typeof ThreadStartupListInputSchema>>;

/** Result for the bounded workspace startup list. */
export const ThreadStartupListResultSchema = lazySchema(() =>
  z.object({ records: z.array(ThreadStartupSchema()).max(100) }).strict(),
);
/** Result for the bounded workspace startup list. */
export type ThreadStartupListResult = z.infer<ReturnType<typeof ThreadStartupListResultSchema>>;

/** Request to record cancellation intent for one startup. */
export const ThreadStartupCancelInputSchema = lazySchema(() =>
  z.object({ startupId: z.string().uuid() }).strict(),
);
/** Request to record cancellation intent for one startup. */
export type ThreadStartupCancelInput = z.infer<ReturnType<typeof ThreadStartupCancelInputSchema>>;

function validateThreadStartup(value: ThreadStartup, context: z.RefinementCtx): void {
  const expectedPhases = phasesByKind[value.kind];
  validateSteps(value, expectedPhases, context);
  validateTranscript(value, context);
  validateState(value, expectedPhases, context);
  validateError(value, context);
  validateCancellation(value, context);
}

function validateSteps(
  value: ThreadStartup,
  expectedPhases: readonly ThreadStartupPhase[],
  context: z.RefinementCtx,
): void {
  if (value.steps.length !== expectedPhases.length || value.steps.some((step, index) => step.phase !== expectedPhases[index])) {
    startupIssue(context, ["steps"], "Startup steps must match the ordered phases for its kind");
  }
  if (!expectedPhases.includes(value.phase)) {
    startupIssue(context, ["phase"], "Startup phase is not valid for its kind");
  }
}

function validateTranscript(value: ThreadStartup, context: z.RefinementCtx): void {
  const transcriptSize = value.transcript.reduce(
    (total, entry) => total + entry.content.length,
    0,
  );
  if (transcriptSize > THREAD_STARTUP_TRANSCRIPT_MAX_CHARS) {
    startupIssue(context, ["transcript"], "Startup transcript exceeds its retained character limit");
  }
}

function validateState(
  value: ThreadStartup,
  expectedPhases: readonly ThreadStartupPhase[],
  context: z.RefinementCtx,
): void {
  switch (value.state) {
    case "pending":
      validatePendingState(value, expectedPhases, context);
      return;
    case "running":
      validateRunningState(value, expectedPhases, context);
      return;
    case "completed":
      validateCompletedState(value, expectedPhases, context);
      return;
    case "failed":
    case "cancelled":
    case "interrupted":
      validateTerminalState(value, expectedPhases, context);
  }
}

function validatePendingState(
  value: ThreadStartup,
  expectedPhases: readonly ThreadStartupPhase[],
  context: z.RefinementCtx,
): void {
  if (!value.steps.every((step) => step.state === "pending") || value.phase !== expectedPhases[0]) {
    startupIssue(context, [], "Pending startup must begin at its first pending phase");
  }
}

function validateRunningState(
  value: ThreadStartup,
  expectedPhases: readonly ThreadStartupPhase[],
  context: z.RefinementCtx,
): void {
  const activeIndex = value.steps.findIndex((step) => step.state === "running");
  if (activeIndex < 0 || value.steps.findIndex((step, index) => index > activeIndex && step.state === "running") >= 0) {
    startupIssue(context, [], "Running startup must have one active phase after completed phases");
    return;
  }
  if (!value.steps.slice(0, activeIndex).every((step) => isFinishedStep(step.state))) {
    startupIssue(context, [], "Running startup must have one active phase after completed phases");
  }
  if (!value.steps.slice(activeIndex + 1).every((step) => step.state === "pending")) {
    startupIssue(context, [], "Running startup must have one active phase after completed phases");
  }
  if (value.phase !== expectedPhases[activeIndex]) {
    startupIssue(context, [], "Running startup must have one active phase after completed phases");
  }
}

function validateCompletedState(
  value: ThreadStartup,
  expectedPhases: readonly ThreadStartupPhase[],
  context: z.RefinementCtx,
): void {
  if (value.phase !== expectedPhases.at(-1) || !value.steps.every((step) => isFinishedStep(step.state))) {
    startupIssue(context, [], "Completed startup must finish every phase");
  }
}

function validateTerminalState(
  value: ThreadStartup,
  expectedPhases: readonly ThreadStartupPhase[],
  context: z.RefinementCtx,
): void {
  const terminalIndex = value.steps.findIndex((step) => step.state === value.state);
  if (terminalIndex < 0) {
    startupIssue(context, [], "Terminal startup must stop at its active phase");
    return;
  }
  if (!value.steps.slice(0, terminalIndex).every((step) => isFinishedStep(step.state))) {
    startupIssue(context, [], "Terminal startup must stop at its active phase");
  }
  if (!value.steps.slice(terminalIndex + 1).every((step) => step.state === "pending")) {
    startupIssue(context, [], "Terminal startup must stop at its active phase");
  }
  if (value.phase !== expectedPhases[terminalIndex]) {
    startupIssue(context, [], "Terminal startup must stop at its active phase");
  }
}

function validateError(value: ThreadStartup, context: z.RefinementCtx): void {
  if (value.state === "failed" && !value.error) {
    startupIssue(context, ["error"], "Failed startup requires an error");
  }
  if (value.state !== "failed" && value.error) {
    startupIssue(context, ["error"], "Only failed startup may include an error");
  }
}

function validateCancellation(value: ThreadStartup, context: z.RefinementCtx): void {
  if (value.state === "cancelled" && value.cancellation !== "requested") {
    startupIssue(context, ["cancellation"], "Cancelled startup requires cancellation intent");
  }
}

function startupIssue(context: z.RefinementCtx, path: Array<string | number>, message: string): void {
  context.addIssue({ code: "custom", path, message });
}

function isFinishedStep(state: ThreadStartupStepState): boolean {
  return state === "completed" || state === "skipped";
}
