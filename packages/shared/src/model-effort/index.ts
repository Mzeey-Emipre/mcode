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
//
// xhigh sits below max because xhigh is exclusive to Opus 4.8/4.7, while max is
// a broader "extended thinking" tier supported by Opus 4.6 and Sonnet 4.6 as well.
// "ultrathink" is the virtual top tier: it is mapped to "max" effort at the SDK
// boundary and additionally prepends "Ultrathink:\n" to the user prompt.
// Eligibility is identical to the max tier (Opus 4.8/4.7/4.6, Sonnet 4.6).
//
// "none" and "minimal" align with OpenAI Codex app-server ReasoningEffort and are filtered
// out or mapped before Claude SDK calls.
const TIER_LADDER: readonly ReasoningLevel[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "ultrathink",
];

/** Claude model IDs that support the "xhigh" effort tier. */
const XHIGH_EFFORT_MODEL_IDS: readonly string[] = ["claude-opus-4-8", "claude-opus-4-7"];

/** Claude model IDs that support the "max" effort tier. */
const MAX_EFFORT_MODEL_IDS: readonly string[] = [
  "claude-fable-5",
  "claude-sonnet-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
];

/**
 * Claude model IDs that support the "ultrathink" virtual tier.
 * Identical to the max-tier set — ultrathink is "max + prompt prefix".
 */
const ULTRATHINK_MODEL_IDS: readonly string[] = MAX_EFFORT_MODEL_IDS;

/**
 * Claude model IDs that support the extended 1,000,000-token context window.
 * The same Opus 4.8/4.7/4.6 + Sonnet 4.6 cohort that supports the max effort tier.
 */
const ONE_M_CONTEXT_MODEL_IDS: readonly string[] = [
  "claude-fable-5",
  "claude-sonnet-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
];

/**
 * Claude model IDs that expose a boolean thinking toggle (instead of an effort
 * dial). Currently only Haiku 4.5 fits this shape.
 */
const THINKING_TOGGLE_MODEL_IDS: readonly string[] = ["claude-haiku-4-5"];

/** Claude model IDs that do NOT support the effort parameter at all. */
const EFFORT_UNSUPPORTED_CLAUDE_IDS: readonly string[] = ["claude-haiku-4-5"];

/** Base tiers supported by every Claude model that accepts the effort parameter. */
const BASE_ALLOWED_TIERS: readonly ReasoningLevel[] = ["low", "medium", "high"];

// All known base IDs, sorted longest-first so more-specific prefixes always match
// before shorter ones (prevents a shorter ID from shadowing a longer variant like
// "claude-opus-4-8" shadowing a hypothetical "claude-opus-4-8-turbo").
const ALL_KNOWN_BASE_IDS: readonly string[] = [
  ...new Set([
    ...XHIGH_EFFORT_MODEL_IDS,
    ...MAX_EFFORT_MODEL_IDS,
    ...ULTRATHINK_MODEL_IDS,
    ...ONE_M_CONTEXT_MODEL_IDS,
    ...THINKING_TOGGLE_MODEL_IDS,
    ...EFFORT_UNSUPPORTED_CLAUDE_IDS,
  ]),
].sort((a, b) => b.length - a.length);

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

/** True for static mcode Codex catalog models (GPT-5 family routed via `codex app-server`). */
function isCodexCatalogModelId(modelId: string): boolean {
  const id = normalizeModelId(modelId);
  return id.startsWith("gpt-5");
}

/**
 * Normalizes reasoning levels for OpenAI Codex GPT-5 models.
 * GPT-5.6 variants expose model-specific effort tiers, including automatic delegation.
 */
function normalizeCodexReasoningLevel(modelId: string, level: ReasoningLevel): ReasoningLevel {
  const id = normalizeModelId(modelId);
  if (id.startsWith("gpt-5.6-")) {
    const allowed = new Set<ReasoningLevel>(["low", "medium", "high", "xhigh", "max"]);
    if (id === "gpt-5.6-sol" || id === "gpt-5.6-terra") allowed.add("ultra");
    const requested = level === "ultrathink" ? "max" : level;

    if (allowed.has(requested)) return requested;

    const idx = TIER_LADDER.indexOf(requested);
    for (let i = idx - 1; i >= 0; i--) {
      const tier = TIER_LADDER[i];
      if (allowed.has(tier)) return tier;
    }
    return id === "gpt-5.6-sol" ? "low" : "medium";
  }

  const base = new Set<ReasoningLevel>(["none", "minimal", "low", "medium", "high"]);
  const withXhigh = new Set<ReasoningLevel>([...base, "xhigh", "max", "ultrathink"]);
  const isMini =
    (id.includes("mini") && id.includes("codex"))
    || id === "gpt-5.4-mini";
  const allowed = isMini ? base : withXhigh;

  if (allowed.has(level)) return level;

  const idx = TIER_LADDER.indexOf(level);
  if (idx === -1) return "medium";

  for (let i = idx - 1; i >= 0; i--) {
    const t = TIER_LADDER[i];
    if (allowed.has(t)) return t;
  }
  return "medium";
}

/**
 * Returns true when the model supports the "xhigh" effort tier.
 *
 * Only the `claude-opus-4-8` and `claude-opus-4-7` families (including
 * their dated variants) expose this tier.
 */
export function isXhighEffortModel(modelId: string): boolean {
  return XHIGH_EFFORT_MODEL_IDS.includes(normalizeModelId(modelId));
}

/**
 * Returns true when the model supports the "max" effort tier.
 *
 * Applies to the fable-5, sonnet-5, opus-4-8, opus-4-7, opus-4-6, and sonnet-4-6 families.
 */
export function isMaxEffortModel(modelId: string): boolean {
  return MAX_EFFORT_MODEL_IDS.includes(normalizeModelId(modelId));
}

/**
 * Returns true when the model supports the "ultrathink" virtual tier.
 *
 * Applies to the fable-5, sonnet-5, opus-4-8, opus-4-7, opus-4-6, and sonnet-4-6 families.
 * Ultrathink resolves to "max" effort at the SDK boundary and additionally
 * prepends "Ultrathink:\n" to the user prompt.
 */
export function supportsUltrathink(modelId: string): boolean {
  return ULTRATHINK_MODEL_IDS.includes(normalizeModelId(modelId));
}

/**
 * Returns true when the model supports the extended 1,000,000-token context
 * window. Applies to fable-5, sonnet-5, opus-4-8, opus-4-7, opus-4-6, and sonnet-4-6.
 *
 * The window is opted into by appending `[1m]` to the model slug at send
 * time; the Claude Agent SDK handles the beta header internally.
 */
export function supports1MContextWindow(modelId: string): boolean {
  return ONE_M_CONTEXT_MODEL_IDS.includes(normalizeModelId(modelId));
}

/**
 * Returns true when the model exposes a boolean thinking toggle (instead of
 * an effort dial). Currently Haiku 4.5 is the only such model.
 */
export function supportsThinkingToggle(modelId: string): boolean {
  return THINKING_TOGGLE_MODEL_IDS.includes(normalizeModelId(modelId));
}

/**
 * Returns false when the model does not accept the effort parameter at all.
 *
 * Haiku-class models ignore effort; sending it causes API errors.
 * Unknown models default to true because most Claude models do support effort.
 * GPT-5 Codex catalog IDs take a separate path in `normalizeReasoningLevelForModel` before this returns.
 */
export function supportsEffortParameter(modelId: string): boolean {
  return !EFFORT_UNSUPPORTED_CLAUDE_IDS.includes(normalizeModelId(modelId));
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
  if (isCodexCatalogModelId(modelId)) {
    return normalizeCodexReasoningLevel(modelId, level);
  }

  // Short-circuit for models that don't accept the effort param at all.
  if (!supportsEffortParameter(modelId)) {
    return "high";
  }

  // OpenAI-only tiers: Claude maps to the lowest supported real tier.
  if (level === "none" || level === "minimal") {
    return "low";
  }

  // Build the set of tiers this model supports.
  const allowed = new Set<ReasoningLevel>(BASE_ALLOWED_TIERS);
  if (isMaxEffortModel(modelId)) {
    allowed.add("max");
  }
  if (isXhighEffortModel(modelId)) {
    allowed.add("xhigh");
  }
  if (supportsUltrathink(modelId)) {
    allowed.add("ultrathink");
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
