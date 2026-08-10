import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";

/** Maximum recovery records returned or reconciled in one bounded operation. */
export const MAX_TURN_RECOVERIES = 100;

/** User-authorized action for one interrupted execution. */
export const TurnRecoveryActionSchema = z.enum(["retry", "resume"]);
/** User-authorized action for one interrupted execution. */
export type TurnRecoveryAction = z.infer<typeof TurnRecoveryActionSchema>;

/** Durable recovery state for one interrupted execution. */
export const TurnRecoverySchema = lazySchema(() =>
  z.object({
    threadId: z.string().trim().min(1).max(256),
    executionId: z.string().uuid(),
    acceptedThrough: z.number().int().nonnegative(),
    durableThrough: z.number().int().nonnegative(),
    phase: z.string().trim().min(1).max(64),
    error: z.string().max(2_000).nullable(),
    actions: z.array(TurnRecoveryActionSchema).min(1).max(2),
  }).strict().superRefine((recovery, context) => {
    if (recovery.durableThrough > recovery.acceptedThrough) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Durable progress cannot exceed accepted progress",
        path: ["durableThrough"],
      });
    }
    if (new Set(recovery.actions).size !== recovery.actions.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Recovery actions must be unique",
        path: ["actions"],
      });
    }
  }),
);
/** Durable recovery state for one interrupted execution. */
export type TurnRecovery = z.infer<ReturnType<typeof TurnRecoverySchema>>;
