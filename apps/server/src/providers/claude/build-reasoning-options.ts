import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { ReasoningLevel } from "@mcode/contracts";
import { logger } from "@mcode/shared";

/** Model IDs that support the "max" reasoning effort level. */
const MAX_EFFORT_MODEL_IDS: readonly string[] = ["claude-opus-4-7", "claude-opus-4-6"];

/** Model IDs that support the "xhigh" reasoning effort level. */
const XHIGH_EFFORT_MODEL_IDS: readonly string[] = ["claude-opus-4-7"];

/**
 * Build the SDK reasoning options from a reasoning level and model ID.
 * Clamps unsupported levels down to "high", emitting a warning when this
 * normalization occurs. Returns an empty object when reasoning is disabled.
 */
export function buildReasoningOptions(
  reasoningLevel: ReasoningLevel | undefined,
  modelId: string,
): Pick<Options, "effort" | "thinking"> {
  if (reasoningLevel === undefined) return {};

  let level: ReasoningLevel = reasoningLevel;

  if (level === "xhigh" && !XHIGH_EFFORT_MODEL_IDS.includes(modelId)) {
    logger.warn("xhigh reasoning effort not supported for model, clamping to high", {
      modelId,
    });
    level = "high";
  }

  if (level === "max" && !MAX_EFFORT_MODEL_IDS.includes(modelId)) {
    logger.warn("Max reasoning effort not supported for model, clamping to high", {
      modelId,
    });
    level = "high";
  }

  return {
    // SDK EffortLevel doesn't include "xhigh" yet; the API accepts it
    effort: level as Exclude<ReasoningLevel, "xhigh">,
    thinking: { type: "adaptive" },
  };
}
