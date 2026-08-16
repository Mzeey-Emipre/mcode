/**
 * Classifies arbitrary provider errors into ladder-routable buckets.
 * The pipeline uses these classifications to decide whether to fall through
 * from path B/A to D, or to abort entirely.
 */

import type { ProviderErrorClass } from "./handoff-types.js";

interface ErrorShape {
  status?: number;
  code?: string;
  message?: string;
}

/**
 * Classifies an arbitrary provider error into one of the buckets the ladder
 * knows how to route on. Resilient to unknown shapes, never throws.
 */
export function classifyProviderError(err: unknown): ProviderErrorClass {
  if (err === null || err === undefined) return "fatal";
  const e = err as ErrorShape;
  const msg = (e.message ?? "").toLowerCase();

  if (e.status === 429 || /rate.?limit|too many requests/.test(msg)) return "quota";
  if (/credit balance|quota.*exhaust|billing|usage limit/.test(msg)) return "quota";

  if (e.status === 401 || e.status === 403) return "auth";
  if (/unauthori[sz]ed|invalid api key|authentication/.test(msg)) return "auth";

  if (/prompt is too long|context length|exceeds.*tokens|input too large/.test(msg)) return "context-overflow";

  if (e.status !== undefined && e.status >= 500 && e.status < 600) return "transient";
  if (e.code === "ECONNRESET" || e.code === "ETIMEDOUT" || e.code === "ENOTFOUND") return "transient";
  if (/network|timeout|fetch failed/.test(msg)) return "transient";

  // SDK wrapper errors that don't match other patterns are transient — the
  // subprocess may have crashed or the CLI returned an unexpected error shape.
  // Treating them as transient (rather than fatal) lets path D fire with a
  // "try again later" hint instead of a permanent failure banner.
  if (/sdk error|subprocess|claude.*error|cli.*error|side-channel/i.test(msg)) return "transient";

  // Broader context-overflow patterns beyond the SDK-specific message.
  if (/maximum context|tokens? exceeded|too many tokens/i.test(msg)) return "context-overflow";

  return "fatal";
}

/**
 * Returns true when this error class means the provider is unusable right now
 * and we should skip directly to deterministic (path D) rather than try A.
 */
export function shouldSkipToDeterministic(c: ProviderErrorClass): boolean {
  return c === "quota" || c === "auth" || c === "context-overflow" || c === "fatal";
}
