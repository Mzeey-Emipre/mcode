/**
 * Versioned resume cursor for one OpenCode upstream session.
 *
 * The cursor wraps the upstream `ses_` id so a stored value can be re-adopted
 * after an app restart. Unknown versions are ignored, never misread: the
 * provider starts fresh instead of resuming the wrong session.
 *
 * The persisted `sdk_session_id` column stays the plain upstream id (legacy
 * v1); versioning lives in the parser, which also accepts the JSON envelope
 * below. No migration is needed.
 */
export type OpenCodeResumeCursor = {
  schemaVersion: 1;
  sessionId: `ses_${string}`;
};

/** Current cursor version. Bump when the envelope shape changes. */
export const OPENCODE_RESUME_CURSOR_VERSION = 1 as const;

function isSessionId(value: unknown): value is `ses_${string}` {
  return typeof value === "string" && value.startsWith("ses_") && value.length > 4;
}

/**
 * Validate an upstream id and return it as the persisted cursor. Plain ids
 * are the v1 cursor; the version check happens in {@link parseOpenCodeResumeCursor}.
 */
export function formatOpenCodeResumeCursor(sessionId: string): string {
  if (!isSessionId(sessionId)) throw new Error(`Invalid OpenCode session id: ${sessionId}`);
  return sessionId;
}

/**
 * Resolve a stored cursor to its upstream `ses_` id, or undefined when the
 * value is absent, malformed, or a newer unknown version. Never throws.
 * Only strings arrive here (`resumeFrom`); anything else is ignored.
 */
export function parseOpenCodeResumeCursor(value: unknown): `ses_${string}` | undefined {
  if (isSessionId(value)) return value;
  if (typeof value !== "string") return undefined;
  const record = parseJsonObject(value);
  if (!record || record.schemaVersion !== OPENCODE_RESUME_CURSOR_VERSION) return undefined;
  return isSessionId(record.sessionId) ? record.sessionId : undefined;
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
