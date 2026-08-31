import type { ToolCall } from "@/transport/types";

function directCommand(toolCall: ToolCall): string | undefined {
  const command = toolCall.toolInput.command;
  return typeof command === "string" && command.trim().length > 0
    ? command
    : undefined;
}

function commandFromJson(summary: string): string | undefined {
  if (!summary.startsWith("{")) return undefined;

  try {
    const parsed: unknown = JSON.parse(summary);
    if (
      parsed !== null
      && typeof parsed === "object"
      && "command" in parsed
      && typeof parsed.command === "string"
    ) {
      return parsed.command;
    }
  } catch {
    // Older persisted summaries can end in the middle of JSON.
  }

  return undefined;
}

function commandFromLegacySummary(summary: string): string | undefined {
  const prefix = '{"command":"';
  if (!summary.startsWith(prefix)) return undefined;

  const escapedCommand = summary.slice(prefix.length).replace(/"}$/, "");
  const escapedSlash = "\u0000";
  return escapedCommand
    .replace(/\\\\/g, escapedSlash)
    .replace(/\\"/g, '"')
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\\//g, "/")
    .split(escapedSlash)
    .join("\\");
}

/** Extracts the command text from a live or persisted shell tool call. */
export function extractNarrativeCommand(toolCall: ToolCall): string {
  const command = directCommand(toolCall);
  if (command !== undefined) return command;

  const summary = toolCall.toolInput._summary ?? toolCall.toolInput.summary;
  if (typeof summary !== "string") return "";

  const trimmed = summary.trim();
  return commandFromJson(trimmed)
    ?? commandFromLegacySummary(trimmed)
    ?? summary;
}
