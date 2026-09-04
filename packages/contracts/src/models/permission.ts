import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";

/** The set of decisions a user can make on a permission request. */
export const PermissionDecisionSchema = z.enum([
  "allow",
  "allow-session",
  "deny",
  "cancelled",
]);
/** A user's decision on a pending tool permission request. */
export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;

/** A provider-offered selectable answer for an inline question. */
export const PermissionQuestionOptionSchema = lazySchema(() => z.object({
  /** Exact provider reply label selected by the user. */
  label: z.string().min(1).max(100).refine((label) => label.trim().length > 0),
  /** Optional explanation displayed under the selectable label. */
  description: z.string().min(1).max(500).optional(),
}).strict());
/** A provider-offered selectable answer for an inline question. */
export type PermissionQuestionOption = z.infer<ReturnType<typeof PermissionQuestionOptionSchema>>;

/** One provider-neutral question carried by an inline permission request. */
export const PermissionQuestionSchema = lazySchema(() => z.object({
  /** Short category label displayed above the question. */
  header: z.string().min(1).max(200),
  /** Question text that requires an explicit user answer. */
  question: z.string().min(1).max(1_000),
  /** Exact reply labels the provider accepts for this question. */
  options: z.array(PermissionQuestionOptionSchema()).max(10),
  /** Whether the user may select more than one listed option. */
  multiple: z.boolean(),
  /** Whether a user-entered answer is valid in addition to listed options. */
  custom: z.boolean(),
}).strict());
/** One provider-neutral question carried by an inline permission request. */
export type PermissionQuestion = z.infer<ReturnType<typeof PermissionQuestionSchema>>;

/** Ordered responses to a provider-neutral inline question request. */
export const PermissionResponseAnswersSchema = lazySchema(() => z.array(
  z.array(z.string().min(1).max(100).refine((answer) => answer.trim().length > 0)).min(1).max(10),
).min(1).max(10));
/** Ordered responses to a provider-neutral inline question request. */
export type PermissionResponseAnswers = z.infer<ReturnType<typeof PermissionResponseAnswersSchema>>;

/** A pending permission request pushed to the frontend. */
export const PermissionRequestSchema = lazySchema(() => z.object({
  requestId: z.string(),
  threadId: z.string(),
  toolName: z.string(),
  /** Raw tool input arguments; shape varies by tool. */
  input: z.unknown(),
  title: z.string().optional(),
  /** Owning Project and Thread for cross-thread approvals. */
  ownerWorkspaceId: z.string().optional(),
  ownerThreadId: z.string().optional(),
  /** Source identity recorded for a delegated mutation approval. */
  sourceThreadId: z.string().optional(),
  operation: z.enum(["thread_create_batch", "thread_send", "thread_stop"]).optional(),
  /** Questions requiring an explicit answer before this request can resolve. */
  questions: z.array(PermissionQuestionSchema()).min(1).max(10).optional(),
}));
/** A pending tool permission request awaiting user decision. */
export type PermissionRequest = z.infer<ReturnType<typeof PermissionRequestSchema>>;
