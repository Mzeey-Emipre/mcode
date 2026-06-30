/** Parsed result from Claude Code's native `/goal` command response. */
export type ClaudeGoalCommandParseResult =
  | { kind: "active"; objective: string }
  | { kind: "cleared"; objective: string }
  | { kind: "empty" }
  | { kind: "unavailable" };

const ACTIVE_PREFIX = "Goal active: ";
const CLEARED_PREFIX = "Goal cleared: ";
const UNAVAILABLE_TEXT = "/goal isn't available in this environment.";

/** Minimal shape of the Claude SDK result record needed to prove a slash-command response. */
export interface ClaudeGoalCommandResultRecord {
  readonly type?: unknown;
  readonly num_turns?: unknown;
}

/**
 * Parses only observed synthetic Claude Code `/goal` command output.
 *
 * Native slash-command responses are authoritative only when paired with a
 * `result` record whose `num_turns` is zero. Ordinary assistant text, Stop-hook
 * feedback, and normal model turns must fail closed.
 */
export function parseClaudeGoalCommandResult(
  assistantText: string | null | undefined,
  result: ClaudeGoalCommandResultRecord | null | undefined,
): ClaudeGoalCommandParseResult | null {
  if (typeof assistantText !== "string") return null;
  if (result?.type !== "result" || result.num_turns !== 0) return null;

  const text = assistantText.trim();
  if (text.startsWith(ACTIVE_PREFIX)) {
    const raw = text.slice(ACTIVE_PREFIX.length).trim();
    const objective = raw.endsWith(" (not yet evaluated)")
      ? raw.slice(0, -" (not yet evaluated)".length).trim()
      : raw;
    return objective.length > 0 ? { kind: "active", objective } : null;
  }

  if (text.startsWith(CLEARED_PREFIX)) {
    const objective = text.slice(CLEARED_PREFIX.length).trim();
    return { kind: "cleared", objective };
  }

  if (text.startsWith("No goal set")) {
    return { kind: "empty" };
  }

  if (text === UNAVAILABLE_TEXT) {
    return { kind: "unavailable" };
  }

  return null;
}
