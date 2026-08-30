import type { ToolCall } from "@/transport/types";
import type { NarrativeItem, NarrativeCounts, SubagentActivity } from "./types";

/** Provider tool name for delegated sub-agent work. */
export const AGENT_TOOL_NAME = "Agent";

/** Top-level calls and direct children indexed by their authoritative parent id. */
export interface ToolCallHierarchy<T> {
  topLevel: T[];
  childrenByParent: Map<string, T[]>;
}

/** Splits calls into top-level calls and direct children without changing input order. */
export function buildToolCallHierarchy<T>(
  calls: readonly T[],
  parentIdForCall: (call: T) => string | null | undefined,
  emptyParentIsTopLevel: boolean,
): ToolCallHierarchy<T> {
  const topLevel: T[] = [];
  const childrenByParent = new Map<string, T[]>();

  for (const call of calls) {
    const parentId = parentIdForCall(call);
    if (parentId == null || (emptyParentIsTopLevel && parentId.length === 0)) {
      topLevel.push(call);
      continue;
    }
    const siblings = childrenByParent.get(parentId) ?? [];
    siblings.push(call);
    childrenByParent.set(parentId, siblings);
  }

  return { topLevel, childrenByParent };
}

/** Builds a grouped row for one contiguous sequence of completed tool calls. */
export function createToolGroupItem(
  calls: readonly ToolCall[],
): Extract<NarrativeItem, { type: "tool-group" }> | undefined {
  if (calls.length === 0) return undefined;
  return {
    type: "tool-group",
    group: { calls: [...calls] },
    hasError: calls.some((call) => call.isError),
    hasCancelled: calls.some(isCancelledCall),
  };
}

/** Builds one sub-agent row from one or more contiguous sibling activities. */
export function createSubagentItem(
  activities: readonly SubagentActivity[],
): Extract<NarrativeItem, { type: "subagent" }> {
  const firstActivity = activities[0]!;
  return {
    type: "subagent",
    ...firstActivity,
    ...(activities.length > 1 ? { activities } : {}),
  };
}

/** Derives the top-level tool, thought-row, and delegated-agent totals. */
export function createNarrativeCounts(
  topLevelCalls: readonly ToolCall[],
  items: readonly NarrativeItem[],
): NarrativeCounts {
  return {
    steps: topLevelCalls.length,
    thoughts: items.filter((item) => item.type === "thought").length,
    subagents: topLevelCalls.filter((call) => call.toolName === AGENT_TOOL_NAME).length,
  };
}

function isCancelledCall(call: ToolCall): boolean {
  return call.isCancelled === true
    || (typeof call.output === "string" && call.output.toLowerCase().includes("cancelled"));
}
