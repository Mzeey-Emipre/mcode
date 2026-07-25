import { randomBytes } from "node:crypto";
import type { InternalThreadControlAuthority } from "./thread-control-service.js";

/** Mutable server-owned lease for an internal provider-session MCP credential. */
interface ActiveLease {
  sourceThreadId: string;
  sourceTurnId: string;
  sourceProviderId: string;
  permissionMode: "supervised" | "full";
  active: boolean;
}

/** Provider turn fields used to activate the internal MCP authority. */
export interface ActivateInternalThreadControlMcpLease {
  sessionId: string;
  sourceThreadId: string;
  sourceTurnId: string;
  sourceProviderId: string;
  permissionMode: "supervised" | "full";
}

/** Opaque credential and stable session binding supplied to a provider transport. */
export interface InternalThreadControlMcpLease {
  credential: string;
  sessionId: string;
}

/** Owns opaque credentials and revocable authority for internal MCP sessions. */
export class InternalThreadControlMcpAuthority {
  private readonly leases = new Map<string, { credential: string; active?: ActiveLease }>();

  /** Activates a turn lease without rotating its pooled session credential. */
  activate(input: ActivateInternalThreadControlMcpLease): InternalThreadControlMcpLease {
    const entry = this.leases.get(input.sessionId) ?? { credential: randomBytes(32).toString("base64url") };
    entry.active = {
      sourceThreadId: input.sourceThreadId,
      sourceTurnId: input.sourceTurnId,
      sourceProviderId: input.sourceProviderId,
      permissionMode: input.permissionMode,
      active: true,
    };
    this.leases.set(input.sessionId, entry);
    return { credential: entry.credential, sessionId: input.sessionId };
  }

  /** Resolves the active lease only when its bearer credential remains valid. */
  authorize(credential: string, sourceToolCallId: string): InternalThreadControlAuthority | undefined {
    if (sourceToolCallId.length < 1 || sourceToolCallId.length > 128) return undefined;
    for (const entry of this.leases.values()) {
      if (entry.credential !== credential || !entry.active?.active) continue;
      return {
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
    return this.leases.get(sessionId)?.credential;
  }

  /** Revokes the active turn lease while retaining the credential for pooled reuse. */
  revoke(sessionId: string): void {
    const entry = this.leases.get(sessionId);
    if (entry?.active) entry.active.active = false;
  }

  /** Removes a closed transport and its credential permanently. */
  close(sessionId: string): void {
    this.leases.delete(sessionId);
  }
}
