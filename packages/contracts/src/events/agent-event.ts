import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";
import { QuotaCategorySchema } from "../providers/usage.js";

/**
 * All valid `type` discriminants for `AgentEvent`.
 * Use these constants instead of string literals to get autocomplete and
 * a compile-time error if a value is renamed or removed.
 *
 * @example
 * if (event.type === AgentEventType.ToolUse) { ... }
 */
export const AgentEventType = {
  Message: "message",
  ToolUse: "toolUse",
  ToolResult: "toolResult",
  TurnComplete: "turnComplete",
  Error: "error",
  Ended: "ended",
  System: "system",
  Compacting: "compacting",
  CompactSummary: "compactSummary",
  ModelFallback: "modelFallback",
  TextDelta: "textDelta",
  ToolInputDelta: "toolInputDelta",
  ToolProgress: "toolProgress",
  ContextEstimate: "contextEstimate",
  QuotaUpdate: "quotaUpdate",
} as const;

/** Union of all valid `AgentEvent` type discriminants. */
export type AgentEventType = typeof AgentEventType[keyof typeof AgentEventType];

/** Discriminated union of all events emitted by an agent provider. */
export const AgentEventSchema = lazySchema(() =>
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal(AgentEventType.Message),
      threadId: z.string(),
      content: z.string(),
      tokens: z.number().nullable(),
      /** Server-assigned message ID, injected after DB persistence. Used by the client for stable branching. */
      messageId: z.string().optional(),
    }),
    z.object({
      type: z.literal(AgentEventType.ToolUse),
      threadId: z.string(),
      toolCallId: z.string(),
      toolName: z.string(),
      toolInput: z.record(z.unknown()),
      parentToolCallId: z.string().optional(),
    }),
    z.object({
      type: z.literal(AgentEventType.ToolResult),
      threadId: z.string(),
      toolCallId: z.string(),
      output: z.string(),
      isError: z.boolean(),
    }),
    z.object({
      type: z.literal(AgentEventType.TurnComplete),
      threadId: z.string(),
      reason: z.string(),
      costUsd: z.number().nullable(),
      tokensIn: z.number(),
      tokensOut: z.number(),
      /** Model's max context window reported by the SDK, if available. */
      contextWindow: z.number().optional(),
      /** Accumulated total tokens processed across all API calls in the session. */
      totalProcessedTokens: z.number().optional(),
      cacheReadTokens: z.number().optional(),
      cacheWriteTokens: z.number().optional(),
      costMultiplier: z.number().optional(),
      providerId: z.string().optional(),
    }),
    z.object({
      type: z.literal(AgentEventType.Error),
      threadId: z.string(),
      error: z.string(),
    }),
    z.object({
      type: z.literal(AgentEventType.Ended),
      threadId: z.string(),
    }),
    z.object({
      type: z.literal(AgentEventType.System),
      threadId: z.string(),
      subtype: z.string(),
    }),
    z.object({
      /** Emitted when the SDK starts or finishes compacting the context window. */
      type: z.literal(AgentEventType.Compacting),
      threadId: z.string(),
      /** True when compaction is starting, false when it has finished. */
      active: z.boolean(),
    }),
    z.object({
      /** Emitted when a provider completes context compaction, carrying the generated summary. */
      type: z.literal(AgentEventType.CompactSummary),
      threadId: z.string(),
      /** Full compaction summary text produced by the SDK. Used to seed branched thread replays. */
      summary: z.string(),
    }),
    z.object({
      /** Emitted when the SDK fell back to an alternate model. */
      type: z.literal(AgentEventType.ModelFallback),
      threadId: z.string(),
      /** The model that was originally requested. */
      requestedModel: z.string(),
      /** The model that actually ran. */
      actualModel: z.string(),
    }),
    z.object({
      /** A streaming text chunk emitted as Claude types its response. */
      type: z.literal(AgentEventType.TextDelta),
      threadId: z.string(),
      /** Partial response text - append to accumulate the full response. */
      delta: z.string(),
    }),
    z.object({
      /** Incremental JSON fragment emitted while Claude builds a tool call's input. */
      type: z.literal(AgentEventType.ToolInputDelta),
      threadId: z.string(),
      /** Partial JSON string to append to the tool input being assembled. */
      partialJson: z.string(),
    }),
    z.object({
      /** Heartbeat emitted while a tool is executing, carrying elapsed wall-clock time. */
      type: z.literal(AgentEventType.ToolProgress),
      threadId: z.string(),
      /** Identifier of the tool call this progress event belongs to. */
      toolCallId: z.string(),
      /** Name of the tool currently executing. */
      toolName: z.string(),
      /** Elapsed seconds since the tool started, as reported by the SDK. */
      elapsedSeconds: z.number(),
    }),
    z.object({
      /**
       * Incremental context token estimate emitted during a turn (after each
       * tool result) and immediately after compaction finishes. Replaces the
       * stale snapshot in contextByThread without waiting for turnComplete.
       */
      type: z.literal(AgentEventType.ContextEstimate),
      threadId: z.string(),
      /** Estimated total tokens currently occupying the context window. */
      tokensIn: z.number(),
      /** Model context window size, forwarded from SDK when available. */
      contextWindow: z.number().optional(),
    }),
    z.object({
      type: z.literal(AgentEventType.QuotaUpdate),
      threadId: z.string(),
      providerId: z.string(),
      categories: z.array(QuotaCategorySchema()),
      sessionCostUsd: z.number().optional(),
    }),
  ]),
);
/** Union of all events emitted by an agent provider. */
export type AgentEvent = z.infer<ReturnType<typeof AgentEventSchema>>;
