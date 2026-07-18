import {
  BROWSER_AUTOMATION_OPERATIONS,
  type BrowserAutomationOperation,
  type InteractionMode,
} from "@mcode/contracts";
import {
  BrowserAutomationCredentialRegistry,
  type BrowserAutomationPermissionCapability,
} from "./credential-registry.js";

const OBSERVE_OPERATIONS = new Set<BrowserAutomationOperation>([
  "status",
  "snapshot",
  "screenshot",
  "waitFor",
  "console",
  "network",
  "accessibility",
  "performance",
]);

/** Stable server endpoint configuration used for provider MCP sessions. */
export interface BrowserAutomationAccessConfiguration {
  mcpUrl: string;
  worktreeIdentity: string;
}

/** Scope required to grant one normal provider session browser access. */
export interface BrowserAutomationAccessRequest {
  providerId: string;
  providerSessionId: string;
  mcodeSessionId: string;
  threadId: string;
  workspaceId: string;
  permissionCapability: BrowserAutomationPermissionCapability;
}

/** Plaintext grant returned only while a provider creates its main session. */
export interface BrowserAutomationAccessGrant {
  mcpUrl: string;
  token: string;
  credentialId: string;
  expiresAt: number;
  allowedOperations: readonly BrowserAutomationOperation[];
}

/** Non-secret metadata retained with a live provider session. */
export interface BrowserAutomationCredentialMetadata {
  credentialId: string;
  expiresAt: number;
}

/** Non-secret scope emitted after one browser credential has been removed. */
export interface BrowserAutomationCredentialRevocation {
  readonly credentialId: string;
  readonly providerId: string;
  readonly providerSessionId: string;
}

/** Notification emitted after one credential has been removed. */
export type BrowserAutomationCredentialRevokedListener = (
  revocation: BrowserAutomationCredentialRevocation,
) => void;

/** Maps turn controls onto the browser gateway's three permission classes. */
export function browserAutomationPermissionCapability(
  permissionMode: string,
  interactionMode: InteractionMode,
): BrowserAutomationPermissionCapability {
  if (interactionMode === "plan") return "observe";
  return permissionMode === "full" ? "privileged" : "interact";
}

function allowedOperations(
  capability: BrowserAutomationPermissionCapability,
): readonly BrowserAutomationOperation[] {
  if (capability === "observe") {
    return BROWSER_AUTOMATION_OPERATIONS.filter((operation) => OBSERVE_OPERATIONS.has(operation));
  }
  if (capability === "interact") {
    return BROWSER_AUTOMATION_OPERATIONS.filter((operation) => operation !== "evaluate");
  }
  return [...BROWSER_AUTOMATION_OPERATIONS];
}

function validateConfiguration(configuration: BrowserAutomationAccessConfiguration): void {
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

/**
 * Issues provider-scoped browser credentials through one shared registry and
 * coordinates lifecycle cleanup without exposing plaintext tokens globally.
 */
export class BrowserAutomationAccessService {
  private configuration: BrowserAutomationAccessConfiguration | null = null;
  private readonly liveBySession = new Map<string, string>();
  private readonly scopeByCredential = new Map<
    string,
    Pick<BrowserAutomationAccessRequest, "providerId" | "providerSessionId">
  >();
  private readonly listeners = new Set<BrowserAutomationCredentialRevokedListener>();

  constructor(
    /** Shared registry consumed by the loopback MCP authentication handler. */
    readonly credentials: BrowserAutomationCredentialRegistry = new BrowserAutomationCredentialRegistry(),
  ) {
    this.credentials.onRemoved((claims) => {
      this.releaseCredentialMetadata(claims.credentialId, {
        providerId: claims.providerId,
        providerSessionId: claims.providerSessionId,
      });
    });
  }

  /** Configures the exact loopback endpoint once; an identical repeat is harmless. */
  configure(configuration: BrowserAutomationAccessConfiguration): void {
    validateConfiguration(configuration);
    if (this.configuration) {
      if (
        this.configuration.mcpUrl !== configuration.mcpUrl ||
        this.configuration.worktreeIdentity !== configuration.worktreeIdentity
      ) {
        throw new Error("Browser automation access is already configured");
      }
      return;
    }
    this.configuration = { ...configuration };
  }

  /** Returns whether the composition root supplied a usable MCP endpoint. */
  isConfigured(): boolean {
    return this.configuration !== null;
  }

  /**
   * Rotates and returns a credential for a normal provider session. An
   * unconfigured server omits browser MCP rather than leaking a partial grant.
   */
  issue(request: BrowserAutomationAccessRequest): BrowserAutomationAccessGrant | null {
    const configuration = this.configuration;
    if (!configuration) return null;

    const sessionKey = this.sessionKey(request.providerId, request.mcodeSessionId);
    const previous = this.liveBySession.get(sessionKey);
    if (previous) this.revokeCredential(previous);

    const operations = allowedOperations(request.permissionCapability);
    const issued = this.credentials.issue({
      ...request,
      worktreeIdentity: configuration.worktreeIdentity,
      allowedOperations: operations,
    });
    this.liveBySession.set(sessionKey, issued.credentialId);
    this.scopeByCredential.set(issued.credentialId, {
      providerId: request.providerId,
      providerSessionId: request.providerSessionId,
    });
    return {
      mcpUrl: configuration.mcpUrl,
      token: issued.token,
      credentialId: issued.credentialId,
      expiresAt: issued.expiresAt,
      allowedOperations: operations,
    };
  }

  /** Revokes one credential and releases downstream broker or MCP state. */
  revokeCredential(credentialId: string): boolean {
    return this.credentials.revoke(credentialId);
  }

  private releaseCredentialMetadata(
    credentialId: string,
    fallbackScope: Pick<BrowserAutomationAccessRequest, "providerId" | "providerSessionId">,
  ): void {
    const scope = this.scopeByCredential.get(credentialId) ?? fallbackScope;
    this.scopeByCredential.delete(credentialId);
    for (const [key, liveCredentialId] of this.liveBySession) {
      if (liveCredentialId === credentialId) this.liveBySession.delete(key);
    }
    const revocation: BrowserAutomationCredentialRevocation = {
      credentialId,
      providerId: scope.providerId,
      providerSessionId: scope.providerSessionId,
    };
    for (const listener of this.listeners) {
      try {
        listener(revocation);
      } catch {
        // Credential revocation is authoritative even if downstream cleanup fails.
      }
    }
  }

  /** Revokes the current credential for one logical Mcode provider session. */
  revokeSession(providerId: string, mcodeSessionId: string): boolean {
    const credentialId = this.liveBySession.get(this.sessionKey(providerId, mcodeSessionId));
    return credentialId ? this.revokeCredential(credentialId) : false;
  }

  /** Subscribes a broker or MCP handler to credential-release checkpoints. */
  onCredentialRevoked(listener: BrowserAutomationCredentialRevokedListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Revokes every provider credential during server shutdown. */
  shutdown(): void {
    for (const credentialId of [...this.liveBySession.values()]) {
      this.revokeCredential(credentialId);
    }
    this.liveBySession.clear();
    this.scopeByCredential.clear();
  }

  private sessionKey(providerId: string, mcodeSessionId: string): string {
    return JSON.stringify([providerId, mcodeSessionId]);
  }
}
