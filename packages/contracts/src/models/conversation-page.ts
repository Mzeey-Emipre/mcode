import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";
import { MessageSchema } from "./message.js";
import { ToolCallRecordSchema } from "./tool-call-record.js";
import { ThoughtSegmentRecordSchema } from "./thought-segment.js";
import { HookExecutionRecordSchema } from "./hook-execution.js";

/** Persisted narrative records grouped under one assistant message. */
export const ConversationNarrativeBatchSchema = lazySchema(() =>
  z.object({
    tools: z.array(ToolCallRecordSchema()),
    thoughts: z.array(ThoughtSegmentRecordSchema()),
    hooks: z.array(HookExecutionRecordSchema()),
  }),
);

/** Thread conversation page: messages plus their grouped narrative payloads. */
export const ConversationPageSchema = lazySchema(() =>
  z.object({
    messages: z.array(MessageSchema()),
    hasMore: z.boolean(),
    answeredPlanMessageIds: z.array(z.string()).optional(),
    narrativeByMessage: z.record(ConversationNarrativeBatchSchema()),
  }),
);

/** Persisted narrative records grouped under one assistant message. */
export type ConversationNarrativeBatch = z.infer<ReturnType<typeof ConversationNarrativeBatchSchema>>;

/** Thread conversation page returned by `conversation.page`. */
export type ConversationPage = z.infer<ReturnType<typeof ConversationPageSchema>>;
