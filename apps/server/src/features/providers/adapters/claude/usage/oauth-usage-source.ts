import type { QuotaCategory } from "@mcode/contracts";
import type { AnthropicOauthToken, IUsageSource } from "@mcode/shared/usage";

const ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const BETA_HEADER = "oauth-2025-04-20";

interface RawUsageResponse {
  five_hour?: { utilization: number; resets_at: string };
  seven_day?: { utilization: number; resets_at: string };
  extra_usage?: { used_cents: number; utilization: number };
}

/**
 * Reads the user's Claude Pro/Max plan utilization from the
 * /api/oauth/usage endpoint that Claude Code uses for its `/usage` command.
 */
export class AnthropicOAuthUsageSource implements IUsageSource {
  readonly id = "claude.oauth";
  private cachedToken: AnthropicOauthToken | null = null;

  /**
   * @param readToken Per-OS OAuth token reader (e.g. `readAnthropicOauthToken`
   *   from `@mcode/shared/usage`).
   * @param userAgent Sent on the request; defaults to "mcode".
   */
  constructor(
    private readonly readToken: () => Promise<AnthropicOauthToken | null>,
    private readonly userAgent = "mcode",
  ) {}

  /** True when a valid OAuth token can be obtained. */
  async isAvailable(): Promise<boolean> {
    return (await this.getToken()) !== null;
  }

  /** Returns quota categories, or null if the token is missing or the request fails. */
  async fetch(): Promise<QuotaCategory[] | null> {
    const token = await this.getToken();
    if (!token) return null;

    let response: Response;
    try {
      response = await globalThis.fetch(ENDPOINT, {
        method: "GET",
        signal: AbortSignal.timeout(5_000),
        headers: {
          Authorization: `Bearer ${token.accessToken}`,
          "anthropic-beta": BETA_HEADER,
          "User-Agent": this.userAgent,
        },
      });
    } catch {
      return null;
    }

    if (response.status === 401) {
      // Token rejected — clear cache so the next call re-reads from disk.
      // The SDK refreshes credentials on its own turns.
      this.cachedToken = null;
      return null;
    }
    if (!response.ok) return null;

    let body: RawUsageResponse;
    try {
      body = (await response.json()) as RawUsageResponse;
    } catch {
      return null;
    }

    return mapToCategories(body);
  }

  /**
   * Returns a valid cached token, or fetches a fresh one when the cache is
   * absent, expired, or was evicted after a 401.
   */
  private async getToken(): Promise<AnthropicOauthToken | null> {
    if (this.cachedToken && this.cachedToken.expiresAt > Date.now()) {
      return this.cachedToken;
    }
    // Re-read: token is absent, expired, or evicted after a 401.
    this.cachedToken = await this.readToken();
    // Discard immediately if the credential store itself returned a stale token
    // (avoids burning one HTTP round-trip on a guaranteed 401).
    if (this.cachedToken && this.cachedToken.expiresAt <= Date.now()) {
      this.cachedToken = null;
    }
    return this.cachedToken;
  }
}

/** Maps the raw API response fields to the shared QuotaCategory contract. */
function mapToCategories(body: RawUsageResponse): QuotaCategory[] {
  const categories: QuotaCategory[] = [];

  if (body.five_hour) {
    categories.push({
      label: "5-hour limit",
      used: body.five_hour.utilization,
      total: 100,
      isUnlimited: false,
      remainingPercent: clampPercent((100 - body.five_hour.utilization) / 100),
      resetDate: body.five_hour.resets_at,
    });
  }
  if (body.seven_day) {
    categories.push({
      label: "Weekly limit",
      used: body.seven_day.utilization,
      total: 100,
      isUnlimited: false,
      remainingPercent: clampPercent((100 - body.seven_day.utilization) / 100),
      resetDate: body.seven_day.resets_at,
    });
  }
  if (body.extra_usage && body.extra_usage.used_cents > 0) {
    categories.push({
      label: "Pay-as-you-go",
      used: body.extra_usage.used_cents / 100,
      total: null,
      isUnlimited: true,
      remainingPercent: 1,
    });
  }
  return categories;
}

/**
 * Clamps a ratio to [0, 1], treating NaN as 0.
 * Callers use integer arithmetic `(100 - x) / 100` to avoid IEEE-754 drift.
 */
function clampPercent(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
