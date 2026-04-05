import { z } from "zod";

/** A single selectable option within a plan question. */
export const PlanQuestionOptionSchema = z.object({
  /** Unique ID within the parent question (e.g. "o1"). */
  id: z.string(),
  /** Short option title shown in bold. */
  title: z.string(),
  /** Longer description shown below the title. */
  description: z.string(),
  /** Whether this option is the model's recommended choice. */
  recommended: z.boolean().optional(),
});
/** A single selectable option within a plan question. */
export type PlanQuestionOption = z.infer<typeof PlanQuestionOptionSchema>;

/** A single clarifying question proposed by the model in plan mode. */
export const PlanQuestionSchema = z.object({
  /** Unique ID within the question batch (e.g. "q1"). */
  id: z.string(),
  /** Category label displayed above the question (e.g. "AUTH", "DATABASE"). */
  category: z.string(),
  /** The question text. */
  question: z.string(),
  /** Selectable options (2-5). */
  options: z.array(PlanQuestionOptionSchema).min(2).max(5),
});
/** A single clarifying question proposed by the model in plan mode. */
export type PlanQuestion = z.infer<typeof PlanQuestionSchema>;

/** A user's answer to a single plan question. */
export const PlanAnswerSchema = z.object({
  /** ID of the question being answered. */
  questionId: z.string(),
  /** ID of the selected option, or null if user typed a free-text answer. */
  selectedOptionId: z.string().nullable(),
  /** Free-text override. Takes precedence over selectedOptionId when non-null. */
  freeText: z.string().nullable(),
});
/** A user's answer to a single plan question. */
export type PlanAnswer = z.infer<typeof PlanAnswerSchema>;

/** Batch of plan questions emitted by the model. */
export const PlanQuestionBatchSchema = z.object({
  threadId: z.string(),
  questions: z.array(PlanQuestionSchema).min(1).max(15),
});
/** Batch of plan questions emitted by the model. */
export type PlanQuestionBatch = z.infer<typeof PlanQuestionBatchSchema>;
