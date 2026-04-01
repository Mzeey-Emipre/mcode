import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";

/** Discriminated union of all events emitted by an agent provider. */
export const AgentEventSchema = lazySchema(() =>
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("message"),
      threadId: z.string(),
      content: z.string(),
      tokens: z.number().nullable(),
    }),
    z.object({
      type: z.literal("toolUse"),
      threadId: z.string(),
      toolCallId: z.string(),
      toolName: z.string(),
      toolInput: z.record(z.unknown()),
      parentToolCallId: z.string().optional(),
    }),
    z.object({
      type: z.literal("toolResult"),
      threadId: z.string(),
      toolCallId: z.string(),
      output: z.string(),
      isError: z.boolean(),
    }),
    z.object({
      type: z.literal("turnComplete"),
      threadId: z.string(),
      reason: z.string(),
      costUsd: z.number().nullable(),
      tokensIn: z.number(),
      tokensOut: z.number(),
    }),
    z.object({
      type: z.literal("error"),
      threadId: z.string(),
      error: z.string(),
    }),
    z.object({
      type: z.literal("ended"),
      threadId: z.string(),
    }),
    z.object({
      type: z.literal("system"),
      threadId: z.string(),
      subtype: z.string(),
    }),
    z.object({
      /** Emitted when the SDK fell back to an alternate model. */
      type: z.literal("modelFallback"),
      threadId: z.string(),
      /** The model that was originally requested. */
      requestedModel: z.string(),
      /** The model that actually ran. */
      actualModel: z.string(),
    }),
  ]),
);
/** Union of all events emitted by an agent provider. */
export type AgentEvent = z.infer<ReturnType<typeof AgentEventSchema>>;
