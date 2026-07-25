import type { ContextWindowMode } from "@mcode/contracts";

/**
 * Default per-model context window (tokens). Every Claude model supports this
 * tier without any opt-in. Values are deliberately conservative — the SDK and
 * Anthropic Models API may return larger numbers for the *capability ceiling*,
 * but those are only honored when the user explicitly opts into 1M mode.
 *
 * Source: https://platform.claude.com/docs/en/docs/about-claude/models/overview
 * (verified 2026-04-22).
 */
export const MODEL_CONTEXT_WINDOWS_DEFAULT: Readonly<Record<string, number>> = {
  "claude-opus-5": 200_000,
  "claude-fable-5": 200_000,
  "claude-sonnet-5": 200_000,
  "claude-opus-4-8": 200_000,
  "claude-opus-4-7": 200_000,
  "claude-opus-4-6": 200_000,
  "claude-sonnet-4-6": 200_000,
  "claude-haiku-4-5": 200_000,
};

/**
 * Extended per-model context window (tokens) for models that support the
 * 1,000,000-token tier. Selected at request time by appending `[1m]` to the
 * model slug. Models absent from this map ignore the 1M opt-in and run on
 * their default window.
 */
export const MODEL_CONTEXT_WINDOWS_EXTENDED: Readonly<Record<string, number>> = {
  "claude-opus-5": 1_000_000,
  "claude-fable-5": 1_000_000,
  "claude-sonnet-5": 1_000_000,
  "claude-opus-4-8": 1_000_000,
  "claude-opus-4-7": 1_000_000,
  "claude-opus-4-6": 1_000_000,
  "claude-sonnet-4-6": 1_000_000,
};

/**
 * Backwards-compatible alias. Returns the default window for each model.
 * New call sites should prefer `getModelContextWindow(modelId, mode)` so the
 * active window matches the request the SDK actually receives.
 */
export const MODEL_CONTEXT_WINDOWS = MODEL_CONTEXT_WINDOWS_DEFAULT;

/**
 * Precomputed longest-first key list so dated SDK variants
 * (e.g. `claude-haiku-4-5-20251001`) resolve to the closest base ID
 * without being shadowed by a shorter prefix.
 */
const SORTED_KEYS: readonly string[] = Object.keys(MODEL_CONTEXT_WINDOWS_DEFAULT)
  .sort((a, b) => b.length - a.length);

/** Looks up a model in `map` with prefix matching for dated SDK variants. */
function lookup(map: Readonly<Record<string, number>>, modelId: string): number | undefined {
  if (!modelId) return undefined;
  // Strip [1m] suffix that may be present on slugs returned by resolveSdkModelSlug.
  const bare = modelId.replace(/\[1m\]$/, "");
  const exact = map[bare];
  if (exact !== undefined) return exact;
  const base = SORTED_KEYS.find((k) => bare.startsWith(`${k}-`));
  return base ? map[base] : undefined;
}

/**
 * Returns the active context window (tokens) for a model and mode.
 *
 * - "200k" (or unspecified): the model's default window.
 * - "1m": the extended window if the model supports it, otherwise falls
 *   through to the default.
 *
 * Returns `undefined` for unknown models.
 */
export function getModelContextWindow(
  modelId: string,
  mode: ContextWindowMode = "200k",
): number | undefined {
  if (mode === "1m") {
    const extended = lookup(MODEL_CONTEXT_WINDOWS_EXTENDED, modelId);
    if (extended !== undefined) return extended;
  }
  return lookup(MODEL_CONTEXT_WINDOWS_DEFAULT, modelId);
}
