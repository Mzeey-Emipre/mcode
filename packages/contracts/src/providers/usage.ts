import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";

/** Per-turn token breakdown. All providers populate at least inputTokens and outputTokens. */
export const TurnUsageSchema = lazySchema(() =>
  z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheReadTokens: z.number().optional(),
    cacheWriteTokens: z.number().optional(),
    costMultiplier: z.number().optional(),
  }),
);

/** TypeScript type inferred from TurnUsageSchema. */
export type TurnUsage = z.infer<ReturnType<typeof TurnUsageSchema>>;

/** A single quota bucket (e.g. "Premium usage", "Chat"). */
export const QuotaCategorySchema = lazySchema(() =>
  z.object({
    /** Human-readable label for the quota category. */
    label: z.string(),
    /** Number of requests or tokens consumed in this category. */
    used: z.number(),
    /** Maximum allowed in this category. Null when the limit is unknown. */
    total: z.number().nullable(),
    /** Fraction remaining in [0, 1]. 1 means fully available, 0 means exhausted. */
    remainingPercent: z.number().min(0).max(1),
    /** ISO 8601 timestamp when this quota resets. */
    resetDate: z.string().nullish(),
    /** True when the provider reports no cap on this category. */
    isUnlimited: z.boolean(),
  }),
);

/** TypeScript type inferred from QuotaCategorySchema. */
export type QuotaCategory = z.infer<ReturnType<typeof QuotaCategorySchema>>;

/** Provider-owned billing mode for usage and cost display decisions. */
export const ProviderBillingModeSchema = lazySchema(() =>
  z.enum(["api_key", "plan", "unknown"]),
);

/** TypeScript type inferred from ProviderBillingModeSchema. */
export type ProviderBillingMode = z.infer<ReturnType<typeof ProviderBillingModeSchema>>;

/** Provider usage snapshot status around the latest successful usage payload. */
export const ProviderUsageStatusSchema = lazySchema(() =>
  z.enum(["ready", "ready-empty", "stale", "unavailable", "unsupported"]),
);

/** TypeScript type inferred from ProviderUsageStatusSchema. */
export type ProviderUsageStatus = z.infer<ReturnType<typeof ProviderUsageStatusSchema>>;

/** Provider-level usage state. Quota and cost only - context/turn data is thread-scoped. */
export const ProviderUsageInfoSchema = lazySchema(() =>
  z.object({
    /** Identifier matching a registered ProviderId. */
    providerId: z.string(),
    /** All quota buckets reported by this provider. */
    quotaCategories: z.array(QuotaCategorySchema()),
    /** Provider-owned discriminator for whether usage is billed by API key, plan, or unknown mode. */
    billingMode: ProviderBillingModeSchema().optional(),
    /** Accumulated cost for the current session in USD. Absent when the provider does not report cost. */
    sessionCostUsd: z.number().optional(),
    /** API service tier used for the last turn (Claude only). */
    serviceTier: z.enum(["standard", "priority", "batch"]).optional(),
    /** Total number of agent turns in the current session (Claude only). */
    numTurns: z.number().int().optional(),
    /** Total wall-clock duration of the current session in ms (Claude only). */
    durationMs: z.number().optional(),
    /** Snapshot status for provider/account-scoped quota freshness. */
    usageStatus: ProviderUsageStatusSchema().optional(),
    /** ISO timestamp for the last successful provider usage refresh. */
    fetchedAt: z.string().optional(),
    /** ISO timestamp for the failed refresh that made this data stale or unavailable. */
    failedAt: z.string().optional(),
    /** Redacted diagnostic suitable for UI diagnostics and logs. */
    diagnostic: z.string().optional(),
  }),
);

/** TypeScript type inferred from ProviderUsageInfoSchema. */
export type ProviderUsageInfo = z.infer<ReturnType<typeof ProviderUsageInfoSchema>>;
