/**
 * Turns raw provider rejection messages into actionable copy without hiding
 * the original exception text downstream users may grep in logs.
 */

function cursorUpstreamPreamble(original: string): string {
  return [
    `The Cursor CLI reported an upstream error (usually Cursor cloud, auth limits, or a stale session token).`,
    `Mcode surfaced the tool error unchanged below.`,
    ``,
    `Try refreshing Cursor CLI auth, shortening very long chats (fork plus summary), or retrying.`,
    ``,
    `Original:`,
    original,
  ].join("\n");
}

/** Matches the Connect/gRPC `resource_exhausted` status (code 8) in any casing. */
const CURSOR_RATE_LIMIT_RE = /\bresource_exhausted\b/i;

function cursorRateLimitMessage(original: string): string {
  return [
    `Cursor's servers are rate-limiting requests for this model (resource_exhausted).`,
    `This is almost always short-term burst throttling from too many requests at once, not a usage cap.`,
    ``,
    `Wait a few seconds and resend, switch to a Fast model, or run fewer agents at the same time.`,
    ``,
    `Original:`,
    original,
  ].join("\n");
}

/**
 * Applies provider-specific substitutions for repetitive failure patterns.
 *
 * @param providerId - Thread provider id (`claude`, `cursor`, etc.).
 * @param message - Raw error string from a provider or subprocess.
 */
export function normalizeAgentProviderError(providerId: string, message: string): string {
  if (
    providerId === "cursor" &&
    !message.startsWith("Cursor's servers are rate-limiting") &&
    CURSOR_RATE_LIMIT_RE.test(message)
  ) {
    return cursorRateLimitMessage(message);
  }

  const cursorPreambleAlready =
    message.startsWith("The Cursor CLI reported an upstream error");
  if (
    providerId === "cursor" &&
    !cursorPreambleAlready &&
    /\binternal\s+server\s+error\b|\b(?:http\s*)?502\b|\b(?:http\s*)?503\b|status\s*code\s*:\s*5\d\d/i.test(
      message,
    )
  ) {
    return cursorUpstreamPreamble(message);
  }

  const hasEnoent = message.includes("ENOENT");
  const spawnWithEnoent = message.includes("spawn") && message.includes("ENOENT");

  if (hasEnoent || spawnWithEnoent) {
    if (providerId === "claude") {
      return "Claude CLI not found. Install it with: npm install -g @anthropic-ai/claude-code\n\nOr set a custom path in Settings > Model.";
    }
    if (providerId === "codex") {
      return "Codex CLI not found. Install it with: npm install -g @openai/codex\n\nOr set a custom path in Settings > Model.";
    }
    if (providerId === "copilot") {
      return "Copilot CLI not found. Install it with: npm install -g @github/copilot\n\nOr set a custom path in Settings > Provider > Copilot CLI path.";
    }
    return `${providerId} CLI not found. Check the CLI path in Settings > Model.`;
  }

  return message;
}
