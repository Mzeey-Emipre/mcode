import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";
import { ToolCallRecordSchema } from "./tool-call-record.js";
import { ThoughtSegmentRecordSchema } from "./thought-segment.js";
import { HookExecutionRecordSchema } from "./hook-execution.js";

/**
 * One bounded, user-visible narrative record retained while a parent turn is
 * unfinished. These projections exclude provider transport traffic.
 */
export const ParentNarrativeRecoveryItemSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("toolCall"),
      record: ToolCallRecordSchema,
    }),
    z.object({
      kind: z.literal("narrationSegment"),
      record: ThoughtSegmentRecordSchema,
    }),
    z.object({
      kind: z.literal("hook"),
      record: HookExecutionRecordSchema,
    }),
  ]),
);

/** One durable semantic recovery record for an unfinished parent turn. */
export type ParentNarrativeRecoveryItem = z.infer<
  ReturnType<typeof ParentNarrativeRecoveryItemSchema>
>;
