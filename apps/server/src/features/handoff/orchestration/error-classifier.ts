/**
 * Classifies arbitrary provider errors into ladder-routable buckets.
 * The pipeline uses these classifications to decide whether to fall through
 * from path B/A to D, or to abort entirely.
 */

import type { ProviderErrorClass } from "../artifacts/handoff-types.js";

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
  const error = err as ErrorShape;
  return ERROR_CLASSIFIERS
    .map((classifier) => classifier(error))
    .find((classification): classification is ProviderErrorClass => classification !== null)
    ?? "fatal";
}

type ErrorClassifier = (error: ErrorShape) => ProviderErrorClass | null;

const ERROR_CLASSIFIERS: readonly ErrorClassifier[] = [
  (error) => (error.status === 429 || hasMessage(error, /rate.?limit|too many requests/) ? "quota" : null),
  (error) => (hasMessage(error, /credit balance|quota.*exhaust|billing|usage limit/) ? "quota" : null),
  (error) => (error.status === 401 || error.status === 403 ? "auth" : null),
  (error) => (hasMessage(error, /unauthori[sz]ed|invalid api key|authentication/) ? "auth" : null),
  (error) => (hasMessage(error, /prompt is too long|context length|exceeds.*tokens|input too large/) ? "context-overflow" : null),
  (error) => (isServerError(error.status) ? "transient" : null),
  (error) => (isTransientCode(error.code) ? "transient" : null),
  (error) => (hasMessage(error, /network|timeout|fetch failed/) ? "transient" : null),
  // SDK wrapper errors may describe a crashed subprocess rather than a permanent failure.
  (error) => (hasMessage(error, /sdk error|subprocess|claude.*error|cli.*error|side-channel/i) ? "transient" : null),
  (error) => (hasMessage(error, /maximum context|tokens? exceeded|too many tokens/i) ? "context-overflow" : null),
];

function hasMessage(error: ErrorShape, pattern: RegExp): boolean {
  return pattern.test((error.message ?? "").toLowerCase());
}

function isServerError(status: number | undefined): boolean {
  return status !== undefined && status >= 500 && status < 600;
}

function isTransientCode(code: string | undefined): boolean {
  return code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ENOTFOUND";
}

/**
 * Returns true when this error class means the provider is unusable right now
 * and we should skip directly to deterministic (path D) rather than try A.
 */
export function shouldSkipToDeterministic(c: ProviderErrorClass): boolean {
  return c === "quota" || c === "auth" || c === "context-overflow" || c === "fatal";
}
