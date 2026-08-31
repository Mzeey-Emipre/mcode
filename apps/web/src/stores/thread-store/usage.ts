import type { ProviderUsageInfo } from "@mcode/contracts";

const USAGE_STALE_TTL_MS = 24 * 60 * 60 * 1000;

function metricValues(usage: ProviderUsageInfo): Array<number | string | undefined> {
  return [
    usage.sessionCostUsd,
    usage.serviceTier,
    usage.numTurns,
    usage.durationMs,
  ];
}

/** Returns whether a provider usage snapshot contains quota or session data. */
export function hasProviderUsageData(usage: ProviderUsageInfo | undefined): boolean {
  if (!usage) return false;
  return usage.quotaCategories.length > 0 || metricValues(usage).some((value) => value !== undefined);
}

function isFreshUsageSnapshot(usage: ProviderUsageInfo | undefined, now: number): boolean {
  if (!usage?.fetchedAt) return hasProviderUsageData(usage);
  const fetchedAt = Date.parse(usage.fetchedAt);
  return Number.isFinite(fetchedAt) && now - fetchedAt <= USAGE_STALE_TTL_MS;
}

/** Selects only provider-wide quota data from one usage snapshot. */
export function providerQuotaSnapshot(usage: ProviderUsageInfo): ProviderUsageInfo {
  return {
    providerId: usage.providerId,
    quotaCategories: usage.quotaCategories,
    billingMode: usage.billingMode,
    usageStatus: usage.usageStatus,
    fetchedAt: usage.fetchedAt,
    failedAt: usage.failedAt,
    diagnostic: usage.diagnostic,
  };
}

function resolveUsageStatus(incoming: ProviderUsageInfo): NonNullable<ProviderUsageInfo["usageStatus"]> {
  return incoming.usageStatus ?? (incoming.quotaCategories.length === 0 ? "unavailable" : "ready");
}

function staleSnapshot(
  existing: ProviderUsageInfo,
  incoming: ProviderUsageInfo,
  now: number,
): ProviderUsageInfo {
  return {
    ...existing,
    providerId: existing.providerId,
    quotaCategories: existing.quotaCategories,
    usageStatus: "stale",
    failedAt: incoming.failedAt ?? new Date(now).toISOString(),
    diagnostic: incoming.diagnostic,
  };
}

function unavailableSnapshot(
  existing: ProviderUsageInfo | undefined,
  incoming: ProviderUsageInfo,
  status: "unavailable" | "unsupported",
  now: number,
): ProviderUsageInfo {
  if (existing && hasProviderUsageData(existing) && isFreshUsageSnapshot(existing, now)) {
    return staleSnapshot(existing, incoming, now);
  }
  return { ...incoming, usageStatus: status };
}

function emptySnapshot(incoming: ProviderUsageInfo, now: number): ProviderUsageInfo {
  return {
    providerId: incoming.providerId,
    quotaCategories: [],
    billingMode: incoming.billingMode,
    sessionCostUsd: incoming.sessionCostUsd,
    serviceTier: incoming.serviceTier,
    numTurns: incoming.numTurns,
    durationMs: incoming.durationMs,
    usageStatus: "ready-empty",
    fetchedAt: incoming.fetchedAt ?? new Date(now).toISOString(),
  };
}

function readySnapshot(
  existing: ProviderUsageInfo | undefined,
  incoming: ProviderUsageInfo,
  now: number,
): ProviderUsageInfo {
  const hasQuotaCategories = incoming.quotaCategories.length > 0;
  return {
    ...existing,
    ...incoming,
    quotaCategories: hasQuotaCategories ? incoming.quotaCategories : (existing?.quotaCategories ?? []),
    usageStatus: hasQuotaCategories ? "ready" : (incoming.usageStatus ?? "ready-empty"),
    fetchedAt: incoming.fetchedAt ?? new Date(now).toISOString(),
    failedAt: undefined,
    diagnostic: undefined,
  };
}

/** Merges incoming provider quota data with a prior last-known-good snapshot. */
export function mergeProviderUsageSnapshot(
  existing: ProviderUsageInfo | undefined,
  incoming: ProviderUsageInfo,
  now = Date.now(),
): ProviderUsageInfo {
  const status = resolveUsageStatus(incoming);
  if (status === "unavailable" || status === "unsupported") {
    return unavailableSnapshot(existing, incoming, status, now);
  }
  if (status === "ready-empty") return emptySnapshot(incoming, now);
  return readySnapshot(existing, incoming, now);
}

function threadMetrics(existing: ProviderUsageInfo | undefined): Partial<ProviderUsageInfo> {
  if (!existing) return {};
  return {
    sessionCostUsd: existing.sessionCostUsd,
    serviceTier: existing.serviceTier,
    numTurns: existing.numTurns,
    durationMs: existing.durationMs,
  };
}

function providerBase(
  existing: ProviderUsageInfo | undefined,
  providerSnapshot: ProviderUsageInfo | undefined,
): ProviderUsageInfo | undefined {
  return providerSnapshot && hasProviderUsageData(providerSnapshot) ? providerSnapshot : existing;
}

/** Merges provider-wide quota data with metrics that remain specific to one thread. */
export function mergeThreadUsageSnapshot(
  existing: ProviderUsageInfo | undefined,
  providerSnapshot: ProviderUsageInfo | undefined,
  incoming: ProviderUsageInfo,
  now = Date.now(),
): ProviderUsageInfo {
  return {
    ...mergeProviderUsageSnapshot(providerBase(existing, providerSnapshot), providerQuotaSnapshot(incoming), now),
    ...threadMetrics(existing),
    sessionCostUsd: incoming.sessionCostUsd ?? existing?.sessionCostUsd,
    serviceTier: incoming.serviceTier ?? existing?.serviceTier,
    numTurns: incoming.numTurns ?? existing?.numTurns,
    durationMs: incoming.durationMs ?? existing?.durationMs,
  };
}
