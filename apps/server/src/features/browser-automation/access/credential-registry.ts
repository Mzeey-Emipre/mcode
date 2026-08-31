import * as NodeCrypto from "node:crypto";
import {
  BROWSER_AUTOMATION_OPERATIONS,
  type BrowserAutomationPublicOperation,
} from "@mcode/contracts";

const DEFAULT_IDLE_TTL_MS = 30 * 60_000;
const DEFAULT_ABSOLUTE_TTL_MS = 8 * 60 * 60_000;
const DEFAULT_MAX_CREDENTIALS = 256;
const OBSERVE_OPERATIONS = new Set<BrowserAutomationPublicOperation>([
  "inspect",
]);

/** Permission boundary attached to a browser automation credential. */
export type BrowserAutomationPermissionCapability = "observe" | "interact" | "privileged";

/** Immutable scope supplied when issuing a browser automation credential. */
export interface BrowserAutomationCredentialScope {
  providerId: string;
  providerSessionId: string;
  mcodeSessionId: string;
  threadId: string;
  workspaceId: string;
  worktreeIdentity: string;
  permissionCapability: BrowserAutomationPermissionCapability;
  allowedOperations: readonly BrowserAutomationPublicOperation[];
}

/** Validated credential claims safe to use for authorization and routing. */
export interface BrowserAutomationCredentialClaims extends BrowserAutomationCredentialScope {
  credentialId: string;
  issuedAt: number;
  expiresAt: number;
}

/** Newly issued plaintext credential and its non-secret metadata. */
export interface IssuedBrowserAutomationCredential {
  token: string;
  credentialId: string;
  expiresAt: number;
}

interface StoredCredential {
  digest: Buffer;
  claims: BrowserAutomationCredentialClaims;
  idleExpiresAt: number;
  lastTouchedAt: number;
}

/** Notification emitted whenever a credential is revoked, expires, or is evicted. */
export type BrowserAutomationCredentialRemovedListener = (
  claims: BrowserAutomationCredentialClaims,
) => void;

/** Options controlling browser credential lifetime and bounded retention. */
export interface BrowserAutomationCredentialRegistryOptions {
  idleTtlMs?: number;
  absoluteTtlMs?: number;
  maxCredentials?: number;
  now?: () => number;
}

function digestToken(token: string): Buffer {
  return NodeCrypto.createHash("sha256").update(token, "utf8").digest();
}

function validateScope(scope: BrowserAutomationCredentialScope): void {
  const ids = [
    scope.providerId,
    scope.providerSessionId,
    scope.mcodeSessionId,
    scope.threadId,
    scope.workspaceId,
    scope.worktreeIdentity,
  ];
  if (ids.some((value) => value.length < 1 || value.length > 256)) {
    throw new Error("Browser automation credential scope contains an invalid identifier");
  }
  const supported = new Set<BrowserAutomationPublicOperation>(BROWSER_AUTOMATION_OPERATIONS);
  if (
    scope.allowedOperations.length < 1 ||
    scope.allowedOperations.length > BROWSER_AUTOMATION_OPERATIONS.length ||
    new Set(scope.allowedOperations).size !== scope.allowedOperations.length ||
    scope.allowedOperations.some((operation) => !supported.has(operation))
  ) {
    throw new Error("Browser automation credential operations are invalid");
  }
  if (
    scope.permissionCapability === "observe" &&
    scope.allowedOperations.some((operation) => !OBSERVE_OPERATIONS.has(operation))
  ) {
    throw new Error("Observe credentials can only use read-only browser operations");
  }
  if (scope.permissionCapability !== "privileged" && scope.allowedOperations.includes("evaluate")) {
    throw new Error("Evaluate requires a privileged browser automation credential");
  }
}

function validateRegistryLimits(idleTtlMs: number, absoluteTtlMs: number, maxCredentials: number): void {
  if (!Number.isInteger(idleTtlMs) || idleTtlMs < 1 || idleTtlMs > 24 * 60 * 60_000) {
    throw new Error("Browser automation credential idle TTL is invalid");
  }
  if (!Number.isInteger(absoluteTtlMs) || absoluteTtlMs < idleTtlMs || absoluteTtlMs > 24 * 60 * 60_000) {
    throw new Error("Browser automation credential absolute TTL is invalid");
  }
  if (!Number.isInteger(maxCredentials) || maxCredentials < 1 || maxCredentials > 4_096) {
    throw new Error("Browser automation credential capacity is invalid");
  }
}

/** Issues, validates, touches, and revokes bounded browser automation credentials. */
export class BrowserAutomationCredentialRegistry {
  private readonly credentials = new Map<string, StoredCredential>();
  private readonly idleTtlMs: number;
  private readonly absoluteTtlMs: number;
  private readonly maxCredentials: number;
  private readonly now: () => number;
  private readonly removedListeners = new Set<BrowserAutomationCredentialRemovedListener>();

  constructor(options: BrowserAutomationCredentialRegistryOptions = {}) {
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.absoluteTtlMs = options.absoluteTtlMs ?? DEFAULT_ABSOLUTE_TTL_MS;
    this.maxCredentials = options.maxCredentials ?? DEFAULT_MAX_CREDENTIALS;
    this.now = options.now ?? Date.now;
    validateRegistryLimits(this.idleTtlMs, this.absoluteTtlMs, this.maxCredentials);
  }

  /** Issues an opaque credential while retaining only its SHA-256 digest. */
  issue(scope: BrowserAutomationCredentialScope): IssuedBrowserAutomationCredential {
    validateScope(scope);
    const now = this.now();
    this.sweepExpired(now);
    while (this.credentials.size >= this.maxCredentials) this.evictLeastRecentlyUsed();

    const credentialId = NodeCrypto.randomBytes(16).toString("hex");
    const token = NodeCrypto.randomBytes(32).toString("base64url");
    const claims: BrowserAutomationCredentialClaims = {
      ...scope,
      allowedOperations: [...scope.allowedOperations],
      credentialId,
      issuedAt: now,
      expiresAt: now + this.absoluteTtlMs,
    };
    const idleExpiresAt = Math.min(claims.expiresAt, now + this.idleTtlMs);
    this.credentials.set(credentialId, {
      digest: digestToken(token),
      claims,
      idleExpiresAt,
      lastTouchedAt: now,
    });
    return { token, credentialId, expiresAt: idleExpiresAt };
  }

  /** Authenticates an opaque token using constant-time digest comparison. */
  authenticate(token: string): BrowserAutomationCredentialClaims | null {
    if (token.length < 20 || token.length > 256) return null;
    const now = this.now();
    this.sweepExpired(now);
    const candidate = digestToken(token);
    let matched: StoredCredential | null = null;
    for (const stored of this.credentials.values()) {
      if (NodeCrypto.timingSafeEqual(stored.digest, candidate)) {
        matched = stored;
      }
    }
    if (!matched) return null;
    matched.lastTouchedAt = now;
    matched.idleExpiresAt = Math.min(matched.claims.expiresAt, now + this.idleTtlMs);
    return { ...matched.claims, allowedOperations: [...matched.claims.allowedOperations] };
  }

  /** Extends one credential from the current time without revealing its token. */
  touch(credentialId: string): boolean {
    const stored = this.credentials.get(credentialId);
    if (!stored) return false;
    const now = this.now();
    if (stored.claims.expiresAt <= now || stored.idleExpiresAt <= now) {
      this.remove(credentialId);
      return false;
    }
    stored.lastTouchedAt = now;
    stored.idleExpiresAt = Math.min(stored.claims.expiresAt, now + this.idleTtlMs);
    return true;
  }

  /** Revokes one credential by its non-secret identifier. */
  revoke(credentialId: string): boolean {
    return this.remove(credentialId);
  }

  /** Revokes every credential owned by one provider session. */
  revokeProviderSession(providerId: string, providerSessionId: string): number {
    let removed = 0;
    for (const [id, stored] of this.credentials) {
      if (stored.claims.providerId === providerId && stored.claims.providerSessionId === providerSessionId) {
        this.remove(id);
        removed++;
      }
    }
    return removed;
  }

  /** Returns the number of currently retained live credential digests. */
  size(): number {
    this.sweepExpired(this.now());
    return this.credentials.size;
  }

  /** Subscribes to authoritative removal checkpoints for external lifecycle cleanup. */
  onRemoved(listener: BrowserAutomationCredentialRemovedListener): () => void {
    this.removedListeners.add(listener);
    return () => this.removedListeners.delete(listener);
  }

  private sweepExpired(now: number): void {
    for (const [id, stored] of this.credentials) {
      if (stored.claims.expiresAt <= now || stored.idleExpiresAt <= now) {
        this.remove(id);
      }
    }
  }

  private evictLeastRecentlyUsed(): void {
    let oldest: [string, StoredCredential] | undefined;
    for (const entry of this.credentials) {
      if (!oldest || entry[1].lastTouchedAt < oldest[1].lastTouchedAt) oldest = entry;
    }
    if (oldest) this.remove(oldest[0]);
  }

  private remove(credentialId: string): boolean {
    const stored = this.credentials.get(credentialId);
    if (!stored || !this.credentials.delete(credentialId)) return false;
    const claims = { ...stored.claims, allowedOperations: [...stored.claims.allowedOperations] };
    for (const listener of this.removedListeners) {
      try {
        listener(claims);
      } catch {
        // Credential removal remains authoritative when external cleanup fails.
      }
    }
    return true;
  }
}
