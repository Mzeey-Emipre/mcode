import { randomBytes, randomUUID } from "node:crypto";
import { CodexProvider as PackageCodexProvider } from "../../private/codex/codex-provider.js";
import type { CodexProviderPorts } from "../../factory-types.js";
import type {
  ProviderBrowserLeaseGrant,
  ProviderBrowserLeaseHandle,
  ProviderBrowserLeaseRequest,
  ProviderHostPorts,
} from "../../host-ports.js";
import type { TurnRequest } from "@mcode/contracts";

interface TestBrowserScope extends ProviderBrowserLeaseRequest {}

interface TestPendingLease {
  scope: TestBrowserScope;
}

/** Small in-memory credential registry used by provider tests without server DI. */
export class TestCredentialRegistry {
  private readonly tokens = new Set<string>();

  /** Returns the number of credentials retained by the fixture. */
  size(): number {
    return this.tokens.size;
  }

  /** Returns a truthy authentication result for a currently retained token. */
  authenticate(token: string): object | null {
    return this.tokens.has(token) ? {} : null;
  }

  add(token: string): void {
    this.tokens.add(token);
  }

  remove(token: string): void {
    this.tokens.delete(token);
  }

  /** Clears all credentials when the owning lease shuts down. */
  clear(): void {
    this.tokens.clear();
  }
}

/** Returns a process-environment authority for provider unit tests. */
export function stubEnvService(): { getEnv(): Record<string, string> } {
  return {
    getEnv: () => Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
  };
}

/** Provider-neutral browser lease test double for Codex lifecycle coverage. */
export class BrowserAutomationSessionLease {
  readonly credentials = new TestCredentialRegistry();
  private readonly pending = new Map<string, TestPendingLease>();
  private readonly active = new Map<string, { token: string; credentialId: string; scope: TestBrowserScope }>();
  private configured = false;

  /** Configures the endpoint used in generated grants. */
  configure(_configuration: { mcpUrl: string; worktreeIdentity: string }): void {
    this.configured = true;
  }

  /** Reports whether credentials can be issued. */
  isConfigured(): boolean {
    return this.configured;
  }

  /** Stages one browser scope. */
  stage(scope: TestBrowserScope): ProviderBrowserLeaseHandle {
    const leaseId = randomUUID();
    this.pending.set(leaseId, { scope });
    return { leaseId, expiresAt: Date.now() + 30_000 };
  }

  /** Issues a credential for either a staged handle or a complete scope. */
  issue(
    stageOrScope: ProviderBrowserLeaseHandle | TestBrowserScope,
  ): ProviderBrowserLeaseGrant | null {
    const stage = "leaseId" in stageOrScope ? stageOrScope : this.stage(stageOrScope);
    const pending = this.pending.get(stage.leaseId);
    this.pending.delete(stage.leaseId);
    if (!pending || !this.configured) return null;
    const token = randomBytes(32).toString("base64url");
    const credentialId = randomUUID();
    this.credentials.add(token);
    this.active.set(stage.leaseId, { token, credentialId, scope: pending.scope });
    return {
      leaseId: stage.leaseId,
      mcpUrl: "http://127.0.0.1:19400/mcp",
      token,
      credentialId,
      expiresAt: stage.expiresAt,
      allowedOperations: pending.scope.permissionCapability === "observe"
        ? ["inspect"]
        : ["inspect", "click", "type", "evaluate"],
    };
  }

  /** Releases one active or pending lease. */
  release(leaseId: string): { leaseId: string; released: boolean; credentialId?: string } {
    this.pending.delete(leaseId);
    const active = this.active.get(leaseId);
    if (!active) return { leaseId, released: false };
    this.active.delete(leaseId);
    this.credentials.remove(active.token);
    return { leaseId, released: true, credentialId: active.credentialId };
  }

  /** Releases every lease belonging to one provider session. */
  releaseSession(providerId: string, sessionId: string): number {
    let released = 0;
    for (const [leaseId, active] of this.active) {
      if (active.scope.providerId === providerId && active.scope.mcodeSessionId === sessionId) {
        this.credentials.remove(active.token);
        this.active.delete(leaseId);
        released += 1;
      }
    }
    for (const [leaseId, pending] of this.pending) {
      if (pending.scope.providerId === providerId && pending.scope.mcodeSessionId === sessionId) {
        this.pending.delete(leaseId);
        released += 1;
      }
    }
    return released;
  }

  /** Revokes credentials by opaque id; lifecycle tests only require a boolean. */
  revokeCredential(credentialId: string): boolean {
    for (const [leaseId, active] of this.active) {
      if (active.credentialId !== credentialId) continue;
      this.active.delete(leaseId);
      this.credentials.remove(active.token);
      return true;
    }
    return true;
  }

  /** Returns bounded lease counts. */
  status(): { active: number; pending: number } {
    return { active: this.active.size, pending: this.pending.size };
  }

  /** Releases all credentials and pending scopes. */
  shutdown(): void {
    this.active.clear();
    this.pending.clear();
    this.credentials.clear();
  }
}

/** Builds the package-private Codex Provider with local test authorities. */
export class CodexProvider extends PackageCodexProvider {
  readonly settingsService!: { get(): unknown | Promise<unknown> };

  constructor(
    settings: { get(): unknown | Promise<unknown> },
    environment: { getEnv(): Record<string, string> },
    attachments: CodexProviderPorts["attachments"],
    catalog: CodexProviderPorts["catalog"],
    browser = new BrowserAutomationSessionLease(),
    threadControl?: {
      createCodexConfiguration?: (sessionId: string) => Promise<unknown>;
      close?: (sessionId: string) => Promise<void>;
    },
  ) {
    const delegatedSettingsService = { get: () => settings.get() };
    const host: ProviderHostPorts = {
      environment: { snapshot: () => environment.getEnv() },
      processes: { attach: () => undefined, terminateTree: async () => undefined },
      browser: {
        stage: (request) => browser.stage(request),
        releaseSession: (providerId, sessionId) => browser.releaseSession(providerId, sessionId),
        isConfigured: () => browser.isConfigured(),
        issue: (stage) => browser.issue(stage),
        release: (leaseId) => browser.release(leaseId),
        revokeCredential: (credentialId) => browser.revokeCredential(credentialId),
      },
      threadControl: {
        bootstrap: async ({ sessionId }) => threadControl?.createCodexConfiguration?.(sessionId) ?? null,
        close: (sessionId) => threadControl?.close?.(sessionId) ?? Promise.resolve(),
      },
      grants: { consume: () => false },
      events: { submit: async () => undefined },
    };
    const codexPorts: CodexProviderPorts = {
      settings: {
        get: async () => {
          const value = await delegatedSettingsService.get() as {
            provider?: { cli?: { codex?: string }; codex?: { fastMode?: boolean } };
          };
          return {
            cliPath: value.provider?.cli?.codex || "codex",
            fastMode: value.provider?.codex?.fastMode === true,
          };
        },
      },
      attachments,
      catalog,
    };
    super(host, codexPorts, 10 * 60 * 1_000);
    this.settingsService = delegatedSettingsService;
  }

  /** Preserve legacy fixture behavior unless a test explicitly exercises the gate. */
  override sendTurn(request: TurnRequest<"codex">): Promise<void> {
    return super.sendTurn({
      ...request,
      threadControlEligible: request.threadControlEligible ?? true,
    });
  }
}
