import { z } from "zod";
import { MessageRoleSchema } from "./enums.js";
import { StoredAttachmentSchema } from "./attachment.js";
import { lazySchema } from "../utils/lazySchema.js";
import { MessageMentionsSchema } from "./mention.js";
import { SelectedTextCommentsSchema } from "./selected-text-comment.js";
import { PreviewAnnotationBundleSchema } from "./browser-preview.js";
import { ProviderIdentitySchema } from "../compat/agent-model.js";
import { TurnOutcomeSchema } from "./turn-outcome.js";

/** Canonical provenance for a user-side message sent by a parent agent. */
export const ParentAgentMessageProvenanceSchema = lazySchema(() => z.object({
  parentThreadId: z.string().trim().min(1).max(256),
  parentTurnId: z.string().trim().min(1).max(256),
  parentItemId: z.string().trim().min(1).max(256),
  providerIdentities: z.array(ProviderIdentitySchema).max(16),
}).strict());

/** Canonical provenance for a user-side message sent by a parent agent. */
export type ParentAgentMessageProvenance = z.infer<ReturnType<typeof ParentAgentMessageProvenanceSchema>>;

/** Provenance for a retained message that originated in the legacy conversation store. */
export const LegacyMessageProvenanceSchema = lazySchema(() => z.object({
  source: z.literal("messages"),
  migrationVersion: z.number().int().positive().nullable(),
  mapping: z.enum(["canonical", "legacy"]),
  reason: z.string().optional(),
}));

/** Provenance for a retained message that originated in the legacy conversation store. */
export type LegacyMessageProvenance = z.infer<ReturnType<typeof LegacyMessageProvenanceSchema>>;

/** Typed metadata retained with a provider system notice. */
export interface SystemNoticeMetadata {
  kind: "diagnostic" | "warning" | "security" | "configuration" | "deprecation" | "model-rerouted" | "authentication-recovered";
  presentation: "timeline" | "toast";
  scope?: "turn" | "session";
  sessionId?: string;
  noticeKey?: string;
  origin?: "unattributed-thread";
  fromModel?: string;
  toModel?: string;
  reason?: "safety" | "availability";
  configPath?: string;
  configRange?: { startLine: number; startColumn: number; endLine: number; endColumn: number };
}

/** Bounded provider-neutral metadata for a persisted system notice. */
export const SystemNoticeMetadataSchema = lazySchema<z.ZodType<SystemNoticeMetadata>>(() => z.object({
  kind: z.enum(["diagnostic", "warning", "security", "configuration", "deprecation", "model-rerouted", "authentication-recovered"]),
  presentation: z.enum(["timeline", "toast"]),
  scope: z.enum(["turn", "session"]).optional(),
  sessionId: z.string().max(64).optional(),
  noticeKey: z.string().max(64).optional(),
  origin: z.literal("unattributed-thread").optional(),
  fromModel: z.string().max(128).optional(),
  toModel: z.string().max(128).optional(),
  reason: z.enum(["safety", "availability"]).optional(),
  configPath: z.string().max(1_024).optional(),
  configRange: z.object({
    startLine: z.number().int().nonnegative().max(1_000_000),
    startColumn: z.number().int().nonnegative().max(1_000_000),
    endLine: z.number().int().nonnegative().max(1_000_000),
    endColumn: z.number().int().nonnegative().max(1_000_000),
  }).optional(),
}).strict());

/** Message schema matching the SQLite row shape. */
export const MessageSchema = lazySchema(() =>
  z.object({
    id: z.string(),
    thread_id: z.string(),
    role: MessageRoleSchema,
    content: z.string(),
    tool_calls: z.unknown().nullable(),
    files_changed: z.unknown().nullable(),
    cost_usd: z.number().nullable(),
    tokens_used: z.number().nullable(),
    timestamp: z.string(),
    sequence: z.number(),
    attachments: z.array(StoredAttachmentSchema()).nullable(),
    previewAnnotations: PreviewAnnotationBundleSchema().nullable().optional(),
    mentions: MessageMentionsSchema().nullable().optional(),
    selectedTextComments: SelectedTextCommentsSchema().nullable().optional(),
    tool_call_count: z.number().optional(),
    reply_to_message_id: z.string().nullable().optional(),
    quoted_text: z.string().nullable().optional(),
    /**
     * Model identifier active when an assistant message was produced
     * (e.g. "claude-opus-4-7", "cursor-agent", "gpt-4.1"). Null for user
     * messages and for assistant messages persisted before the `model`
     * column existed.
     */
    model: z.string().nullable().optional(),
    /** Terminal outcome written only when the turn finalizer proves its end. */
    outcome: TurnOutcomeSchema.nullable().optional(),
    /** Exact execution identity needed by existing retry recovery after reload. */
    outcomeExecutionId: z.string().nullable().optional(),
    /** Bounded provider notice metadata retained across transcript reloads. */
    systemNotice: SystemNoticeMetadataSchema().nullable().optional(),
    /**
     * When true, mcode hides this message from the chat timeline.
     * Used for hidden handoff turns on Cursor parent threads.
     * Omitted or false for all legacy rows that predate this column.
     */
    is_internal: z.boolean().optional(),
    legacyProvenance: LegacyMessageProvenanceSchema().optional(),
    parentAgentProvenance: ParentAgentMessageProvenanceSchema().optional(),
  }),
);
/** Message record from the database. */
export type Message = z.infer<ReturnType<typeof MessageSchema>>;

/** Bounded session diagnostics, separate from transcript pagination. */
export const SessionNoticesSchema = lazySchema<z.ZodType<Message[]>>(() => z.array(MessageSchema()).max(20));

/** Paginated message list with cursor metadata. */
export const PaginatedMessagesSchema = lazySchema(() =>
  z.object({
    messages: z.array(MessageSchema()),
    hasMore: z.boolean(),
    /**
     * IDs of assistant messages whose plan-questions block has been answered.
     * Used by the web client to suppress the plan-question wizard from
     * re-popping after restarts or mid-turn errors. Optional for backwards
     * compatibility — older servers omit it and the client falls back to the
     * structural heuristic.
     */
    answeredPlanMessageIds: z.array(z.string()).optional(),
  }),
);
/** Paginated message response from the server. */
export type PaginatedMessages = z.infer<ReturnType<typeof PaginatedMessagesSchema>>;
