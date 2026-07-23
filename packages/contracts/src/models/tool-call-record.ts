import { z } from "zod";

/** Maximum persisted length of a sub-agent display identity. */
export const SUBAGENT_DISPLAY_NAME_MAX_LENGTH = 96;
/** Maximum persisted length of an explicit provider logical-agent key. */
export const PROVIDER_AGENT_KEY_MAX_LENGTH = 256;

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
