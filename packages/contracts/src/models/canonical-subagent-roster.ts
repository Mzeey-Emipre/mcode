import { z } from "zod";
import {
  AgentThreadActivityStateSchema,
  AgentThreadIdSchema,
  AgentTurnStatusSchema,
  CanonicalTimestampSchema,
  ProviderIdentitySchema,
  type AgentTurnStatus,
} from "../compat/agent-model.js";
import { lazySchema } from "../utils/lazySchema.js";

/** Maximum number of canonical children returned by one roster read. */
export const CANONICAL_SUBAGENT_ROSTER_MAX_CHILDREN = 256;

/** Maximum number of ancestor IDs retained for one roster row. */
export const CANONICAL_SUBAGENT_LINEAGE_MAX_DEPTH = 64;
/** Maximum persisted length of a delegated task description. */
export const CANONICAL_SUBAGENT_TASK_MAX_LENGTH = 32_768;

/** Bounded request for the canonical descendants of one owning parent. */
export const CanonicalSubagentRosterRequestSchema = lazySchema(() =>
  z.object({
    owningParentThreadId: AgentThreadIdSchema,
    limit: z.number().int().min(1).max(CANONICAL_SUBAGENT_ROSTER_MAX_CHILDREN).default(
      CANONICAL_SUBAGENT_ROSTER_MAX_CHILDREN,
    ),
  }).strict(),
);

/** Request to stop one exact active canonical child turn. */
export const CanonicalSubagentStopRequestSchema = lazySchema(() =>
  z.object({
    owningParentThreadId: AgentThreadIdSchema,
    childThreadId: AgentThreadIdSchema,
  }).strict(),
);

/** Exact terminal state represented in the canonical turn model. */
export const CanonicalSubagentTerminalOutcomeSchema = z.enum([
  "Completed",
  "Interrupted",
  "Errored",
]);

/** Result of one canonical child interruption attempt. */
export const CanonicalSubagentStopResultSchema = lazySchema(() =>
  z.object({
    childThreadId: AgentThreadIdSchema,
    status: z.enum(["interrupted", "already-terminal", "unsupported", "failed"]),
    message: z.string().trim().min(1).max(512).optional(),
  }).strict(),
);

/** One canonical child in the authoritative Sub-agents roster. */
export const CanonicalSubagentRosterRowSchema = lazySchema(() =>
  z.object({
    id: AgentThreadIdSchema,
    parentThreadId: AgentThreadIdSchema,
    rootThreadId: AgentThreadIdSchema,
    owningParentThreadId: AgentThreadIdSchema,
    lineage: z.array(AgentThreadIdSchema).min(1).max(CANONICAL_SUBAGENT_LINEAGE_MAX_DEPTH),
    activityState: AgentThreadActivityStateSchema,
    latestTurnStatus: AgentTurnStatusSchema.nullable(),
    startedAt: CanonicalTimestampSchema,
    updatedAt: CanonicalTimestampSchema,
    endedAt: CanonicalTimestampSchema.nullable(),
    terminalOutcome: CanonicalSubagentTerminalOutcomeSchema.nullable(),
    task: z.string().trim().min(1).max(CANONICAL_SUBAGENT_TASK_MAX_LENGTH).optional(),
    identity: z.string().trim().min(1).max(96).optional(),
    model: z.string().trim().min(1).max(128).optional(),
    reasoning: z.string().trim().min(1).max(128).optional(),
    providerIdentities: z.array(ProviderIdentitySchema).max(16),
    sourceProviderIdentities: z.array(ProviderIdentitySchema).max(16),
    hasActiveDescendant: z.boolean(),
    canStop: z.boolean(),
  }).strict(),
);

/** Canonical active and completed descendants for one owning parent. */
export const CanonicalSubagentRosterSchema = lazySchema(() =>
  z.object({
    owningParentThreadId: AgentThreadIdSchema,
    rosterRevision: z.number().int().nonnegative(),
    active: z.array(CanonicalSubagentRosterRowSchema()).max(CANONICAL_SUBAGENT_ROSTER_MAX_CHILDREN),
    done: z.array(CanonicalSubagentRosterRowSchema()).max(CANONICAL_SUBAGENT_ROSTER_MAX_CHILDREN),
  }).strict(),
);

/** Bounded canonical roster request. */
export type CanonicalSubagentRosterRequest = z.infer<ReturnType<typeof CanonicalSubagentRosterRequestSchema>>;

/** Request to stop one exact active canonical child turn. */
export type CanonicalSubagentStopRequest = z.infer<ReturnType<typeof CanonicalSubagentStopRequestSchema>>;

/** Result of one canonical child interruption attempt. */
export type CanonicalSubagentStopResult = z.infer<ReturnType<typeof CanonicalSubagentStopResultSchema>>;

/** Exact terminal outcome for one canonical child turn. */
export type CanonicalSubagentTerminalOutcome = z.infer<typeof CanonicalSubagentTerminalOutcomeSchema>;

/** Canonical child roster row. */
export type CanonicalSubagentRosterRow = z.infer<ReturnType<typeof CanonicalSubagentRosterRowSchema>>;

/** Canonical Sub-agents roster response. */
export type CanonicalSubagentRoster = z.infer<ReturnType<typeof CanonicalSubagentRosterSchema>>;

/** Convert a canonical turn status to the roster's exact terminal outcome. */
export function canonicalSubagentTerminalOutcome(
  status: AgentTurnStatus | null,
): CanonicalSubagentTerminalOutcome | null {
  switch (status) {
    case "Completed":
      return "Completed";
    case "Interrupted":
      return "Interrupted";
    case "Errored":
      return "Errored";
    default:
      return null;
  }
}
