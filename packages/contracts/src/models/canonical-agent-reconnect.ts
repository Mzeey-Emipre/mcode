import { z } from "zod";
import {
  AgentModelStateSchema,
  CanonicalAgentEventEnvelopeSchema,
} from "../compat/agent-model.js";
import { lazySchema } from "../utils/lazySchema.js";

/** Maximum canonical events returned for one reconnect delta. */
export const CANONICAL_AGENT_RECONNECT_DELTA_MAX_EVENTS = 256;

/** Last canonical revisions installed by one renderer thread replica. */
export const CanonicalAgentRevisionSchema = lazySchema(() =>
  z.object({
    conversationRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    rosterRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }).strict(),
);

/** Point-in-time canonical state declared at one conversation and roster revision. */
export const CanonicalAgentSnapshotSchema = lazySchema(() =>
  z.object({
    revision: CanonicalAgentRevisionSchema(),
    state: AgentModelStateSchema,
  }).strict(),
);

/** Reconnect result for one subscribed thread. */
export const CanonicalAgentReconnectRecoverySchema = lazySchema(() =>
  z.discriminatedUnion("mode", [
    z.object({
      mode: z.literal("delta"),
      threadId: z.string().trim().min(1).max(256),
      from: CanonicalAgentRevisionSchema(),
      through: CanonicalAgentRevisionSchema(),
      events: z.array(CanonicalAgentEventEnvelopeSchema)
        .max(CANONICAL_AGENT_RECONNECT_DELTA_MAX_EVENTS),
    }).strict(),
    z.object({
      mode: z.literal("snapshot"),
      threadId: z.string().trim().min(1).max(256),
      snapshot: CanonicalAgentSnapshotSchema(),
    }).strict(),
  ]),
);

/** Last canonical revisions installed by one renderer thread replica. */
export type CanonicalAgentRevision = z.infer<ReturnType<typeof CanonicalAgentRevisionSchema>>;

/** Point-in-time canonical state declared at one conversation and roster revision. */
export type CanonicalAgentSnapshot = z.infer<ReturnType<typeof CanonicalAgentSnapshotSchema>>;

/** Reconnect result for one subscribed thread. */
export type CanonicalAgentReconnectRecovery = z.infer<
  ReturnType<typeof CanonicalAgentReconnectRecoverySchema>
>;
