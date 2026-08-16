/**
 * Heuristics for treating Cursor CLI / ACP tool calls as Mcode `Agent` delegations.
 *
 * Claude's Agent SDK emits a literal `Agent` tool name. Cursor's stream-json and ACP
 * layers use Cursor-specific discriminators and titles; mapping them to `Agent`
 * keeps `agent-service` nesting, `parentToolCallId` enrichment, and narrative
 * subagent rows consistent across providers.
 */

/**
 * Returns true when a stream-json or rawInput discriminator should be treated as a
 * delegated subagent (top-level `toolName: "Agent"` in {@link AgentEvent}).
 */
export function isCursorSubagentDelegationDiscriminator(
  discriminator: string | null | undefined,
): boolean {
  if (!discriminator) return false;
  const d = discriminator.toLowerCase();
  if (!d.endsWith("toolcall")) return false;
  if (d.includes("subagent")) return true;
  if (d.includes("delegate")) return true;
  /** Explore-style codebase subagents use this pattern in recent cursor-agent builds. */
  if (d.includes("explore")) return true;
  if (d.includes("browser")) return true;
  return false;
}

/**
 * Returns true when an ACP `title` hints at a built-in Cursor subagent delegation.
 */
export function isCursorSubagentDelegationTitle(title: string | null | undefined): boolean {
  if (!title) return false;
  const t = title.trim().toLowerCase();
  if (t === "explore") return true;
  if (t.startsWith("explore ")) return true;
  if (t.includes("subagent")) return true;
  if (t.includes("sub-agent")) return true;
  if (t.includes("delegate")) return true;
  return false;
}

/**
 * Reads an optional parent tool call id from Cursor payloads.
 * Field names vary across stream-json and ACP SDK revisions.
 *
 * @param source - ACP `session/update` object or stream-json line object.
 */
export function extractCursorParentToolCallId(source: Record<string, unknown>): string | undefined {
  const keys = [
    "parentToolCallId",
    "parent_tool_call_id",
    "parentCallId",
    "parent_call_id",
    "parentId",
  ] as const;
  for (const key of keys) {
    const v = source[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/**
 * If this tool should render as Mcode's `Agent` row, returns `Agent`; otherwise
 * returns {@link resolvedToolName} unchanged.
 *
 * @param resolvedToolName - Name from kind / title / discriminator maps.
 * @param discriminator - First `*ToolCall` key from rawInput, when present.
 * @param title - ACP tool title string, when present.
 */
export function resolveCursorSubagentToolName(
  resolvedToolName: string,
  discriminator: string | null | undefined,
  title: string | null | undefined,
): string {
  if (isCursorSubagentDelegationDiscriminator(discriminator)) return "Agent";
  if (isCursorSubagentDelegationTitle(title)) return "Agent";
  return resolvedToolName;
}
