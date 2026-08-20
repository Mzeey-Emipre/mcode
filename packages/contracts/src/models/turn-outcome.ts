import { z } from "zod";

/** Durable terminal outcome for one provider turn. */
export const TurnOutcomeSchema = z.enum([
  "completed",
  "cancelled",
  "interrupted",
  "errored",
]);

/** Durable terminal outcome for one provider turn. */
export type TurnOutcome = z.infer<typeof TurnOutcomeSchema>;
