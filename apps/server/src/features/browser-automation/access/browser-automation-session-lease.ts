import {
  BROWSER_V2_CORE_OPERATIONS,
  type BrowserAutomationPublicOperation,
} from "@mcode/contracts";
import { randomUUID } from "crypto";
import {
  BrowserAutomationCredentialRegistry,
  type BrowserAutomationCredentialScope,
  type BrowserAutomationPermissionCapability,
} from "./credential-registry.js";
const DEFAULT_PENDING_TTL_MS = 30_000;
const DEFAULT_MAX_PENDING = 256;

/** Provider-neutral browser scope staged before a credential is issued. */
export interface BrowserAutomationSessionLeaseScope {
  providerId: string;
  providerSessionId: string;
  mcodeSessionId: string;
  threadId: string;
  workspaceId: string;
  permissionCapability: BrowserAutomationPermissionCapability;
  allowedOperations?: readonly BrowserAutomationPublicOperation[];
}

/** Input accepted by the lease staging boundary. */
export type BrowserAutomationSessionLeaseRequest =
  | BrowserAutomationSessionLeaseScope
  | { scope: BrowserAutomationSessionLeaseScope };

/** Loopback endpoint used in grants returned by the lease. */
export interface BrowserAutomationSessionLeaseConfiguration {
  mcpUrl: string;
  worktreeIdentity: string;
}

/** Opaque handle returned while a scope waits for credential issuance. */
export interface BrowserAutomationSessionLeaseStage {
  leaseId: string;
  expiresAt: number;
}

/** Plaintext credential returned once for a newly issued or refreshed lease. */
export interface BrowserAutomationSessionLeaseGrant {
  leaseId: string;
  mcpUrl: string;
  token: string;
  credentialId: string;
  expiresAt: number;
  allowedOperations: readonly BrowserAutomationPublicOperation[];
}

/** Structured result for rotating an active lease credential. */
export type BrowserAutomationSessionLeaseRefreshResult =
  | { ok: true; grant: BrowserAutomationSessionLeaseGrant }
  | { ok: false; leaseId: string; reason: "not-found" | "unconfigured" | "issuance-failed" };

/** Structured result for releasing an active or already released lease. */
export interface BrowserAutomationSessionLeaseReleaseResult {
  leaseId: string;
  released: boolean;
  credentialId?: string;
}

/** Options controlling credential sharing and bounded pending scope retention. */
export interface BrowserAutomationSessionLeaseOptions
  extends Partial<BrowserAutomationSessionLeaseConfiguration> {
  credentials?: BrowserAutomationCredentialRegistry;
  pendingTtlMs?: number;
  maxPending?: number;
  now?: () => number;
}

interface PendingScope {
  scope: BrowserAutomationSessionLeaseScope;
  sessionKey: string;
  expiresAt: number;
}

interface ActiveLease {
  scope: BrowserAutomationSessionLeaseScope;
  sessionKey: string;
  credentialId: string;
}

function browserV2AllowedOperations(
  capability: BrowserAutomationPermissionCapability,
): readonly BrowserAutomationPublicOperation[] {
  if (capability === "observe") return ["inspect"];
  if (capability === "interact") return [...BROWSER_V2_CORE_OPERATIONS];
  return [...BROWSER_V2_CORE_OPERATIONS, "evaluate"];
}

function validateConfiguration(configuration: BrowserAutomationSessionLeaseConfiguration): void {
  let url: URL;
  try {
    url = new URL(configuration.mcpUrl);
  } catch {
    throw new Error("Browser automation MCP URL is invalid");
  }
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
  if (
    url.protocol !== "http:" ||
    !loopbackHosts.has(url.hostname) ||
    url.pathname !== "/mcp" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Browser automation MCP URL must be an uncredentialed loopback /mcp endpoint");
  }
  if (
    configuration.worktreeIdentity.length < 1 ||
    configuration.worktreeIdentity.length > 256
  ) {
    throw new Error("Browser automation worktree identity is invalid");
  }
}

function normalizeRequest(
  request: BrowserAutomationSessionLeaseRequest,
): BrowserAutomationSessionLeaseScope {
  const scope = "scope" in request ? request.scope : request;
  return {
    ...scope,
    allowedOperations: scope.allowedOperations
      ? [...scope.allowedOperations]
      : browserV2AllowedOperations(scope.permissionCapability),
  };
}

/** Owns provider-neutral browser credential staging and session lease cleanup. */
export class BrowserAutomationSessionLease {
  readonly credentials: BrowserAutomationCredentialRegistry;
  private configuration: BrowserAutomationSessionLeaseConfiguration | null = null;
  private readonly pending = new Map<string, PendingScope>();
  private readonly active = new Map<string, ActiveLease>();
  private readonly sessionToLease = new Map<string, string>();
  private readonly pendingTtlMs: number;
  private readonly maxPending: number;
  private readonly now: () => number;

  constructor(optionsOrCredentials: BrowserAutomationSessionLeaseOptions | BrowserAutomationCredentialRegistry = {}) {
    const options = optionsOrCredentials instanceof BrowserAutomationCredentialRegistry
      ? { credentials: optionsOrCredentials }
      : optionsOrCredentials;
    this.credentials = options.credentials ?? new BrowserAutomationCredentialRegistry();
    this.pendingTtlMs = options.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS;
    this.maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
    this.now = options.now ?? Date.now;
    if (!Number.isInteger(this.pendingTtlMs) || this.pendingTtlMs < 1 || this.pendingTtlMs > 24 * 60 * 60_000) {
      throw new Error("Browser automation session lease pending TTL is invalid");
    }
    if (!Number.isInteger(this.maxPending) || this.maxPending < 1 || this.maxPending > 4_096) {
      throw new Error("Browser automation session lease pending capacity is invalid");
    }
    this.credentials.onRemoved((claims) => this.releaseCredential(claims.credentialId));
    if (options.mcpUrl !== undefined || options.worktreeIdentity !== undefined) {
      if (!options.mcpUrl || !options.worktreeIdentity) {
        throw new Error("Browser automation session lease configuration is incomplete");
      }
      this.configure({ mcpUrl: options.mcpUrl, worktreeIdentity: options.worktreeIdentity });
    }
  }

  /** Configures the exact loopback endpoint used by future grants. */
  configure(configuration: BrowserAutomationSessionLeaseConfiguration): void {
    validateConfiguration(configuration);
    if (this.configuration) {
      if (
        this.configuration.mcpUrl !== configuration.mcpUrl ||
        this.configuration.worktreeIdentity !== configuration.worktreeIdentity
      ) {
        throw new Error("Browser automation session lease is already configured");
      }
      return;
    }
    this.configuration = { ...configuration };
  }

  /** Returns whether the composition root supplied a usable MCP endpoint. */
  isConfigured(): boolean {
    return this.configuration !== null;
  }

  /** Returns whether an active lease still owns a retained registry credential. */
  isActive(leaseId: string): boolean {
    // Registry sweeps expired or evicted credentials from its own accessors and
    // synchronously notifies this lease, so refresh state before checking it.
    this.credentials.size();
    return this.active.has(leaseId);
  }

  /** Stages one bounded scope and returns its opaque lease handle. */
  stage(request: BrowserAutomationSessionLeaseRequest): BrowserAutomationSessionLeaseStage {
    this.cleanupPending();
    if (this.pending.size >= this.maxPending) this.evictOldestPending();
    const scope = normalizeRequest(request);
    const leaseId = randomUUID();
    const sessionKey = this.sessionKey(scope.providerId, scope.mcodeSessionId);
    const expiresAt = this.now() + this.pendingTtlMs;
    this.pending.set(leaseId, { scope, sessionKey, expiresAt });
    return { leaseId, expiresAt };
  }

  /** Issues a credential for a staged handle, cleaning failed stages before rethrowing. */
  issue(stageOrRequest: string | BrowserAutomationSessionLeaseStage | BrowserAutomationSessionLeaseRequest): BrowserAutomationSessionLeaseGrant | null {
    const stage = typeof stageOrRequest === "string" || "leaseId" in stageOrRequest
      ? stageOrRequest
      : this.stage(stageOrRequest);
    const leaseId = typeof stage === "string" ? stage : stage.leaseId;
    const pending = this.pending.get(leaseId);
    if (!pending || pending.expiresAt <= this.now()) {
      this.pending.delete(leaseId);
      return null;
    }
    this.pending.delete(leaseId);
    const configuration = this.configuration;
    if (!configuration) return null;
    try {
      const previousLeaseId = this.sessionToLease.get(pending.sessionKey);
      if (previousLeaseId && previousLeaseId !== leaseId) this.release(previousLeaseId);
      return this.issueCredential(leaseId, pending);
    } catch (error) {
      this.active.delete(leaseId);
      throw error;
    }
  }

  /** Rotates a live lease credential and returns a fresh plaintext grant. */
  refresh(leaseId: string): BrowserAutomationSessionLeaseRefreshResult {
    const lease = this.active.get(leaseId);
    if (!lease) return { ok: false, leaseId, reason: "not-found" };
    if (!this.configuration) return { ok: false, leaseId, reason: "unconfigured" };
    const previousCredentialId = lease.credentialId;
    try {
      this.credentials.revoke(previousCredentialId);
      const grant = this.issueCredential(leaseId, {
        scope: lease.scope,
        sessionKey: lease.sessionKey,
        expiresAt: this.now(),
      });
      return { ok: true, grant };
    } catch {
      return { ok: false, leaseId, reason: "issuance-failed" };
    }
  }

  /** Revokes one lease and releases its metadata and pending scope. */
  release(leaseId: string): BrowserAutomationSessionLeaseReleaseResult {
    const lease = this.active.get(leaseId);
    this.pending.delete(leaseId);
    if (!lease) return { leaseId, released: false };
    const released = this.credentials.revoke(lease.credentialId);
    if (!released) this.releaseCredential(lease.credentialId);
    return { leaseId, released, credentialId: lease.credentialId };
  }

  /** Revokes every lease belonging to one logical provider session. */
  releaseSession(providerId: string, mcodeSessionId: string): number {
    const key = this.sessionKey(providerId, mcodeSessionId);
    const leaseId = this.sessionToLease.get(key);
    let released = leaseId && this.release(leaseId).released ? 1 : 0;
    for (const [pendingLeaseId, pending] of this.pending) {
      if (pending.sessionKey !== key) continue;
      this.pending.delete(pendingLeaseId);
      released++;
    }
    return released;
  }

  /** Revokes a credential by its non-secret registry identifier. */
  revokeCredential(credentialId: string): boolean {
    return this.credentials.revoke(credentialId);
  }

  /** Removes expired staged scopes and returns the number removed. */
  cleanupPending(): number {
    const now = this.now();
    let removed = 0;
    for (const [leaseId, pending] of this.pending) {
      if (pending.expiresAt <= now) {
        this.pending.delete(leaseId);
        removed++;
      }
    }
    return removed;
  }

  /** Revokes all active credentials and drops pending work during shutdown. */
  shutdown(): void {
    for (const lease of [...this.active.values()]) this.credentials.revoke(lease.credentialId);
    this.active.clear();
    this.sessionToLease.clear();
    this.pending.clear();
  }

  /** Returns bounded lifecycle counts for diagnostics and tests. */
  status(): { active: number; pending: number } {
    this.cleanupPending();
    this.credentials.size();
    return { active: this.active.size, pending: this.pending.size };
  }

  private issueCredential(leaseId: string, pending: PendingScope): BrowserAutomationSessionLeaseGrant {
    const configuration = this.configuration;
    if (!configuration) throw new Error("Browser automation session lease is not configured");
    const scope: BrowserAutomationCredentialScope = {
      ...pending.scope,
      worktreeIdentity: configuration.worktreeIdentity,
      allowedOperations: pending.scope.allowedOperations ?? browserV2AllowedOperations(pending.scope.permissionCapability),
    };
    const issued = this.credentials.issue(scope);
    const active: ActiveLease = { scope: pending.scope, sessionKey: pending.sessionKey, credentialId: issued.credentialId };
    this.active.set(leaseId, active);
    this.sessionToLease.set(pending.sessionKey, leaseId);
    return {
      leaseId,
      mcpUrl: configuration.mcpUrl,
      token: issued.token,
      credentialId: issued.credentialId,
      expiresAt: issued.expiresAt,
      allowedOperations: scope.allowedOperations,
    };
  }

  private releaseCredential(credentialId: string): void {
    for (const [leaseId, lease] of this.active) {
      if (lease.credentialId !== credentialId) continue;
      this.active.delete(leaseId);
      if (this.sessionToLease.get(lease.sessionKey) === leaseId) this.sessionToLease.delete(lease.sessionKey);
    }
  }

  private evictOldestPending(): void {
    const oldest = this.pending.keys().next().value as string | undefined;
    if (oldest) this.pending.delete(oldest);
  }

  private sessionKey(providerId: string, mcodeSessionId: string): string {
    return JSON.stringify([providerId, mcodeSessionId]);
  }
}
