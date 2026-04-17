/**
 * Model effort normalization utilities.
 *
 * Maps Claude model IDs to the reasoning level tiers they actually support,
 * and downgrades any requested level to the highest tier the model accepts.
 * This prevents the SDK from receiving unsupported effort values at runtime.
 */

import type { ReasoningLevel } from "@mcode/contracts";

// Ordered lowest to highest. Walking DOWN from a disallowed tier finds the best
// supported level without silently escalating effort.
const TIER_LADDER: readonly ReasoningLevel[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Claude model IDs that support the "xhigh" effort tier. */
const XHIGH_EFFORT_MODEL_IDS: readonly string[] = ["claude-opus-4-7"];

/** Claude model IDs that support the "max" effort tier. */
const MAX_EFFORT_MODEL_IDS: readonly string[] = [
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
];

/** Claude model IDs that do NOT support the effort parameter at all. */
const EFFORT_UNSUPPORTED_CLAUDE_IDS: readonly string[] = ["claude-haiku-4-5"];

// All known base IDs, used for dated-variant normalization.
const ALL_KNOWN_BASE_IDS: readonly string[] = [
  ...new Set([
    ...XHIGH_EFFORT_MODEL_IDS,
    ...MAX_EFFORT_MODEL_IDS,
    ...EFFORT_UNSUPPORTED_CLAUDE_IDS,
  ]),
];

/**
 * Strip a date suffix (e.g. `-20260501`) from a Claude model ID to get the base ID.
 *
 * Dated variants like `claude-opus-4-7-20260501` are functionally identical to
 * their base, so capability checks must treat them the same way.
 */
function normalizeModelId(modelId: string): string {
  for (const baseId of ALL_KNOWN_BASE_IDS) {
    if (modelId === baseId || modelId.startsWith(baseId + "-")) {
      return baseId;
    }
  }
  return modelId;
}

/**
 * Returns true when the model supports the "xhigh" effort tier.
 *
 * Only `claude-opus-4-7` (and its dated variants) expose this tier.
 */
export function isXhighEffortModel(modelId: string): boolean {
  return (XHIGH_EFFORT_MODEL_IDS as string[]).includes(normalizeModelId(modelId));
}

/**
 * Returns true when the model supports the "max" effort tier.
 *
 * Applies to the opus-4-7, opus-4-6, and sonnet-4-6 families.
 */
export function isMaxEffortModel(modelId: string): boolean {
  return (MAX_EFFORT_MODEL_IDS as string[]).includes(normalizeModelId(modelId));
}

/**
 * Returns false when the model does not accept the effort parameter at all.
 *
 * Haiku-class models ignore effort; sending it causes API errors.
 * Unknown models default to true because most Claude models do support effort.
 * Codex models are handled by the caller and are never passed here.
 */
export function supportsEffortParameter(modelId: string): boolean {
  return !(EFFORT_UNSUPPORTED_CLAUDE_IDS as string[]).includes(
    normalizeModelId(modelId),
  );
}

/**
 * Normalize a requested reasoning level to the highest tier the model actually supports.
 *
 * - Models with no effort support always return "high" (the effort param is omitted
 *   by the caller; "high" is a safe stored enum value that won't be forwarded to the SDK).
 * - Otherwise, the function walks DOWN the tier ladder from the requested level until
 *   it finds a tier in the model's allowed set. Walking up is never done -- silently
 *   escalating effort would violate user intent and increase cost.
 */
export function normalizeReasoningLevelForModel(
  modelId: string,
  level: ReasoningLevel,
): ReasoningLevel {
  // Short-circuit for models that don't accept the effort param at all.
  if (!supportsEffortParameter(modelId)) {
    return "high";
  }

  // Build the set of tiers this model supports.
  const allowed = new Set<ReasoningLevel>(["low", "medium", "high"]);
  if (isMaxEffortModel(modelId)) {
    allowed.add("max");
  }
  if (isXhighEffortModel(modelId)) {
    allowed.add("xhigh");
  }

  if (allowed.has(level)) {
    return level;
  }

  // Walk down from the requested tier to find the best supported level.
  const idx = TIER_LADDER.indexOf(level);
  for (let i = idx - 1; i >= 0; i--) {
    if (allowed.has(TIER_LADDER[i])) {
      return TIER_LADDER[i];
    }
  }

  // Unreachable in practice: the base set always contains "low", "medium", "high".
  return "high";
}
