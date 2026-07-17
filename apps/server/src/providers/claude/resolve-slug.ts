import type { ContextWindowMode } from "@mcode/contracts";
import { supports1MContextWindow } from "@mcode/shared";

/**
 * Append the `[1m]` suffix that the Claude Agent SDK uses to enable the
 * 1,000,000-token context window beta. The SDK translates the suffix into the
 * `context-1m-2025-08-07` beta header on the wire.
 *
 * Falls through to the bare model ID when:
 *   - the user did not opt into 1M mode (mode !== "1m"), or
 *   - the model does not support the extended window (e.g. Haiku 4.5).
 */
export function resolveSdkModelSlug(
  modelId: string,
  mode: ContextWindowMode | undefined,
): string {
  if (mode === "1m" && supports1MContextWindow(modelId)) {
    return `${modelId}[1m]`;
  }
  return modelId;
}
