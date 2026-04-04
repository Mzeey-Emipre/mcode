import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { ReasoningLevel } from "@mcode/contracts";
import { logger } from "@mcode/shared";

/** Model IDs that support the "max" reasoning effort level. */
const MAX_EFFORT_MODEL_IDS: readonly string[] = ["claude-opus-4-6"];

/**
 * Build the SDK reasoning options from a reasoning level and model ID.
 * Clamps "max" to "high" for models that do not support the max effort tier,
 * emitting a warning when this normalization occurs.
 * Returns an empty object when reasoning is disabled (level is undefined).
 */
export function buildReasoningOptions(
  reasoningLevel: ReasoningLevel | undefined,
  modelId: string,
): Pick<Options, "effort" | "thinking"> {
  if (reasoningLevel === undefined) return {};

  let level: ReasoningLevel = reasoningLevel;
  if (level === "max" && !MAX_EFFORT_MODEL_IDS.includes(modelId)) {
    logger.warn("Max reasoning effort not supported for model, clamping to high", {
      modelId,
    });
    level = "high";
  }
  // "xhigh" is a Codex-only level; Claude SDK does not accept it
  if (level === "xhigh") {
    level = "high";
  }

  return {
    effort: level as Exclude<ReasoningLevel, "xhigh">,
    thinking: { type: "adaptive" },
  };
}
