import type { QuotaCategory } from "@mcode/contracts";
import type { IUsageSource } from "@mcode/shared/usage";

/**
 * Captures per-minute throttle state from `anthropic-ratelimit-*`
 * response headers. The Claude Agent SDK does not currently surface
 * response headers to host applications, so this source is inert.
 *
 * Tracking: anthropics/claude-code#20636
 */
export class AnthropicHeaderUsageSource implements IUsageSource {
  readonly id = "claude.headers";

  /** Always false — the SDK does not expose response headers yet. */
  async isAvailable(): Promise<boolean> {
    return false;
  }

  /** Always null — no headers have been observed. */
  async fetch(): Promise<QuotaCategory[] | null> {
    return null;
  }
}
