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

function textInput(toolCall: ToolCall, key: "description" | "prompt"): string {
  const value = toolCall.toolInput[key];
  return typeof value === "string" ? value.trim() : "";
}

function specificDescription(description: string): string {
  return isGenericDescription(description) ? "" : description;
}

function completedOutputDescription(toolCall: ToolCall): string {
  if (!toolCall.isComplete || typeof toolCall.output !== "string") return "";
  return truncateNarrative(firstMeaningfulLine(toolCall.output));
}

function fallbackDescription(toolCall: ToolCall, description: string): string {
  return toolCall.isComplete ? description || "Subagent task" : "Running subagent";
}

/**
 * Primary label for a sub-agent row, aligned with Claude {@link AgentRenderer}.
 *
 * Prefers task metadata over final output so completed rows keep a stable task
 * label while the result renders in the expanded body.
 */
export function extractSubagentDescription(toolCall: ToolCall): string {
  const description = textInput(toolCall, "description");
  const specific = specificDescription(description);
  if (specific) return specific;

  const prompt = textInput(toolCall, "prompt");
  if (prompt) return truncateNarrative(prompt);

  const output = completedOutputDescription(toolCall);
  return output || fallbackDescription(toolCall, description);
}
