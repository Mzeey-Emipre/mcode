import { z } from "zod";
import type { QuotaCategory } from "@mcode/contracts";
import { logger } from "@mcode/shared";

const CURSOR_SPEND_ENDPOINT = "https://api.cursor.com/teams/spend";
const CACHE_TTL_MS = 15 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5_000;

const CursorSpendMemberSchema = z.object({
  apiPercentUsed: z.number().finite().optional(),
  autoPercentUsed: z.number().finite().optional(),
  composerPercentUsed: z.number().finite().optional(),
  totalPercentUsed: z.number().finite().optional(),
});

const CursorSpendResponseSchema = z.object({
  teamMemberSpend: z.array(CursorSpendMemberSchema),
});

interface CacheEntry {
  expiresAt: number;
  categories: QuotaCategory[];
}

export interface CursorAdminUsageSourceOptions {
  apiKey: string | undefined | (() => string | undefined);
  usageEmail: string | undefined | (() => string | undefined);
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * Reads Cursor account-limit utilization from the Enterprise Admin API.
 */
export class CursorAdminUsageSource {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private cache: CacheEntry | null = null;

  /**
   * @param options API key, target email, and optional test seams.
   */
  constructor(private readonly options: CursorAdminUsageSourceOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? (() => Date.now());
  }

  /** Fetches normalized Cursor quota categories or an empty list when unavailable. */
  async fetch(): Promise<QuotaCategory[]> {
    const apiKey = resolveOption(this.options.apiKey)?.trim();
    const usageEmail = resolveOption(this.options.usageEmail)?.trim();
    if (!apiKey || !usageEmail) return [];

    const cached = this.cache;
    const now = this.now();
    if (cached && cached.expiresAt > now) return cached.categories;

    const categories = await this.fetchFresh(apiKey, usageEmail);
    this.cache = { categories, expiresAt: now + CACHE_TTL_MS };
    return categories;
  }

  private async fetchFresh(apiKey: string, usageEmail: string): Promise<QuotaCategory[]> {
    let response: Response;
    try {
      response = await this.fetchImpl(CURSOR_SPEND_ENDPOINT, {
        method: "POST",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          searchTerm: usageEmail,
          page: 1,
          pageSize: 1,
        }),
      });
    } catch (error) {
      logger.warn("Cursor usage unavailable", {
        reason: "request_failed",
        error: error instanceof Error ? error.name : String(error),
      });
      return [];
    }

    if (!response.ok) {
      logger.warn("Cursor usage unavailable", {
        reason: "http_status",
        status: response.status,
      });
      return [];
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      logger.warn("Cursor usage unavailable", { reason: "invalid_json" });
      return [];
    }

    const parsed = CursorSpendResponseSchema.safeParse(body);
    if (!parsed.success) {
      logger.warn("Cursor usage unavailable", { reason: "invalid_shape" });
      return [];
    }

    const member = parsed.data.teamMemberSpend[0];
    if (!member) return [];

    const categories = mapCursorSpendMember(member);
    if (categories.length === 0) {
      logger.warn("Cursor usage unavailable", { reason: "missing_percentage_fields" });
    }
    return categories;
  }
}

function resolveOption(value: string | undefined | (() => string | undefined)): string | undefined {
  return typeof value === "function" ? value() : value;
}

/** Maps documented percentage-like Cursor spend fields into quota categories. */
export function mapCursorSpendMember(member: {
  apiPercentUsed?: number;
  autoPercentUsed?: number;
  composerPercentUsed?: number;
  totalPercentUsed?: number;
}): QuotaCategory[] {
  const categories: QuotaCategory[] = [];
  pushPercentCategory(categories, "API usage", member.apiPercentUsed);
  pushPercentCategory(
    categories,
    "Auto and Composer",
    member.autoPercentUsed ?? member.composerPercentUsed,
  );

  if (categories.length === 0) {
    pushPercentCategory(categories, "Total usage", member.totalPercentUsed);
  }

  return categories;
}

function pushPercentCategory(categories: QuotaCategory[], label: string, value: number | undefined): void {
  if (typeof value !== "number" || !Number.isFinite(value)) return;
  const used = clampPercentValue(value);
  categories.push({
    label,
    used,
    total: 100,
    remainingPercent: clampRatio((100 - used) / 100),
    isUnlimited: false,
  });
}

function clampPercentValue(value: number): number {
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

function clampRatio(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
