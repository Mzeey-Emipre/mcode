import * as NodeCrypto from "node:crypto";
import type { InternalThreadControlAuthority } from "@mcode/thread-orchestration";

/** Mutable server-owned lease for an internal provider-session MCP credential. */
interface ActiveLease {
  sourceThreadId: string;
  sourceTurnId: string;
  sourceProviderId: string;
  permissionMode: "supervised" | "full";
  active: boolean;
  /** Whether the current user request explicitly authorized Mcode thread control. */
  eligible: boolean;
  controller: AbortController;
}

/** Provider turn fields used to activate the internal MCP authority. */
export interface ActivateInternalThreadControlMcpLease {
  sessionId: string;
  sourceThreadId: string;
  sourceTurnId: string;
  sourceProviderId: string;
  permissionMode: "supervised" | "full";
  /** Explicit per-turn eligibility derived from the original user request. */
  eligible?: boolean;
}

/** Opaque credential and stable session binding supplied to a provider transport. */
export interface InternalThreadControlMcpLease {
  credential: string;
  sessionId: string;
}

/** Compares two bearer values without exposing equal-length match timing. */
export function constantTimeCredentialEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && NodeCrypto.timingSafeEqual(leftBuffer, rightBuffer);
}

/** Owns opaque credentials and revocable authority for internal MCP sessions. */
export class InternalThreadControlMcpAuthority {
  private readonly leases = new Map<string, { credential: string; active?: ActiveLease }>();

  /** Activates a turn lease without rotating its pooled session credential. */
  activate(input: ActivateInternalThreadControlMcpLease): InternalThreadControlMcpLease {
    const entry = this.leases.get(input.sessionId) ?? { credential: NodeCrypto.randomBytes(32).toString("base64url") };
    entry.active?.controller.abort();
    entry.active = {
      sourceThreadId: input.sourceThreadId,
      sourceTurnId: input.sourceTurnId,
      sourceProviderId: input.sourceProviderId,
      permissionMode: input.permissionMode,
      eligible: input.eligible ?? true,
      active: true,
      controller: new AbortController(),
    };
    this.leases.set(input.sessionId, entry);
    return { credential: entry.credential, sessionId: input.sessionId };
  }

  /** Resolves the active lease only when its bearer credential remains valid. */
  authorize(credential: string, sourceToolCallId: string): InternalThreadControlAuthority | undefined {
    if (sourceToolCallId.length < 1 || sourceToolCallId.length > 128) return undefined;
    for (const entry of this.leases.values()) {
      if (!constantTimeCredentialEqual(entry.credential, credential) || !entry.active?.active) continue;
      if (!entry.active.eligible) return undefined;
      return {
        type: "internal",
        userId: "local-user",
        sourceThreadId: entry.active.sourceThreadId,
        sourceTurnId: entry.active.sourceTurnId,
        sourceToolCallId,
        sourceProviderId: entry.active.sourceProviderId,
        permissionMode: entry.active.permissionMode,
      };
    }
    return undefined;
  }

  /** Returns the stable credential only while a provider session remains active. */
  credential(sessionId: string): string | undefined {
    const entry = this.leases.get(sessionId);
    return entry?.active?.active ? entry.credential : undefined;
  }

  /** Returns the revocation signal for one authenticated pooled session. */
  signal(credential: string): AbortSignal | undefined {
    for (const entry of this.leases.values()) {
      if (constantTimeCredentialEqual(entry.credential, credential) && entry.active?.active) {
        return entry.active.controller.signal;
      }
    }
    return undefined;
  }

  /** Revokes the active turn lease while retaining the credential for pooled reuse. */
  revoke(sessionId: string): void {
    const entry = this.leases.get(sessionId);
    if (entry?.active) {
      entry.active.active = false;
      entry.active.controller.abort();
    }
  }

  /** Removes a closed transport and its credential permanently. */
  close(sessionId: string): void {
    this.leases.get(sessionId)?.active?.controller.abort();
    this.leases.delete(sessionId);
  }
}
