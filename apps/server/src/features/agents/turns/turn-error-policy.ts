/**
 * Classifies a failed turn as `transient` or `fatal` and gates an automatic
 * retry on an attempt cap.
 */

/** Whether a turn failure is worth one automatic retry (`transient`) or not (`fatal`). */
export type TurnErrorKind = "transient" | "fatal";

/**
 * Explicit allowlist of known-transient failure signatures. Deliberately small:
 * the policy retries only failures with strong evidence of being a brief flake,
 * so a misclassified fatal error never enters the retry path in the first place.
 *
 * - Stale pooled session: a resume against a session the provider already
 *   abandoned, surfaced as an ACP disconnect or an invalidated-session message.
 * - Subprocess spawn race: a transient spawn failure (`EAGAIN`, `ETXTBSY`).
 *   `ENOENT` is intentionally excluded — a missing CLI is fatal, not a flake.
 * - Brief network blip: a dropped or timed-out connection to the provider
 *   (`ECONNRESET`, `ETIMEDOUT`, `socket hang up`, `fetch failed`).
 * - Codex MCP transport churn: Codex app-server can exit when a configured
 *   MCP transport disappears mid-session. A fresh app-server session gets one
 *   retry, while normal MCP startup failures are reported through provider
 *   status notifications rather than treated as Mcode initialization failure.
 */
const TRANSIENT_SIGNATURES: readonly RegExp[] = [
  /\bacp connection closed\b/i,
  /\bsession invalidated\b/i,
  /\bspawn\b[^]*\bEAGAIN\b/i,
  /\bETXTBSY\b/i,
  /\bECONNRESET\b/i,
  /\bETIMEDOUT\b/i,
  /\bsocket hang up\b/i,
  /\bfetch failed\b/i,
  /\bstream disconnected before completion\b/i,
  /\btransport channel closed\b/i,
  /\bhttp\/request failed\b/i,
];

/** One original send plus one automatic retry. */
const DEFAULT_MAX_ATTEMPTS = 2;

/** Decides retry eligibility for a failed turn from an explicit transient-signature allowlist. */
export class TurnErrorPolicy {
  /**
   * @param maxAttempts - Total attempts allowed per turn, including the original
   *   send. Defaults to {@link DEFAULT_MAX_ATTEMPTS} (one automatic retry). The
   *   cap is what stops a misclassified fatal error from looping.
   */
  constructor(private readonly maxAttempts: number = DEFAULT_MAX_ATTEMPTS) {}

  /**
   * Classify a turn failure against the transient allowlist.
   *
   * @param err - The error thrown by the turn (an `Error`, a string, or any value).
   */
  classify(err: unknown): TurnErrorKind {
    const message = err instanceof Error ? err.message : String(err);
    return TRANSIENT_SIGNATURES.some((re) => re.test(message)) ? "transient" : "fatal";
  }

  /**
   * Decide whether a failed turn should be retried against a fresh session.
   * Retries only a {@link classify}-transient failure that has not yet hit the
   * attempt cap.
   *
   * @param err - The error that ended the turn.
   * @param attempt - Attempts made so far, 1-based (the original send is `1`).
   */
  shouldRetry(err: unknown, attempt: number): boolean {
    if (this.classify(err) !== "transient") return false;
    return attempt < this.maxAttempts;
  }
}
