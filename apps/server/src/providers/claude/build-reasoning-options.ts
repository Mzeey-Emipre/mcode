import type { ReasoningLevel } from "@mcode/contracts";

/** Options added to the SDK query when reasoning is enabled. */
export interface ReasoningOptions {
  /** Reasoning effort level passed to the SDK. */
  effort?: ReasoningLevel;
  /** Thinking mode — adaptive lets the model decide internally how much to reason. */
  thinking?: { type: "adaptive" };
}

/**
 * Build the SDK reasoning options from a reasoning level.
 * Returns an empty object when reasoning is disabled (level is undefined).
 */
export function buildReasoningOptions(
  reasoningLevel: ReasoningLevel | undefined,
): ReasoningOptions {
  if (reasoningLevel === undefined) return {};
  return {
    effort: reasoningLevel,
    thinking: { type: "adaptive" },
  };
}
