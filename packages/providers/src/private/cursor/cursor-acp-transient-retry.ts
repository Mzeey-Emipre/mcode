/**
 * @internal
 * Heuristics for detecting transient `session/prompt` failures worth a single retry.
 */

/** Canonical `@agentclientprotocol/sdk` message when stdio to `cursor-agent acp` ends. */
export const ACP_CONNECTION_CLOSED_MESSAGE = "ACP connection closed";

/**
 * User prompt sent once after respawning `cursor-agent` when an in-flight turn died
 * from an unexpected ACP disconnect.
 */
export const CURSOR_ACP_CONTINUE_AFTER_DISCONNECT_PROMPT =
  "Continue from where you left off. Resume the interrupted task without repeating work you already completed.";

/**
 * Builds the capped reconnect retry prompt: continue instruction plus the user's last message.
 *
 * @param originalMessage - The user text from the turn that was interrupted.
 */
export function buildCursorAcpContinueAfterDisconnectPrompt(originalMessage: string): string {
  const trimmed = originalMessage.trim();
  if (trimmed.length === 0) {
    return CURSOR_ACP_CONTINUE_AFTER_DISCONNECT_PROMPT;
  }
  return `${CURSOR_ACP_CONTINUE_AFTER_DISCONNECT_PROMPT}\n\nLast message:\n${trimmed}`;
}

const TRANSIENT_RE = new RegExp(
  [
    "\\binternal\\s+server\\s+error\\b",
    "\\b502\\b",
    "\\b503\\b",
    "\\b504\\b",
    "\\b429\\b",
    "ETIMEDOUT",
    "ECONNRESET",
    "ENOTFOUND",
    "fetch failed",
    "socket hang up",
    "\\b503\\s+service",
    "temporar(il)?y\\s+unavailable",
  ].join("|"),
  "i",
);

/** Cursor cloud / GRPC-style stream resets surfaced through the Cursor CLI HTTP stack. */
const UPSTREAM_CANCEL_RE =
  /\[canceled\]|http\/2\s+stream\s+closed|cancell?ed[^\n]{0,120}stream|\berror\s+code\s+CANCEL\b|\(0x8\)|RST_STREAM/i;

/**
 * Cursor backend rate limit, surfaced as the Connect/gRPC `resource_exhausted`
 * status (code 8). `cursor-agent` serializes it as a minified `ConnectError`,
 * e.g. `v: [resource_exhausted] Error`. Per Cursor's docs this is almost always
 * short-term burst throttling (too many requests in a short window), not a hard
 * usage quota — so the right recovery is a brief backoff then a single retry.
 */
const CURSOR_RATE_LIMIT_RE = /\bresource_exhausted\b/i;

/**
 * Upper bound of random jitter (ms) added to the configured rate-limit backoff.
 * The trigger is concurrency — several turns trip the limit at the same instant —
 * so de-correlating the retries with jitter avoids re-creating the same burst.
 */
export const CURSOR_RATE_LIMIT_RETRY_JITTER_MS = 2000;

/**
 * Returns true when a Cursor prompt failed because the backend rate-limited the
 * request (`resource_exhausted`). Distinct from {@link looksLikeUpstreamStreamCancel}
 * because the recovery differs: a rate limit needs a backoff before retrying.
 *
 * @param message - Serialized error (`Error.message` or stderr snippet).
 */
export function looksLikeCursorRateLimit(message: string): boolean {
  return CURSOR_RATE_LIMIT_RE.test(message);
}

/**
 * Computes the rate-limit retry delay: a configured base plus random jitter in
 * `[0, {@link CURSOR_RATE_LIMIT_RETRY_JITTER_MS}]`. A non-finite or negative base
 * clamps to zero so a misconfigured setting can never produce a negative delay.
 *
 * @param baseMs - Configured base backoff (`provider.cursor.rateLimitRetryBackoffMs`).
 * @param rand - Source of `[0, 1)` randomness; injectable for deterministic tests.
 */
export function computeCursorRateLimitBackoffMs(
  baseMs: number,
  rand: () => number = Math.random,
): number {
  const safeBase = Number.isFinite(baseMs) && baseMs > 0 ? Math.floor(baseMs) : 0;
  const jitter = Math.floor(rand() * (CURSOR_RATE_LIMIT_RETRY_JITTER_MS + 1));
  return safeBase + jitter;
}

/**
 * Sleeps for `ms`, resolving early as soon as `shouldAbort()` returns true so a
 * user Stop during a rate-limit backoff is honored promptly instead of forcing
 * the full wait. Polls the abort predicate on a bounded interval; resolves
 * immediately when `ms <= 0` or already aborted.
 *
 * @param ms - Delay in milliseconds.
 * @param shouldAbort - Predicate polled to cut the wait short (e.g. pending Stop).
 * @param stepMs - Poll interval; clamped to at most `ms` so short waits stay tight.
 */
export function interruptibleDelay(
  ms: number,
  shouldAbort: () => boolean,
  stepMs = 150,
): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || shouldAbort()) {
      resolve();
      return;
    }
    const deadline = Date.now() + ms;
    const tick = Math.max(1, Math.min(stepMs, ms));
    const timer = setInterval(() => {
      if (shouldAbort() || Date.now() >= deadline) {
        clearInterval(timer);
        resolve();
      }
    }, tick);
  });
}

/**
 * Returns true when the message resembles Cursor upstream closing an HTTP or gRPC stream.
 * Pair with intent flags before deciding whether to show an error toast.
 *
 * @param message - Serialized error (`Error.message` or stderr snippet).
 */
export function looksLikeUpstreamStreamCancel(message: string): boolean {
  return UPSTREAM_CANCEL_RE.test(message);
}

/**
 * Returns true when the ACP SDK rejected a prompt because the subprocess stream closed.
 *
 * @param message - Serialized error (`Error.message` or stderr snippet).
 */
export function looksLikeAcpConnectionClosed(message: string): boolean {
  return /\bacp connection closed\b/i.test(message);
}

/**
 * Returns true when a prompt failure should not surface as a chat error (user Stop, etc.).
 *
 * @param message - Serialized error (`Error.message` or stderr snippet).
 * @param flags - Turn-local intent flags from the provider.
 */
export function shouldSuppressCursorPromptError(
  message: string,
  flags: { pendingUserStopAbort: boolean },
): boolean {
  if (!flags.pendingUserStopAbort) return false;
  return looksLikeUpstreamStreamCancel(message) || looksLikeAcpConnectionClosed(message);
}

/**
 * Returns whether a Cursor CLI `prompt` rejection likely indicates a retryable flake.
 *
 * Intentionally conservative: only obvious transport or generic HTTP outages qualify.
 *
 * @param message - Serialized error (`Error.message` or stderr snippet).
 */
export function isLikelyTransientCursorPromptFailure(message: string): boolean {
  return (
    TRANSIENT_RE.test(message) ||
    looksLikeUpstreamStreamCancel(message) ||
    looksLikeAcpConnectionClosed(message) ||
    looksLikeCursorRateLimit(message)
  );
}
