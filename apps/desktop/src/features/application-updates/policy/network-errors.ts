/** Chromium, Node, DNS, and socket failures that should retry quietly. */
const TRANSIENT_NETWORK_TOKENS: readonly string[] = [
  "ERR_NAME_NOT_RESOLVED",
  "ERR_INTERNET_DISCONNECTED",
  "ERR_NETWORK_CHANGED",
  "ERR_PROXY_CONNECTION_FAILED",
  "ERR_CONNECTION_RESET",
  "ERR_CONNECTION_REFUSED",
  "ERR_CONNECTION_TIMED_OUT",
  "ERR_CONNECTION_ABORTED",
  "ERR_CONNECTION_CLOSED",
  "ERR_NETWORK_IO_SUSPENDED",
  "ERR_TIMED_OUT",
  "ERR_ADDRESS_UNREACHABLE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENETDOWN",
];

/** HTTP statuses that indicate a temporary release-host outage. */
const TRANSIENT_HTTP_STATUS: ReadonlySet<number> = new Set([
  408, 429, 500, 502, 503, 504,
]);

/** Gateway response text used when an HTTP status is not exposed separately. */
const TRANSIENT_HTTP_PHRASES: readonly string[] = [
  "Gateway Time-out",
  "Gateway Timeout",
  "Bad Gateway",
  "Service Unavailable",
  "Too Many Requests",
];

/** Return whether an updater error is safe to retry on the next scheduled check. */
export function isTransientNetworkError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? "");
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === "string" && TRANSIENT_NETWORK_TOKENS.includes(code)) {
    return true;
  }
  const statusCode = (err as { statusCode?: number } | undefined)?.statusCode;
  if (typeof statusCode === "number" && TRANSIENT_HTTP_STATUS.has(statusCode)) {
    return true;
  }
  if (TRANSIENT_HTTP_PHRASES.some((phrase) => message.includes(phrase))) {
    return true;
  }
  return TRANSIENT_NETWORK_TOKENS.some((token) => message.includes(token));
}
