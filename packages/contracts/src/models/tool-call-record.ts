import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";

/** Maximum persisted length of a sub-agent display identity. */
export const SUBAGENT_DISPLAY_NAME_MAX_LENGTH = 96;
/** Maximum persisted length of an explicit provider logical-agent key. */
export const PROVIDER_AGENT_KEY_MAX_LENGTH = 256;
/** Maximum persisted length of provider model and reasoning metadata. */
export const SUBAGENT_METADATA_MAX_LENGTH = 128;
/** Maximum persisted length of a provider-reported sub-agent prompt. */
export const SUBAGENT_PROMPT_MAX_LENGTH = 4_000;
/** Maximum provider-reported sub-agent duration retained in milliseconds. */
export const SUBAGENT_DURATION_MAX_MS = 86_400_000;
/** Maximum accepted length of a sub-agent navigation identity. */
export const SUBAGENT_IDENTITY_KEY_MAX_LENGTH = 512;
/** Prefix reserved for server-written canonical child transcript targets. */
export const CANONICAL_SUBAGENT_DETAIL_STORAGE_PREFIX = "mcode:subagent:v1:child:";
/** Prefix reserved for server-written provider-native navigation aliases. */
export const SUBAGENT_ALIAS_DETAIL_STORAGE_PREFIX = "mcode:subagent:v1:alias:";
/** Maximum durable child thread ID that fits in the existing identity column. */
export const SUBAGENT_CANONICAL_THREAD_ID_MAX_LENGTH = SUBAGENT_IDENTITY_KEY_MAX_LENGTH
  - CANONICAL_SUBAGENT_DETAIL_STORAGE_PREFIX.length;
/** Maximum provider-native alias that fits in the existing identity column. */
export const SUBAGENT_ALIAS_IDENTITY_MAX_LENGTH = SUBAGENT_IDENTITY_KEY_MAX_LENGTH
  - SUBAGENT_ALIAS_DETAIL_STORAGE_PREFIX.length;

function explicitString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function boundedCanonicalSubagentThreadId(childThreadId: string): string {
  const canonicalThreadId = explicitString(childThreadId);
  if (!canonicalThreadId || canonicalThreadId.length > SUBAGENT_CANONICAL_THREAD_ID_MAX_LENGTH) {
    throw new Error("Canonical child thread ID must be a bounded non-empty string");
  }
  return canonicalThreadId;
}

function boundedSubagentAliasIdentityKey(identityKey: string): string {
  const aliasIdentityKey = explicitString(identityKey);
  if (!aliasIdentityKey || aliasIdentityKey.length > SUBAGENT_ALIAS_IDENTITY_MAX_LENGTH) {
    throw new Error("Subagent alias identity must fit in the persisted identity column");
  }
  return aliasIdentityKey;
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

/** Resolves one bounded provider-reported sub-agent prompt. */
export function resolveSubagentPrompt(value: unknown): string | undefined {
  const prompt = explicitString(value);
  return prompt && prompt.length <= SUBAGENT_PROMPT_MAX_LENGTH ? prompt : undefined;
}

/** Resolves one bounded provider-reported sub-agent duration. */
export function resolveSubagentDuration(value: unknown): number | undefined {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= SUBAGENT_DURATION_MAX_MS
    ? value
    : undefined;
}

/** Resolves the exact receiver/native child identity from structural Agent input. */
export function resolveSubagentExactIdentity(input: Record<string, unknown>): string | undefined {
  const receiverThreadId = resolveReceiverThreadId(input);
  if (receiverThreadId) return receiverThreadId;
  const nativeThreadId = explicitString(input.nativeThreadId);
  return nativeThreadId && nativeThreadId.length <= SUBAGENT_ALIAS_IDENTITY_MAX_LENGTH
    ? nativeThreadId
    : undefined;
}

/** Formats a normalized sub-agent identity as a sentence-style title. */
export function formatSubagentDisplayName(identity: string): string {
  const sentence = identity.trim().replace(/_+/g, " ").replace(/\s+/g, " ");
  if (sentence.length === 0) return "Subagent";
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}`;
}

/** Detail availability for one provider-reported sub-agent. */
export const SubagentDetailSchema = lazySchema(() => z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("canonical-child"),
    /** Durable Mcode thread ID used to open this child's transcript. */
    threadId: z.string().min(1).max(SUBAGENT_CANONICAL_THREAD_ID_MAX_LENGTH),
  }),
  z.object({
    kind: z.literal("canonical-alias"),
    /** Provider-native identity resolved by the Subagents roster. */
    identityKey: z.string().min(1).max(SUBAGENT_ALIAS_IDENTITY_MAX_LENGTH),
  }),
  z.object({
    kind: z.literal("transcript-unavailable"),
    providerName: z.string().min(1).max(SUBAGENT_METADATA_MAX_LENGTH).optional(),
  }),
]));

/** Detail availability for one provider-reported sub-agent. */
export type SubagentDetail = z.infer<ReturnType<typeof SubagentDetailSchema>>;

/** Presentation model consumed by sub-agent UI surfaces. */
export const SubagentPresentationSchema = lazySchema(() => z.object({
  displayName: z.string().min(1).max(SUBAGENT_DISPLAY_NAME_MAX_LENGTH),
  task: z.string().max(SUBAGENT_PROMPT_MAX_LENGTH).optional(),
  hasExplicitIdentity: z.boolean(),
  identityKey: z.string().min(1).max(SUBAGENT_IDENTITY_KEY_MAX_LENGTH),
  detail: SubagentDetailSchema(),
  providerAgentKey: z.string().max(PROVIDER_AGENT_KEY_MAX_LENGTH).optional(),
  model: z.string().max(SUBAGENT_METADATA_MAX_LENGTH).optional(),
  reasoningEffort: z.string().max(SUBAGENT_METADATA_MAX_LENGTH).optional(),
}));

/** Presentation model consumed by sub-agent UI surfaces. */
export type SubagentPresentation = z.infer<ReturnType<typeof SubagentPresentationSchema>>;

/** Encodes a server-authoritative child target for the legacy identity column. */
export function encodeCanonicalSubagentDetailTarget(childThreadId: string): string {
  return `${CANONICAL_SUBAGENT_DETAIL_STORAGE_PREFIX}${boundedCanonicalSubagentThreadId(childThreadId)}`;
}

/** Decodes only canonical child targets written by this version of Mcode. */
export function decodeCanonicalSubagentDetailTarget(value: string | null | undefined): string | undefined {
  if (!value?.startsWith(CANONICAL_SUBAGENT_DETAIL_STORAGE_PREFIX)) return undefined;
  const canonicalThreadId = explicitString(value.slice(CANONICAL_SUBAGENT_DETAIL_STORAGE_PREFIX.length));
  return canonicalThreadId && canonicalThreadId.length <= SUBAGENT_CANONICAL_THREAD_ID_MAX_LENGTH
    ? canonicalThreadId
    : undefined;
}

/** Encodes a provider-native alias for the legacy identity column. */
export function encodeSubagentAliasDetailTarget(identityKey: string): string {
  return `${SUBAGENT_ALIAS_DETAIL_STORAGE_PREFIX}${boundedSubagentAliasIdentityKey(identityKey)}`;
}

/** Decodes only provider-native aliases written by this version of Mcode. */
export function decodeSubagentAliasDetailTarget(value: string | null | undefined): string | undefined {
  if (!value?.startsWith(SUBAGENT_ALIAS_DETAIL_STORAGE_PREFIX)) return undefined;
  const identityKey = explicitString(value.slice(SUBAGENT_ALIAS_DETAIL_STORAGE_PREFIX.length));
  return identityKey && identityKey.length <= SUBAGENT_ALIAS_IDENTITY_MAX_LENGTH
    ? identityKey
    : undefined;
}

/** Adds a server-authoritative canonical child transcript target to a presentation. */
export function createCanonicalSubagentPresentation(
  input: Record<string, unknown>,
  fallbackIdentityKey: string,
  childThreadId: string,
): SubagentPresentation {
  return {
    ...createSubagentPresentation(input, fallbackIdentityKey),
    detail: { kind: "canonical-child", threadId: boundedCanonicalSubagentThreadId(childThreadId) },
  };
}

function resolveReceiverThreadId(input: Record<string, unknown>): string | undefined {
  if (!Array.isArray(input.receiverThreadIds) || input.receiverThreadIds.length !== 1) return undefined;
  const receiverThreadId = explicitString(input.receiverThreadIds[0]);
  return receiverThreadId && receiverThreadId.length <= SUBAGENT_ALIAS_IDENTITY_MAX_LENGTH
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
  const task = resolveSubagentPrompt(input.description) ?? resolveSubagentPrompt(input.prompt);
  const exactIdentity = resolveSubagentExactIdentity(input);
  const providerName = resolveSubagentMetadata(input.subagentProviderName);
  return {
    displayName: formatSubagentDisplayName(resolvedDisplayName ?? "Subagent"),
    ...(task ? { task } : {}),
    hasExplicitIdentity: resolvedDisplayName !== undefined,
    identityKey: exactIdentity ?? providerAgentKey ?? fallbackIdentityKey,
    detail: createSubagentDetail(exactIdentity, providerName),
    ...(providerAgentKey ? { providerAgentKey } : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

function createSubagentDetail(
  exactIdentity: string | undefined,
  providerName: string | undefined,
): SubagentDetail {
  if (exactIdentity) return { kind: "canonical-alias", identityKey: exactIdentity };
  return {
    kind: "transcript-unavailable",
    ...(providerName ? { providerName } : {}),
  };
}

function mergeSubagentDetail(
  current: SubagentDetail,
  incoming: SubagentDetail,
): SubagentDetail {
  if (current.kind === "canonical-child") return current;
  if (incoming.kind === "canonical-child") return incoming;
  if (current.kind === "canonical-alias") return current;
  if (incoming.kind === "canonical-alias") return incoming;
  return incoming.providerName ? incoming : current;
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
    task: incoming.task ?? current.task,
    hasExplicitIdentity: current.hasExplicitIdentity || incoming.hasExplicitIdentity,
    identityKey: incoming.identityKey === fallbackIdentityKey ? current.identityKey : incoming.identityKey,
    detail: mergeSubagentDetail(current.detail, incoming.detail),
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
export const ToolCallRecordSchema = lazySchema(() => z.object({
  id: z.string(),
  message_id: z.string(),
  parent_tool_call_id: z.string().nullable(),
  tool_name: z.string(),
  display_name: z.string().max(SUBAGENT_DISPLAY_NAME_MAX_LENGTH).nullable().optional(),
  provider_agent_key: z.string().max(PROVIDER_AGENT_KEY_MAX_LENGTH).nullable().optional(),
  subagent_identity_key: z.string().max(SUBAGENT_IDENTITY_KEY_MAX_LENGTH).nullable().optional(),
  subagent_provider_name: z.string().max(SUBAGENT_METADATA_MAX_LENGTH).nullable().optional(),
  subagent_prompt: z.string().max(SUBAGENT_PROMPT_MAX_LENGTH).nullable().optional(),
  subagent_type: z.string().max(SUBAGENT_METADATA_MAX_LENGTH).nullable().optional(),
  subagent_agent_id: z.string().max(SUBAGENT_METADATA_MAX_LENGTH).nullable().optional(),
  subagent_duration_ms: z.number().int().min(0).max(SUBAGENT_DURATION_MAX_MS).nullable().optional(),
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
}));

/** Persisted tool call record linked to an assistant message. */
export type ToolCallRecord = z.infer<ReturnType<typeof ToolCallRecordSchema>>;
