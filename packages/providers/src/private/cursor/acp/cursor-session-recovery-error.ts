import { SessionRecoveryFailedError } from "../../protocols/acp/acp-session-runtime.js";

const CURSOR_SESSION_RECOVERY_FAILED_MESSAGE =
  "SessionRecoveryFailed: Cursor could not recover the saved session. Retry starts a new Cursor session.";

/** Returns the safe user-visible message for a Cursor session recovery failure. */
export function cursorSessionRecoveryErrorMessage(error: unknown): string {
  return error instanceof SessionRecoveryFailedError
    ? CURSOR_SESSION_RECOVERY_FAILED_MESSAGE
    : error instanceof Error
      ? error.message
      : String(error);
}
