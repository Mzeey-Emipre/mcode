import type { ToolCall } from "@/transport";
import { coerceTaskStatus, type TaskItem } from "../taskStore";

function firstNonEmptyText(source: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return "";
}

function taskContent(entry: unknown): string {
  const item = typeof entry === "object" && entry !== null
    ? entry as Record<string, unknown>
    : { step: entry };
  return firstNonEmptyText(item, ["step", "content", "title", "description"]);
}

function agentDescription(toolInput: Record<string, unknown>): unknown {
  return toolInput.description ?? toolInput.prompt;
}

/** Resolves the nearest parent agent description for a task group. */
export function resolveAgentGroupLabel(
  toolCalls: readonly ToolCall[],
  parentToolCallId: string,
): string {
  let current: string | undefined = parentToolCallId;
  while (current) {
    const toolCall = toolCalls.find((call) => call.id === current);
    if (!toolCall) break;
    if (toolCall.toolName !== "Agent") {
      current = toolCall.parentToolCallId;
      continue;
    }
    const description = agentDescription(toolCall.toolInput ?? {});
    if (typeof description !== "string" || description.length === 0) return "Sub-agent";
    return description.length > 80 ? `${description.slice(0, 77)}...` : description;
  }
  return "Sub-agent";
}

/** Formats a TaskCreate input into one display line. */
export function taskTextFromToolInput(toolInput: Record<string, unknown>): string | null {
  const subject = firstNonEmptyText(toolInput, ["subject", "title", "content"]);
  const description = firstNonEmptyText(toolInput, ["description"]);
  if (subject.length === 0) return description || null;
  if (description.length === 0) return subject;
  return `${subject} - ${description}`;
}

function planEntries(toolInput: Record<string, unknown>): unknown[] {
  for (const key of ["plan", "tasks", "todos"]) {
    const value = toolInput[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function projectedTask(entry: unknown, index: number): TaskItem | null {
  const item = typeof entry === "object" && entry !== null
    ? entry as Record<string, unknown>
    : { step: entry };
  const content = taskContent(item);
  if (content.length === 0) return null;
  return {
    id: item.id != null ? String(item.id) : String(index),
    content,
    status: coerceTaskStatus(item.status),
    group: "Tasks",
  };
}

/** Projects provider update_plan input into renderable task items. */
export function updatePlanTasksFromToolInput(toolInput: Record<string, unknown>): TaskItem[] {
  return planEntries(toolInput)
    .map(projectedTask)
    .filter((task): task is TaskItem => task !== null);
}
