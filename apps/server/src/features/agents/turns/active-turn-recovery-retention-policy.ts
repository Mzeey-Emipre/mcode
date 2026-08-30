/** Retention limits for one unfinished parent assistant response. */
export const PARENT_ASSISTANT_TEXT_RETAINED_LIMITS = {
  maxBytes: 256 * 1024,
  maxChunks: 16_384,
} as const;

/** Semantic retention limits shared by active-turn recovery paths. */
export const ACTIVE_TURN_RECOVERY_RETAINED_LIMITS = {
  maxBytes: PARENT_ASSISTANT_TEXT_RETAINED_LIMITS.maxBytes,
  maxRecords: PARENT_ASSISTANT_TEXT_RETAINED_LIMITS.maxChunks,
} as const;

/** Reject active-turn recovery data that exceeds its semantic retention budget. */
export function assertActiveTurnRecoveryRetention(recordCount: number, byteLength: number): void {
  if (recordCount > ACTIVE_TURN_RECOVERY_RETAINED_LIMITS.maxRecords) {
    throw new Error("Active-turn recovery retained record capacity reached");
  }
  if (byteLength > ACTIVE_TURN_RECOVERY_RETAINED_LIMITS.maxBytes) {
    throw new Error("Active-turn recovery retained byte capacity reached");
  }
}
