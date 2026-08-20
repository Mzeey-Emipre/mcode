import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";

/** Maximum persisted length of a sub-agent display identity. */
export const SUBAGENT_DISPLAY_NAME_MAX_LENGTH = 96;
/** Maximum persisted length of an explicit provider logical-agent key. */
export const PROVIDER_AGENT_KEY_MAX_LENGTH = 256;
/** Maximum persisted length of provider model and reasoning metadata. */
export const SUBAGENT_METADATA_MAX_LENGTH = 128;
/** Maximum accepted length of a sub-agent navigation identity. */
export const SUBAGENT_IDENTITY_KEY_MAX_LENGTH = 512;

function explicitString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Resolves a bounded sub-agent identity without consulting delegated task text. */
export function resolveSubagentDisplayName(input: Record<string, unknown>): string | undefined {
  const direct = explicitString(input.agentName)
    ?? explicitString(input.subagentName)
    ?? explicitString(input.name);
  const agentPath = explicitString(input.agentPath);
  const pathTail = agentPath?.split(/[\\/]/).filter(Boolean).pop();
  const identity = direct
    ?? explicitString(pathTail)
    ?? explicitString(input.subagentType)
    ?? explicitString(input.subagent_type);
  if (!identity || identity.length <= SUBAGENT_DISPLAY_NAME_MAX_LENGTH) return identity;
  return `${identity.slice(0, SUBAGENT_DISPLAY_NAME_MAX_LENGTH - 1)}…`;
}

/** Resolves the bounded canonical path emitted by a Codex spawnAgent call. */
export function resolveProviderAgentKey(input: Record<string, unknown>): string | undefined {
  if (input.codexCollabKind !== "spawnAgent") return undefined;
  const agentPath = explicitString(input.agentPath);
  if (!agentPath?.startsWith("/") || agentPath.length > PROVIDER_AGENT_KEY_MAX_LENGTH) {
    return undefined;
  }
  return agentPath;
}

/** Resolves one bounded provider metadata field from an Agent tool input. */
export function resolveSubagentMetadata(value: unknown): string | undefined {
  const metadata = explicitString(value);
  return metadata && metadata.length <= SUBAGENT_METADATA_MAX_LENGTH ? metadata : undefined;
}

/** Resolves the exact receiver/native child identity from structural Agent input. */
export function resolveSubagentExactIdentity(input: Record<string, unknown>): string | undefined {
  const receiverThreadId = resolveReceiverThreadId(input);
  if (receiverThreadId) return receiverThreadId;
  const nativeThreadId = explicitString(input.nativeThreadId);
  return nativeThreadId && nativeThreadId.length <= SUBAGENT_IDENTITY_KEY_MAX_LENGTH
    ? nativeThreadId
    : undefined;
}

/** Formats a normalized sub-agent identity as a sentence-style title. */
export function formatSubagentDisplayName(identity: string): string {
  const sentence = identity.trim().replace(/_+/g, " ").replace(/\s+/g, " ");
  if (sentence.length === 0) return "Subagent";
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}`;
}

/** Presentation model consumed by sub-agent UI surfaces. */
export const SubagentPresentationSchema = lazySchema(() => z.object({
  displayName: z.string().min(1).max(SUBAGENT_DISPLAY_NAME_MAX_LENGTH),
  hasExplicitIdentity: z.boolean(),
  identityKey: z.string().min(1).max(SUBAGENT_IDENTITY_KEY_MAX_LENGTH),
  providerAgentKey: z.string().max(PROVIDER_AGENT_KEY_MAX_LENGTH).optional(),
  model: z.string().max(SUBAGENT_METADATA_MAX_LENGTH).optional(),
  reasoningEffort: z.string().max(SUBAGENT_METADATA_MAX_LENGTH).optional(),
}));

/** Presentation model consumed by sub-agent UI surfaces. */
export type SubagentPresentation = z.infer<ReturnType<typeof SubagentPresentationSchema>>;

function resolveReceiverThreadId(input: Record<string, unknown>): string | undefined {
  if (!Array.isArray(input.receiverThreadIds) || input.receiverThreadIds.length !== 1) return undefined;
  const receiverThreadId = explicitString(input.receiverThreadIds[0]);
  return receiverThreadId && receiverThreadId.length <= SUBAGENT_IDENTITY_KEY_MAX_LENGTH
    ? receiverThreadId
    : undefined;
}

/** Creates the provider-neutral presentation for one Agent tool call. */
export function createSubagentPresentation(
  input: Record<string, unknown>,
  fallbackIdentityKey: string,
): SubagentPresentation {
  const resolvedDisplayName = resolveSubagentDisplayName(input);
  const providerAgentKey = resolveProviderAgentKey(input);
  const model = resolveSubagentMetadata(input.model);
  const reasoningEffort = resolveSubagentMetadata(input.reasoningEffort);
  return {
    displayName: formatSubagentDisplayName(resolvedDisplayName ?? "Subagent"),
    hasExplicitIdentity: resolvedDisplayName !== undefined,
    identityKey: resolveSubagentExactIdentity(input) ?? providerAgentKey ?? fallbackIdentityKey,
    ...(providerAgentKey ? { providerAgentKey } : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

/** Merges late sub-agent metadata without replacing an established navigation identity. */
export function mergeSubagentPresentation(
  current: SubagentPresentation | undefined,
  incoming: SubagentPresentation,
  fallbackIdentityKey: string,
): SubagentPresentation {
  if (!current) return incoming;
  return {
    displayName: incoming.hasExplicitIdentity ? incoming.displayName : current.displayName,
    hasExplicitIdentity: current.hasExplicitIdentity || incoming.hasExplicitIdentity,
    identityKey: incoming.identityKey === fallbackIdentityKey ? current.identityKey : incoming.identityKey,
    providerAgentKey: incoming.providerAgentKey ?? current.providerAgentKey,
    model: incoming.model ?? current.model,
    reasoningEffort: incoming.reasoningEffort ?? current.reasoningEffort,
  };
}

/** Status of a persisted tool call record. */
export const ToolCallStatusSchema = z.enum(["running", "completed", "failed", "cancelled"]);

/** Status of a persisted tool call record. */
export type ToolCallStatus = z.infer<typeof ToolCallStatusSchema>;

/** Persisted tool call record linked to an assistant message. */
export const ToolCallRecordSchema = z.object({
  id: z.string(),
  message_id: z.string(),
  parent_tool_call_id: z.string().nullable(),
  tool_name: z.string(),
  display_name: z.string().max(SUBAGENT_DISPLAY_NAME_MAX_LENGTH).nullable().optional(),
  provider_agent_key: z.string().max(PROVIDER_AGENT_KEY_MAX_LENGTH).nullable().optional(),
  subagent_identity_key: z.string().max(SUBAGENT_IDENTITY_KEY_MAX_LENGTH).nullable().optional(),
  model: z.string().max(SUBAGENT_METADATA_MAX_LENGTH).nullable().optional(),
  reasoning_effort: z.string().max(SUBAGENT_METADATA_MAX_LENGTH).nullable().optional(),
  input_summary: z.string(),
  output_summary: z.string(),
  output_truncated: z.number().int().optional(),
  output_total_bytes: z.number().nullable().optional(),
  output_artifact_path: z.string().nullable().optional(),
  exit_code: z.number().int().nullable().optional(),
  status: ToolCallStatusSchema,
  started_at: z.string(),
  completed_at: z.string().nullable(),
  sort_order: z.number(),
});

/** Persisted tool call record linked to an assistant message. */
export type ToolCallRecord = z.infer<typeof ToolCallRecordSchema>;
