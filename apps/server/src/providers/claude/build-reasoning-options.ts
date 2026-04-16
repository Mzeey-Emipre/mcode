import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { ReasoningLevel } from "@mcode/contracts";
import { logger } from "@mcode/shared";

/** Model IDs that support the "max" reasoning effort level. */
const MAX_EFFORT_MODEL_IDS: readonly string[] = ["claude-opus-4-7", "claude-opus-4-6"];

/** Model IDs that support the "xhigh" reasoning effort level. */
const XHIGH_EFFORT_MODEL_IDS: readonly string[] = ["claude-opus-4-7"];

/**
 * Strips a dated suffix from a Claude model ID, returning the base ID.
 * The Claude SDK returns dated variants (e.g. "claude-opus-4-7-20260401")
 * in session metadata; normalize these before capability checks.
 */
function normalizeModelId(modelId: string): string {
  const allIds = [...MAX_EFFORT_MODEL_IDS, ...XHIGH_EFFORT_MODEL_IDS];
  return allIds.find((base) => modelId.startsWith(`${base}-`)) ?? modelId;
}

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

  const baseModelId = normalizeModelId(modelId);
  let level: ReasoningLevel = reasoningLevel;

  if (level === "xhigh" && !XHIGH_EFFORT_MODEL_IDS.includes(baseModelId)) {
    logger.warn("xhigh reasoning effort not supported for model, clamping to high", {
      modelId,
    });
    level = "high";
  }

  if (level === "max" && !MAX_EFFORT_MODEL_IDS.includes(baseModelId)) {
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
