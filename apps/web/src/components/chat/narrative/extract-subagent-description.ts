import type { ToolCall } from "@/transport/types";

const GENERIC_DESCRIPTIONS = new Set([
  "subagent task",
  "delegated task",
]);

function isGenericDescription(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized.length === 0 || GENERIC_DESCRIPTIONS.has(normalized);
}

function truncateNarrative(text: string, maxLen = 80): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLen) return trimmed;
  return `${trimmed.slice(0, maxLen)}…`;
}

function firstMeaningfulLine(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? "";
}

/**
 * Primary label for a sub-agent row, aligned with Claude {@link AgentRenderer}.
 *
 * Prefers `description` from `cursor/task` metadata. When Cursor only sends the
 * generic Task title during the run, falls back to a truncated `prompt` once
 * enrichment arrives, then a short running placeholder.
 */
export function extractSubagentDescription(toolCall: ToolCall): string {
  const input = toolCall.toolInput;
  const description =
    typeof input.description === "string" ? input.description.trim() : "";
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  const output = typeof toolCall.output === "string"
    ? firstMeaningfulLine(toolCall.output)
    : "";

  if (toolCall.isComplete && output) {
    return truncateNarrative(output);
  }
  if (description && !isGenericDescription(description)) {
    return description;
  }
  if (prompt) return truncateNarrative(prompt);
  if (!toolCall.isComplete) return "Running subagent";
  return description || "Subagent task";
}
