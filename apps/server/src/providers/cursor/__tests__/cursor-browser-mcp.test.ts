import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import {
  BrowserAutomationSessionLease,
  type BrowserAutomationSessionLeaseGrant,
  type BrowserAutomationSessionLeaseScope,
  type BrowserAutomationSessionLeaseStage,
} from "../../../services/browser-automation/browser-automation-session-lease.js";
import {
  buildCursorBrowserMcpServers,
  CursorProvider,
  cursorSupportsHttpMcp,
} from "../cursor-provider.js";

const browserScope = (overrides: Partial<BrowserAutomationSessionLeaseScope> = {}) => ({
  providerId: "cursor",
  providerSessionId: "provider-a",
  mcodeSessionId: "mcode-a",
  threadId: "thread-a",
  workspaceId: "workspace-a",
  permissionCapability: "interact" as const,
  ...overrides,
});

function configuredLease(): BrowserAutomationSessionLease {
  const lease = new BrowserAutomationSessionLease();
  lease.configure({ mcpUrl: "http://127.0.0.1:19400/mcp", worktreeIdentity: "worktree-a" });
  return lease;
}

describe("Cursor browser MCP configuration", () => {
  it("uses ACP HTTP headers for a normal main-session grant", () => {
    expect(buildCursorBrowserMcpServers({
      mcpUrl: "http://127.0.0.1:19400/mcp",
      token: "opaque-token",
      credentialId: "credential-a",
      expiresAt: 10,
      allowedOperations: ["status"],
    })).toEqual([{
      type: "http",
      name: "mcode-browser",
      url: "http://127.0.0.1:19400/mcp",
      headers: [{ name: "Authorization", value: "Bearer opaque-token" }],
    }]);
  });

  it("omits MCP when HTTP capability or server configuration is unavailable", () => {
    expect(buildCursorBrowserMcpServers(null)).toEqual([]);
    expect(cursorSupportsHttpMcp({})).toBe(false);
    expect(cursorSupportsHttpMcp({ agentCapabilities: { mcpCapabilities: { http: false } } })).toBe(false);
    expect(cursorSupportsHttpMcp({ agentCapabilities: { mcpCapabilities: { http: true } } })).toBe(true);
  });

  it("releases session lease when Cursor closes a pooled session", () => {
    const lease = configuredLease();
    const grant = lease.issue(browserScope())!;
    const provider = Object.create(CursorProvider.prototype) as any;
    provider.browserAutomationLease = lease;
    provider.pendingPermissions = new Map();
    provider.liveSessionIds = new Set(["mcode-a"]);

    provider.close({ mcodeSessionId: "mcode-a" } as never);

    expect(lease.credentials.authenticate(grant.token)).toBeNull();
    expect(lease.status()).toEqual({ active: 0, pending: 0 });
    expect(provider.liveSessionIds.has("mcode-a")).toBe(false);
  });

  it("keeps a refreshed grant alive while the replacement session is opening", () => {
    const lease = configuredLease();
    const grant = lease.issue(browserScope())!;
    const provider = Object.create(CursorProvider.prototype) as any;
    provider.browserAutomationLease = lease;
    provider.pendingPermissions = new Map();
    provider.pendingBrowserGrants = new Map([["mcode-a", grant]]);
    provider.liveSessionIds = new Set(["mcode-a"]);

    provider.close({ mcodeSessionId: "mcode-a" } as never);

    expect(lease.credentials.authenticate(grant.token)?.mcodeSessionId).toBe("mcode-a");
    lease.release(grant.leaseId);
  });

  it("releases staged and refreshed leases during shutdown", () => {
    const lease = configuredLease();
    const staged = lease.stage(browserScope());
    const grant = lease.issue(browserScope({ mcodeSessionId: "mcode-b", providerSessionId: "provider-b" }))!;
    const provider = Object.create(CursorProvider.prototype) as any;
    provider.browserAutomationLease = lease;
    provider.pendingPermissions = new Map();
    provider.pendingBrowserLeases = new Map([["mcode-a", staged satisfies BrowserAutomationSessionLeaseStage]]);
    provider.pendingBrowserContext = new Map();
    provider.pendingBrowserGrants = new Map([["mcode-b", grant satisfies BrowserAutomationSessionLeaseGrant]]);
    provider.pendingBrowserGrantContext = new Map();
    provider.planQuestionModeThreads = new Set();
    provider.sdkSessionIds = new Map();
    provider.liveSessionIds = new Set();
    provider.runtime = { shutdown: vi.fn().mockResolvedValue(undefined) };

    provider.shutdown();

    expect(lease.credentials.authenticate(grant.token)).toBeNull();
    expect(lease.status()).toEqual({ active: 0, pending: 0 });
  });
});
