import "reflect-metadata";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
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

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: spawnMock };
});

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
    provider.id = "cursor";
    provider.browserAutomationLease = lease;
    provider.pendingPermissions = new Map();
    provider.pendingBrowserGrants = new Map();
    provider.liveSessionIds = new Set(["mcode-a"]);

    provider.close({ mcodeSessionId: "mcode-a" } as never);

    expect(lease.credentials.authenticate(grant.token)).toBeNull();
    expect(lease.status()).toEqual({ active: 0, pending: 0 });
    expect(provider.liveSessionIds.has("mcode-a")).toBe(false);
  });

  it("kills spawned child and releases staged lease when issuance fails", async () => {
    const lease = configuredLease();
    const staged = lease.stage(browserScope({ allowedOperations: ["evaluate"] } as never));
    const child = { pid: 101, kill: vi.fn() };
    const provider = Object.create(CursorProvider.prototype) as any;
    provider.settingsService = { get: vi.fn(() => ({})) };
    provider.browserAutomationLease = lease;
    provider.pendingBrowserLeases = new Map([["mcode-a", staged]]);
    provider.pendingBrowserContext = new Map();
    provider.pendingBrowserGrants = new Map();
    provider.pendingBrowserGrantContext = new Map();
    provider.liveSessionIds = new Set();
    provider.spawnChild = vi.fn().mockResolvedValue({ child, browserHttpMcpSupported: true });

    await expect(provider.spawn({
      sessionId: "mcode-a",
      threadId: "thread-a",
      cwd: ".",
      permissionMode: "default",
      env: {},
    })).rejects.toThrow(/Evaluate requires/);

    expect(child.kill).toHaveBeenCalledOnce();
    expect(lease.status()).toEqual({ active: 0, pending: 0 });
  });

  it("releases staged and refreshed leases and omits MCP when HTTP support is unavailable", async () => {
    const lease = configuredLease();
    const staged = lease.stage(browserScope());
    const refreshed = lease.issue(browserScope());
    const child = { pid: 102, kill: vi.fn() };
    const provider = Object.create(CursorProvider.prototype) as any;
    provider.settingsService = { get: vi.fn(() => ({})) };
    provider.browserAutomationLease = lease;
    provider.pendingBrowserLeases = new Map([["mcode-a", staged]]);
    provider.pendingBrowserContext = new Map();
    provider.pendingBrowserGrants = new Map([["mcode-a", refreshed]]);
    provider.pendingBrowserGrantContext = new Map();
    provider.liveSessionIds = new Set();
    provider.spawnChild = vi.fn().mockResolvedValue({ child, browserHttpMcpSupported: false });
    let mcpServers: unknown;
    provider.openLogicalSession = vi.fn(async (_state: unknown, _resume: boolean, servers: unknown) => {
      mcpServers = servers;
    });

    await provider.spawn({
      sessionId: "mcode-a",
      threadId: "thread-a",
      cwd: ".",
      permissionMode: "default",
      env: {},
    });

    expect(mcpServers).toEqual([]);
    expect(lease.status()).toEqual({ active: 0, pending: 0 });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("kills child and releases issued lease when logical session setup fails", async () => {
    const lease = configuredLease();
    const staged = lease.stage(browserScope());
    const child = { pid: 103, kill: vi.fn() };
    const provider = Object.create(CursorProvider.prototype) as any;
    provider.settingsService = { get: vi.fn(() => ({})) };
    provider.browserAutomationLease = lease;
    provider.pendingBrowserLeases = new Map([["mcode-a", staged]]);
    provider.pendingBrowserContext = new Map();
    provider.pendingBrowserGrants = new Map();
    provider.pendingBrowserGrantContext = new Map();
    provider.liveSessionIds = new Set();
    provider.spawnChild = vi.fn().mockResolvedValue({ child, browserHttpMcpSupported: true });
    provider.openLogicalSession = vi.fn().mockRejectedValue(new Error("logical session failed"));

    await expect(provider.spawn({
      sessionId: "mcode-a",
      threadId: "thread-a",
      cwd: ".",
      permissionMode: "default",
      env: {},
    })).rejects.toThrow("logical session failed");

    expect(child.kill).toHaveBeenCalledOnce();
    expect(lease.status()).toEqual({ active: 0, pending: 0 });
  });

  it("kills child when ACP handshake fails before spawn returns", async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      pid: 104,
      kill: vi.fn(),
    });
    spawnMock.mockReturnValue(child as never);
    const provider = Object.create(CursorProvider.prototype) as any;
    provider.envService = { getEnv: vi.fn(() => ({})) };
    provider.settingsService = { get: vi.fn(() => ({ provider: { cursor: { verboseFailureLogs: false } } })) };
    provider.pendingBrowserContext = new Map();
    vi.spyOn(provider, "acpHandshake").mockRejectedValue(new Error("handshake failed"));

    await expect(provider.spawnOneCli("cursor-agent", "mcode-a", "C:\\", "default")).rejects.toThrow(
      "handshake failed",
    );

    expect(child.kill).toHaveBeenCalledOnce();
    spawnMock.mockReset();
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
