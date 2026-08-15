import { resolveModelDisplayLabel } from "@/lib/format-model-label";
import type { ToolCall } from "@/transport/types";

/**
 * Labels for Cursor `subagentType` objects on Task delegations.
 * Unknown shapes are omitted so we do not show noisy JSON in the UI.
 */
function formatSubagentTypeLabel(subagentType: unknown): string | undefined {
  if (subagentType == null || typeof subagentType !== "object") return undefined;
  const rec = subagentType as Record<string, unknown>;
  if ("custom" in rec && rec.custom != null && typeof rec.custom === "object") {
    const custom = rec.custom as Record<string, unknown>;
    if ("unspecified" in custom) return "Task";
    const keys = Object.keys(custom);
    if (keys.length === 1) return keys[0];
  }
  return undefined;
}

/** Human label for Codex collab kind metadata. */
function formatCodexKindLabel(kind: unknown): string | undefined {
  if (typeof kind !== "string") return undefined;
  const normalized = kind.trim();
  if (!normalized) return undefined;
  if (normalized === "spawnAgent" || normalized === "spawn_agent") return "Spawn agent";
  if (normalized === "wait") return "Wait";
  return normalized
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (ch) => ch.toUpperCase());
}

/** Human label for Codex reasoning effort metadata. */
function formatReasoningEffortLabel(effort: unknown): string | undefined {
  if (typeof effort !== "string") return undefined;
  const normalized = effort.trim();
  if (!normalized) return undefined;
  return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)} effort`;
}

/**
 * Builds short delegation tags for a sub-agent row (task kind and model).
 *
 * @param toolCall - Agent tool call with `cursor/task` metadata in `toolInput`.
 */
export function buildDelegationTags(toolCall: ToolCall): string[] {
  const tags: string[] = [];
  const input = toolCall.toolInput;

  const typeLabel = formatSubagentTypeLabel(input.subagentType);
  const codexKindLabel = formatCodexKindLabel(input.codexCollabKind);
  if (typeLabel) tags.push(typeLabel);
  if (codexKindLabel) tags.push(codexKindLabel);

  if (typeof input.model === "string" && input.model.trim().length > 0) {
    tags.push(resolveModelDisplayLabel(input.model));
  }

  const reasoningEffortLabel = formatReasoningEffortLabel(input.reasoningEffort);
  if (reasoningEffortLabel) tags.push(reasoningEffortLabel);

  return tags;
}
