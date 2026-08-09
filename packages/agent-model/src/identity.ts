import { z } from "zod";

const CanonicalIdSchema = z.string().trim().min(1).max(256);

/** ISO 8601 timestamp accepted by canonical agent records. */
export const CanonicalTimestampSchema = z.string().datetime({ offset: true });

/** Mcode-owned identity for a canonical agent thread. */
export const AgentThreadIdSchema = CanonicalIdSchema;
/** Mcode-owned identity for one execution round. */
export const AgentTurnIdSchema = CanonicalIdSchema;
/** Mcode-owned identity for one provider execution attempt. */
export const AgentTurnExecutionIdSchema = z.string().uuid();
/** Mcode-owned identity for one semantic item. */
export const AgentItemIdSchema = CanonicalIdSchema;
/** Mcode-owned identity for one cross-thread collaboration action. */
export const CollaborationActionIdSchema = CanonicalIdSchema;
/** Mcode-owned identity for one canonical semantic event. */
export const AgentEventIdSchema = CanonicalIdSchema;
/** Stable identifier for an agent provider. */
export const ProviderIdSchema = CanonicalIdSchema;

/** Provenance for a provider identity without implying that Mcode owns it. */
export const IdentityProvenanceSchema = z.enum(["native", "derived", "generated"]);
/** Provenance for a provider identity without implying that Mcode owns it. */
export type IdentityProvenance = z.infer<typeof IdentityProvenanceSchema>;

/** Provider resource level at which an optional identity is valid. */
export const ProviderIdentityScopeSchema = z.enum([
  "session",
  "thread",
  "turn",
  "item",
  "agent",
  "parentItem",
]);
/** Provider resource level at which an optional identity is valid. */
export type ProviderIdentityScope = z.infer<typeof ProviderIdentityScopeSchema>;

/** Optional source identity supplied with explicit provider scope and provenance. */
export const ProviderIdentitySchema = z
  .object({
    providerId: ProviderIdSchema,
    scope: ProviderIdentityScopeSchema,
    value: z.string().trim().min(1).max(512),
    provenance: IdentityProvenanceSchema,
  })
  .strict();
/** Optional source identity supplied with explicit provider scope and provenance. */
export type ProviderIdentity = z.infer<typeof ProviderIdentitySchema>;

/** Canonical routing identity for a semantic event. */
export const AgentEventRoutingSchema = z
  .object({
    threadId: AgentThreadIdSchema,
    turnId: AgentTurnIdSchema.optional(),
    executionId: AgentTurnExecutionIdSchema,
    itemId: AgentItemIdSchema.optional(),
    collaborationActionId: CollaborationActionIdSchema.optional(),
  })
  .strict();
/** Canonical routing identity for a semantic event. */
export type AgentEventRouting = z.infer<typeof AgentEventRoutingSchema>;

/** Mcode-owned canonical thread identity. */
export type AgentThreadId = z.infer<typeof AgentThreadIdSchema>;
/** Mcode-owned canonical turn identity. */
export type AgentTurnId = z.infer<typeof AgentTurnIdSchema>;
/** Mcode-owned canonical provider execution identity. */
export type AgentTurnExecutionId = z.infer<typeof AgentTurnExecutionIdSchema>;
/** Mcode-owned canonical item identity. */
export type AgentItemId = z.infer<typeof AgentItemIdSchema>;
/** Mcode-owned canonical collaboration-action identity. */
export type CollaborationActionId = z.infer<typeof CollaborationActionIdSchema>;
/** Mcode-owned canonical event identity. */
export type AgentEventId = z.infer<typeof AgentEventIdSchema>;
/** Stable provider identity used by canonical records. */
export type ProviderId = z.infer<typeof ProviderIdSchema>;
