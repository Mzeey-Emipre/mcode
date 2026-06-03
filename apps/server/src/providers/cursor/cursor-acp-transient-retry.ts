/**
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
    looksLikeAcpConnectionClosed(message)
  );
}
