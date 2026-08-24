import { createHash } from "node:crypto";

/** Derive the deterministic identity for a turn's synthesized assistant message. */
export function deriveTurnAssistantMessageId(threadId: string, anchorId: string): string {
  return createHash("sha256")
    .update(`${threadId}\u0000${anchorId}\u0000assistant`)
    .digest("hex");
}
