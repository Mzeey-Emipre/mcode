import { z } from "zod";
import {
  AgentItemIdSchema,
  AgentThreadIdSchema,
  AgentTurnIdSchema,
  CanonicalTimestampSchema,
  CollaborationActionIdSchema,
  ProviderIdSchema,
  ProviderIdentitySchema,
} from "./identity.js";

const RecordTimestampsSchema = {
  createdAt: CanonicalTimestampSchema,
  updatedAt: CanonicalTimestampSchema,
} as const;
const ProviderIdentitiesSchema = z.array(ProviderIdentitySchema).max(16);

/** Activity state for a canonical agent thread. */
export const AgentThreadActivityStateSchema = z.enum([
  "Starting",
  "Active",
  "Idle",
  "Closed",
  "Unavailable",
]);
/** Activity state for a canonical agent thread. */
export type AgentThreadActivityState = z.infer<typeof AgentThreadActivityStateSchema>;

/** Runtime-neutral canonical thread record. */
export const AgentThreadSchema = z
  .object({
    id: AgentThreadIdSchema,
    workspaceId: z.string().trim().min(1).max(256),
    parentThreadId: AgentThreadIdSchema.optional(),
    rootThreadId: AgentThreadIdSchema,
    owningParentThreadId: AgentThreadIdSchema.optional(),
    providerId: ProviderIdSchema,
    providerIdentities: ProviderIdentitiesSchema,
    activityState: AgentThreadActivityStateSchema,
    conversationRevision: z.number().int().nonnegative(),
    rosterRevision: z.number().int().nonnegative(),
    ...RecordTimestampsSchema,
  })
  .strict();
/** Runtime-neutral canonical thread record. */
export type AgentThread = z.infer<typeof AgentThreadSchema>;

/** Lifecycle state for one canonical execution round. */
export const AgentTurnStatusSchema = z.enum([
  "Pending",
  "Running",
  "Completed",
  "Cancelled",
  "Interrupted",
  "Errored",
]);
/** Lifecycle state for one canonical execution round. */
export type AgentTurnStatus = z.infer<typeof AgentTurnStatusSchema>;

/** Provenance for the action that caused a canonical turn. */
export const AgentTurnTriggerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user") }).strict(),
  z
    .object({
      kind: z.literal("provider"),
      providerId: ProviderIdSchema,
      providerIdentities: ProviderIdentitiesSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("child"),
      sourceThreadId: AgentThreadIdSchema,
      sourceTurnId: AgentTurnIdSchema,
      sourceItemId: AgentItemIdSchema.optional(),
    })
    .strict(),
]);
/** Provenance for the action that caused a canonical turn. */
export type AgentTurnTrigger = z.infer<typeof AgentTurnTriggerSchema>;

/** Runtime-neutral canonical turn record. */
export const AgentTurnSchema = z
  .object({
    id: AgentTurnIdSchema,
    threadId: AgentThreadIdSchema,
    status: AgentTurnStatusSchema,
    trigger: AgentTurnTriggerSchema,
    permissionMode: z.enum(["supervised", "full"]),
    approvalReviewMode: z.enum(["manual", "automatic"]),
    approvalReviewReason: z.string().min(1).max(128),
    providerIdentities: ProviderIdentitiesSchema,
    startedAt: CanonicalTimestampSchema.nullable(),
    endedAt: CanonicalTimestampSchema.nullable(),
    ...RecordTimestampsSchema,
  })
  .strict();
/** Runtime-neutral canonical turn record. */
export type AgentTurn = z.infer<typeof AgentTurnSchema>;

/** Semantic item kind stored under one canonical turn. */
export const AgentItemKindSchema = z.enum([
  "message",
  "reasoning",
  "tool-call",
  "tool-result",
  "system",
  "summary",
  "error",
]);
/** Semantic item kind stored under one canonical turn. */
export type AgentItemKind = z.infer<typeof AgentItemKindSchema>;

/** Runtime-neutral canonical semantic item. */
export const AgentItemSchema = z
  .object({
    id: AgentItemIdSchema,
    threadId: AgentThreadIdSchema,
    turnId: AgentTurnIdSchema,
    parentItemId: AgentItemIdSchema.optional(),
    kind: AgentItemKindSchema,
    providerIdentities: ProviderIdentitiesSchema,
    payload: z.record(z.unknown()),
    ...RecordTimestampsSchema,
  })
  .strict();
/** Runtime-neutral canonical semantic item. */
export type AgentItem = z.infer<typeof AgentItemSchema>;

/** Direction of one cross-thread collaboration request or response. */
export const CollaborationActionKindSchema = z.enum([
  "delegate",
  "follow-up",
  "resume",
  "message",
  "return-result",
  "permission",
  "clarification",
]);
/** Direction of one cross-thread collaboration request or response. */
export type CollaborationActionKind = z.infer<typeof CollaborationActionKindSchema>;

/** Delivery state for a collaboration action, separate from turn execution state. */
export const CollaborationActionStatusSchema = z.enum([
  "Pending",
  "Dispatched",
  "Acknowledged",
  "Failed",
]);
/** Delivery state for a collaboration action, separate from turn execution state. */
export type CollaborationActionStatus = z.infer<typeof CollaborationActionStatusSchema>;

/** Maximum retained length of a message sent through one collaboration action. */
export const COLLABORATION_ACTION_MESSAGE_MAX_LENGTH = 32_768;

/** Canonical source reference for a collaboration action. */
export const CollaborationSourceSchema = z
  .object({
    threadId: AgentThreadIdSchema,
    turnId: AgentTurnIdSchema,
    itemId: AgentItemIdSchema,
  })
  .strict();
/** Canonical source reference for a collaboration action. */
export type CollaborationSource = z.infer<typeof CollaborationSourceSchema>;

/** Canonical target reference for a collaboration action. */
export const CollaborationTargetSchema = z
  .object({
    threadId: AgentThreadIdSchema,
    turnId: AgentTurnIdSchema.optional(),
  })
  .strict();
/** Canonical target reference for a collaboration action. */
export type CollaborationTarget = z.infer<typeof CollaborationTargetSchema>;

/** Runtime-neutral record of one directional collaboration delivery. */
export const CollaborationActionSchema = z
  .object({
    id: CollaborationActionIdSchema,
    kind: CollaborationActionKindSchema,
    source: CollaborationSourceSchema,
    target: CollaborationTargetSchema,
    status: CollaborationActionStatusSchema,
    deliveryUnknown: z.boolean(),
    message: z.string().trim().min(1).max(COLLABORATION_ACTION_MESSAGE_MAX_LENGTH).optional(),
    providerIdentities: ProviderIdentitiesSchema,
    ...RecordTimestampsSchema,
  })
  .strict();
/** Runtime-neutral record of one directional collaboration delivery. */
export type CollaborationAction = z.infer<typeof CollaborationActionSchema>;
