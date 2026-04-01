import type { ReasoningLevel } from "@mcode/contracts";

/** Options added to the SDK query when reasoning is enabled. */
export interface ReasoningOptions {
  effort?: ReasoningLevel;
  thinking?: { type: "adaptive" };
}

/**
 * Build the SDK reasoning options from a reasoning level.
 * Returns an empty object when reasoning is disabled (level is undefined).
 */
export function buildReasoningOptions(
  reasoningLevel: ReasoningLevel | undefined,
): ReasoningOptions {
  if (reasoningLevel == null) return {};
  return {
    effort: reasoningLevel,
    thinking: { type: "adaptive" },
  };
}
