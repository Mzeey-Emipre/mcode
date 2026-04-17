import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { ReasoningLevel } from "@mcode/contracts";
import {
  logger,
  normalizeReasoningLevelForModel,
  supportsEffortParameter,
} from "@mcode/shared";

/**
 * Build the SDK reasoning options from a reasoning level and model ID.
 *
 * Delegates normalization to the shared tier-ladder helper. Haiku 4.5
 * and other effort-unsupported models get an empty return (no `effort` field)
 * because the Claude SDK rejects the effort parameter for those models.
 * Emits a warning when the level is clamped.
 */
export function buildReasoningOptions(
  reasoningLevel: ReasoningLevel | undefined,
  modelId: string,
): Pick<Options, "effort" | "thinking"> {
  if (reasoningLevel === undefined) return {};

  // Haiku and future no-effort models: omit the effort field entirely.
  // The SDK rejects the field for these models rather than ignoring it.
  if (!supportsEffortParameter(modelId)) return {};

  const normalized = normalizeReasoningLevelForModel(modelId, reasoningLevel);
  if (normalized !== reasoningLevel) {
    logger.warn("Reasoning level clamped for model", {
      modelId,
      requested: reasoningLevel,
      effective: normalized,
    });
  }

  return {
    // "xhigh" is valid for claude-opus-4-7; the SDK's EffortLevel union does not
    // include "xhigh" yet, so we cast to any to avoid a compile-time rejection.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    effort: normalized as any,
    thinking: { type: "adaptive" },
  };
}
