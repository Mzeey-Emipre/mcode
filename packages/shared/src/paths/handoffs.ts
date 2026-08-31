/**
 * Filesystem path helpers for chat-fork handoff artifacts and per-thread attachments.
 * ULID-based directory naming gives lexicographically sortable, time-ordered handoff history.
 */

import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Generate a new ULID for a handoff directory. ULIDs are 26-char Crockford
 * Base32: 10 chars of timestamp (millisecond precision) + 16 chars of randomness.
 * Lexicographically sortable by creation time — newer handoffs sort later.
 */
export function newHandoffUlid(): string {
  const time = Date.now();
  let timePart = "";
  let t = time;
  for (let i = 9; i >= 0; i--) {
    timePart = CROCKFORD[t % 32] + timePart;
    t = Math.floor(t / 32);
  }
  const rand = NodeCrypto.randomBytes(16);
  let randPart = "";
  for (let i = 0; i < 16; i++) {
    randPart += CROCKFORD[rand[i] % 32];
  }
  return timePart + randPart;
}

/**
 * Returns `<mcodeDir>/threads/<threadId>/handoffs`.
 */
export function resolveThreadHandoffsDir(
  mcodeDir: string,
  threadId: string,
): string {
  return NodePath.join(mcodeDir, "threads", threadId, "handoffs");
}

/**
 * Returns `<mcodeDir>/threads/<threadId>/handoffs/<ulid>`.
 */
export function resolveHandoffDir(
  mcodeDir: string,
  threadId: string,
  ulid: string,
): string {
  return NodePath.join(resolveThreadHandoffsDir(mcodeDir, threadId), ulid);
}

/**
 * Returns `<mcodeDir>/threads/<threadId>/attachments`.
 */
export function resolveThreadAttachmentsDir(
  mcodeDir: string,
  threadId: string,
): string {
  return NodePath.join(mcodeDir, "threads", threadId, "attachments");
}
