import type { ContextWindowMode } from "@mcode/contracts";
import { supports1MContextWindow } from "@mcode/shared";

/**
 * The standard (non-1M) Claude context window in tokens. Every model mcode
 * offers runs on this tier unless the user explicitly opts into 1M mode.
 */
export const STANDARD_CONTEXT_WINDOW_TOKENS = 200_000;

/**
 * Auto-compact window override passed to the SDK via the `settings` option.
 *
 * Claude Agent SDK 0.3.x treats 1M-capable models (Fable 5, Opus 4.x,
 * Sonnet 4.6) as natively 1M-context, so its auto-compaction trigger only
 * fires near 1M tokens. Subscription accounts without usage credits are
 * rejected the moment a request crosses the 200k tier ("API Error: Usage
 * credits required for 1M context"), which means a standard-mode session
 * errors at the 200k limit instead of compacting. Pinning
 * `autoCompactWindow` restores the 0.2.x behavior of compacting within the
 * 200k window.
 *
 * Returns `undefined` only when the session actually runs on the 1M wire tier
 * (`mode === "1m"` and the model supports `[1m]`). Models that ignore the mode
 * flag (e.g. Haiku) still need the 200k pin.
 */
export function resolveAutoCompactWindow(
  mode: ContextWindowMode | undefined,
  modelId: string,
): number | undefined {
  if (mode === "1m" && supports1MContextWindow(modelId)) {
    return undefined;
  }
  return STANDARD_CONTEXT_WINDOW_TOKENS;
}

/**
 * Clamps the context window the SDK reports in `modelUsage` to the window the
 * session actually runs in.
 *
 * In standard mode the 0.3.x SDK reports the model's 1M capability ceiling,
 * not the 200k tier the requests are billed against, so the context ring and
 * the token estimator would show ~20% fill at the real limit. In 1M mode the
 * reported value is passed through unchanged.
 */
export function clampContextWindowToMode(
  reported: number | undefined,
  mode: ContextWindowMode | undefined,
  modelId: string | undefined,
): number | undefined {
  if (reported === undefined) return reported;
  if (mode === "1m" && modelId !== undefined && supports1MContextWindow(modelId)) {
    return reported;
  }
  return Math.min(reported, STANDARD_CONTEXT_WINDOW_TOKENS);
}
