import { z } from "zod";
import type { QuotaCategory } from "@mcode/contracts";
import { logger } from "@mcode/shared";

const CURSOR_SPEND_ENDPOINT = "https://api.cursor.com/teams/spend";
const CACHE_TTL_MS = 15 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_RESPONSE_CHARS = 64 * 1024;

const CursorSpendMemberSchema = z.object({
  email: z.string().optional(),
  userEmail: z.string().optional(),
  user_email: z.string().optional(),
  apiPercentUsed: z.number().finite().optional(),
  autoPercentUsed: z.number().finite().optional(),
  composerPercentUsed: z.number().finite().optional(),
  totalPercentUsed: z.number().finite().optional(),
});

const CursorSpendResponseSchema = z.object({
  teamMemberSpend: z.array(z.unknown()),
});

interface CacheEntry {
  key: string;
  expiresAt: number;
  categories: QuotaCategory[];
}

type ResolvableOption = string | undefined | (() => string | undefined | Promise<string | undefined>);

/** Options for constructing a Cursor Admin API usage source. */
export interface CursorAdminUsageSourceOptions {
  /** Cursor Admin API key, or a function that resolves it at fetch time. */
  apiKey: ResolvableOption;
  /** Team member email whose Cursor spend row must be selected exactly. */
  usageEmail: ResolvableOption;
  /** Optional fetch implementation used by tests or alternate runtimes. */
  fetchImpl?: typeof fetch;
  /** Optional clock used for cache expiry tests. */
  now?: () => number;
}

/**
 * Reads Cursor account-limit utilization from the Enterprise Admin API.
 */
export class CursorAdminUsageSource {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private cache: CacheEntry | null = null;
  private inFlight: { key: string; promise: Promise<QuotaCategory[]> } | null = null;

  /**
   * @param options API key, target email, and optional test seams.
   */
  constructor(private readonly options: CursorAdminUsageSourceOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? (() => Date.now());
  }

  /** Fetches normalized Cursor quota categories or an empty list when unavailable. */
  async fetch(): Promise<QuotaCategory[]> {
    const apiKey = (await resolveOption(this.options.apiKey))?.trim();
    const usageEmail = (await resolveOption(this.options.usageEmail))?.trim();
    if (!apiKey || !usageEmail) return [];

    const cacheKey = cursorUsageCacheKey(apiKey, usageEmail);
    const cached = this.cache;
    const now = this.now();
    if (cached && cached.key === cacheKey && cached.expiresAt > now) return cached.categories;

    if (this.inFlight?.key === cacheKey) return this.inFlight.promise;

    const fetchPromise = this.fetchFresh(apiKey, usageEmail)
      .then((categories) => {
        this.cache = { key: cacheKey, categories, expiresAt: now + CACHE_TTL_MS };
        return categories;
      })
      .finally(() => {
        if (this.inFlight?.key === cacheKey) this.inFlight = null;
      });
    this.inFlight = { key: cacheKey, promise: fetchPromise };
    return fetchPromise;
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
          pageSize: 10,
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

    const contentLength = response.headers.get("content-length");
    if (contentLength && Number(contentLength) > MAX_RESPONSE_BYTES) {
      logger.warn("Cursor usage unavailable", { reason: "response_too_large" });
      return [];
    }

    let bodyText: string;
    try {
      bodyText = await readResponseTextCapped(response);
    } catch (error) {
      logger.warn("Cursor usage unavailable", {
        reason: error instanceof ResponseTooLargeError ? "response_too_large" : "read_failed",
      });
      return [];
    }

    let body: unknown;
    try {
      body = JSON.parse(bodyText);
    } catch {
      logger.warn("Cursor usage unavailable", { reason: "invalid_json" });
      return [];
    }

    const parsed = CursorSpendResponseSchema.safeParse(body);
    if (!parsed.success) {
      logger.warn("Cursor usage unavailable", { reason: "invalid_shape" });
      return [];
    }

    const normalizedUsageEmail = normalizeEmail(usageEmail);
    const matchingMember = parsed.data.teamMemberSpend.find((member) => {
      const parsedMember = CursorSpendMemberSchema.safeParse(member);
      if (!parsedMember.success) return false;
      return normalizeEmail(cursorSpendMemberEmail(parsedMember.data)) === normalizedUsageEmail;
    });
    if (!matchingMember) return [];

    const member = CursorSpendMemberSchema.safeParse(matchingMember);
    if (!member.success) {
      logger.warn("Cursor usage unavailable", { reason: "invalid_shape" });
      return [];
    }

    const categories = mapCursorSpendMember(member.data);
    if (categories.length === 0) {
      logger.warn("Cursor usage unavailable", { reason: "missing_percentage_fields" });
    }
    return categories;
  }
}

async function resolveOption(value: ResolvableOption): Promise<string | undefined> {
  return typeof value === "function" ? value() : value;
}

function cursorUsageCacheKey(apiKey: string, usageEmail: string): string {
  return `${apiKey}\0${normalizeEmail(usageEmail)}`;
}

class ResponseTooLargeError extends Error {}

async function readResponseTextCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (text.length > MAX_RESPONSE_CHARS) throw new ResponseTooLargeError();
    return text;
  }

  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytesRead += value.byteLength;
    if (bytesRead > MAX_RESPONSE_BYTES) throw new ResponseTooLargeError();
    text += decoder.decode(value, { stream: true });
    if (text.length > MAX_RESPONSE_CHARS) throw new ResponseTooLargeError();
  }

  text += decoder.decode();
  if (text.length > MAX_RESPONSE_CHARS) throw new ResponseTooLargeError();
  return text;
}

function normalizeEmail(email: string | undefined): string {
  return email?.trim().toLowerCase() ?? "";
}

function cursorSpendMemberEmail(member: {
  email?: string;
  userEmail?: string;
  user_email?: string;
}): string | undefined {
  return member.email ?? member.userEmail ?? member.user_email;
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
