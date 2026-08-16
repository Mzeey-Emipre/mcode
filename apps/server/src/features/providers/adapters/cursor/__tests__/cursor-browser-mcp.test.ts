import "reflect-metadata";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import {
  BrowserAutomationSessionLease,
  type BrowserAutomationSessionLeaseGrant,
  type BrowserAutomationSessionLeaseScope,
  type BrowserAutomationSessionLeaseStage,
} from "../../../../browser-automation/index.js";
import {
  buildCursorBrowserMcpServers,
  CursorProvider,
  cursorSupportsHttpMcp,
} from "../cursor-provider.js";
import { AcpSessionRuntime } from "../../acp/acp-session-runtime.js";

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
    provider.pendingBrowserLeases = new Map();
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

  it("continues without MCP when browser lease is unconfigured", async () => {
    const lease = new BrowserAutomationSessionLease();
    const child = { pid: 107, kill: vi.fn() };
    const provider = Object.create(CursorProvider.prototype) as any;
    provider.id = "cursor";
    provider.settingsService = { get: vi.fn(() => ({})) };
    provider.browserAutomationLease = lease;
    provider.pendingPermissions = new Map();
    provider.pendingBrowserLeases = new Map();
    provider.pendingBrowserContext = new Map();
    provider.pendingBrowserGrants = new Map();
    provider.pendingBrowserGrantContext = new Map();
    provider.pendingStops = new Set();
    provider.liveSessionIds = new Set();
    provider.planQuestionModeThreads = new Set();
    provider.sdkSessionIds = new Map();
    provider.spawnChild = vi.fn().mockResolvedValue({
      child,
      browserHttpMcpSupported: true,
      turnChain: Promise.resolve(),
    });
    let mcpServers: unknown;
    provider.openLogicalSession = vi.fn(async (_state: unknown, _resume: boolean, servers: unknown) => {
      mcpServers = servers;
    });
    provider.runTurn = vi.fn().mockResolvedValue(undefined);
    provider.runtime = {
      get: vi.fn().mockReturnValue(undefined),
      stop: vi.fn(),
      acquire: vi.fn(async (args: any) => (await provider.spawn({ ...args, env: {} })).state),
      recordUsage: vi.fn(),
    };

    await provider.sendTurn({
      turnExecutionId: "test-execution",
      sessionId: "mcode-a",
      threadId: "thread-a",
      workspaceId: "workspace-a",
      cwd: ".",
      message: "hello",
      model: "auto",
      permissionMode: "default",
      interactionMode: "build",
    });

    expect(mcpServers).toEqual([]);
    expect(lease.status()).toEqual({ active: 0, pending: 0 });
  });

  it("releases a preserved lease when stale replacement setup fails", async () => {
    const lease = configuredLease();
    const previousGrant = lease.issue(browserScope())!;
    const staged = lease.stage(browserScope());
    const provider = Object.create(CursorProvider.prototype) as any;
    provider.id = "cursor";
    provider.settingsService = { get: vi.fn(() => ({})) };
    provider.browserAutomationLease = lease;
    provider.pendingPermissions = new Map();
    provider.pendingBrowserLeases = new Map([["mcode-a", staged]]);
    provider.pendingBrowserContext = new Map();
    provider.pendingBrowserGrants = new Map();
    provider.pendingBrowserGrantContext = new Map();
    provider.liveSessionIds = new Set(["mcode-a"]);
    provider.close({ mcodeSessionId: "mcode-a" } as never);
    provider.spawnChild = vi.fn().mockRejectedValue(new Error("replacement failed"));

    await expect(provider.spawn({
      sessionId: "mcode-a",
      threadId: "thread-a",
      cwd: ".",
      permissionMode: "default",
      env: {},
    })).rejects.toThrow("replacement failed");

    expect(lease.credentials.authenticate(previousGrant.token)).toBeNull();
    expect(lease.status()).toEqual({ active: 0, pending: 0 });
  });

  it("releases a preserved lease when stale replacement lacks HTTP MCP", async () => {
    const lease = configuredLease();
    const previousGrant = lease.issue(browserScope())!;
    const staged = lease.stage(browserScope());
    const child = { pid: 105, kill: vi.fn() };
    const provider = Object.create(CursorProvider.prototype) as any;
    provider.id = "cursor";
    provider.settingsService = { get: vi.fn(() => ({})) };
    provider.browserAutomationLease = lease;
    provider.pendingPermissions = new Map();
    provider.pendingBrowserLeases = new Map([["mcode-a", staged]]);
    provider.pendingBrowserContext = new Map();
    provider.pendingBrowserGrants = new Map();
    provider.pendingBrowserGrantContext = new Map();
    provider.liveSessionIds = new Set(["mcode-a"]);
    provider.close({ mcodeSessionId: "mcode-a" } as never);
    provider.spawnChild = vi.fn().mockResolvedValue({ child, browserHttpMcpSupported: false });
    provider.openLogicalSession = vi.fn();

    await provider.spawn({
      sessionId: "mcode-a",
      threadId: "thread-a",
      cwd: ".",
      permissionMode: "default",
      env: {},
    });

    expect(lease.credentials.authenticate(previousGrant.token)).toBeNull();
    expect(lease.status()).toEqual({ active: 0, pending: 0 });
  });

  it("fails closed when stale replacement lease stage expires", async () => {
    let now = 0;
    const lease = new BrowserAutomationSessionLease({ now: () => now });
    lease.configure({ mcpUrl: "http://127.0.0.1:19400/mcp", worktreeIdentity: "worktree-a" });
    const previousGrant = lease.issue(browserScope())!;
    const staged = lease.stage(browserScope());
    now = staged.expiresAt;
    const child = { pid: 106, kill: vi.fn() };
    const provider = Object.create(CursorProvider.prototype) as any;
    provider.id = "cursor";
    provider.settingsService = { get: vi.fn(() => ({})) };
    provider.browserAutomationLease = lease;
    provider.pendingPermissions = new Map();
    provider.pendingBrowserLeases = new Map([["mcode-a", staged]]);
    provider.pendingBrowserContext = new Map();
    provider.pendingBrowserGrants = new Map();
    provider.pendingBrowserGrantContext = new Map();
    provider.liveSessionIds = new Set();
    provider.spawnChild = vi.fn().mockResolvedValue({ child, browserHttpMcpSupported: true });
    provider.openLogicalSession = vi.fn();

    await expect(provider.spawn({
      sessionId: "mcode-a",
      threadId: "thread-a",
      cwd: ".",
      permissionMode: "default",
      env: {},
    })).rejects.toThrow("Cursor browser automation lease issuance failed");

    expect(provider.openLogicalSession).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledOnce();
    expect(lease.credentials.authenticate(previousGrant.token)).toBeNull();
    expect(lease.status()).toEqual({ active: 0, pending: 0 });
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
      stderr: new PassThrough(),
      pid: 104,
      kill: vi.fn(),
    });
    const runtime = {
      state: { child, connection: {} },
      initialize: vi.fn().mockRejectedValue(new Error("handshake failed")),
    } as unknown as AcpSessionRuntime;
    const start = vi.spyOn(AcpSessionRuntime, "start").mockResolvedValue(runtime);
    const provider = Object.create(CursorProvider.prototype) as any;
    provider.envService = { getEnv: vi.fn(() => ({})) };
    provider.settingsService = { get: vi.fn(() => ({ provider: { cursor: { verboseFailureLogs: false } } })) };
    provider.pendingBrowserContext = new Map();

    await expect(provider.spawnOneCli("cursor-agent", "mcode-a", "C:\\", "default")).rejects.toThrow(
      "handshake failed",
    );

    expect(child.kill).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    start.mockRestore();
    spawnMock.mockReset();
  });

  it("closes pending ACP runtime when stopped during logical session load", async () => {
    const child = { pid: 108, kill: vi.fn() };
    const close = vi.fn().mockResolvedValue(undefined);
    const provider = Object.create(CursorProvider.prototype) as any;
    provider.settingsService = { get: vi.fn(() => ({})) };
    provider.browserAutomationLease = {
      release: vi.fn(),
      releaseSession: vi.fn(),
    };
    provider.pendingAcpRuntimes = new Map([["mcode-a", { close }]]);
    provider.pendingStops = new Set();
    provider.pendingPermissions = new Map();
    provider.runtime = { get: vi.fn(() => undefined) };
    provider.pendingBrowserLeases = new Map();
    provider.pendingBrowserContext = new Map();
    provider.pendingBrowserGrants = new Map();
    provider.pendingBrowserGrantContext = new Map();
    provider.liveSessionIds = new Set();
    provider.spawnChild = vi.fn().mockResolvedValue({
      mcodeSessionId: "mcode-a",
      threadId: "thread-a",
      child,
      browserHttpMcpSupported: false,
      acpSessionId: "",
      acpRuntime: { close },
    });
    provider.openLogicalSession = vi.fn().mockImplementation(
      () => new Promise<boolean>((resolve) => { provider.finishLoad = () => resolve(false); }),
    );

    const opening = provider.spawn({
      sessionId: "mcode-a",
      threadId: "thread-a",
      cwd: ".",
      permissionMode: "default",
      env: {},
    });
    await Promise.resolve();
    await provider.stopSession("mcode-a");
    expect(close).toHaveBeenCalledOnce();
    expect(provider.pendingStops.has("mcode-a")).toBe(true);

    provider.finishLoad();
    await expect(opening).rejects.toThrow("Cursor ACP session stopped during startup");
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

  it("propagates MCP grant when a stale pooled session is replaced", async () => {
    const lease = configuredLease();
    const previousGrant = lease.issue(browserScope())!;
    const provider = Object.create(CursorProvider.prototype) as any;
    const existing = {
      child: { exitCode: 1, signalCode: null },
      workspaceId: "workspace-a",
      browserPermissionCapability: "interact",
      browserCredential: {
        credentialId: previousGrant.credentialId,
        expiresAt: previousGrant.expiresAt,
        leaseId: previousGrant.leaseId,
      },
      mcodeSessionId: "mcode-a",
      threadId: "thread-a",
      cwd: ".",
      permissionMode: "default",
      turnChain: Promise.resolve(),
      lastUsedAt: Date.now(),
      activeTurnState: null,
    };
    const replacement = {
      ...existing,
      child: { pid: 105, kill: vi.fn() },
      browserCredential: undefined,
      browserHttpMcpSupported: true,
    };
    let mcpServers: unknown;
    provider.id = "cursor";
    provider.browserAutomationLease = lease;
    provider.settingsService = { get: vi.fn(() => ({})) };
    provider.pendingPermissions = new Map();
    provider.pendingBrowserLeases = new Map();
    provider.pendingBrowserContext = new Map();
    provider.pendingBrowserGrants = new Map();
    provider.pendingBrowserGrantContext = new Map();
    provider.pendingStops = new Set();
    provider.liveSessionIds = new Set(["mcode-a"]);
    provider.planQuestionModeThreads = new Set();
    provider.spawnChild = vi.fn().mockResolvedValue(replacement);
    provider.openLogicalSession = vi.fn(async (_state: unknown, _resume: boolean, servers: unknown) => {
      mcpServers = servers;
    });
    provider.runTurn = vi.fn().mockResolvedValue(undefined);
    provider.runtime = {
      get: vi.fn().mockReturnValueOnce(existing).mockReturnValue(undefined),
      stop: vi.fn(async () => provider.close(existing)),
      acquire: vi.fn(async (args: any) => (await provider.spawn({ ...args, env: {} })).state),
      recordUsage: vi.fn(),
    };

    await provider.sendTurn({
      turnExecutionId: "test-execution",
      sessionId: "mcode-a",
      threadId: "thread-a",
      workspaceId: "workspace-a",
      cwd: ".",
      message: "hello",
      model: "auto",
      permissionMode: "default",
      interactionMode: "build",
    });

    expect(mcpServers).toEqual([{
      type: "http",
      name: "mcode-browser",
      url: "http://127.0.0.1:19400/mcp",
      headers: [{
        name: "Authorization",
        value: expect.stringMatching(/^Bearer /),
      }],
    }]);
    const authorization = (mcpServers as any[])[0].headers[0].value as string;
    expect(lease.credentials.authenticate(authorization.slice("Bearer ".length))?.mcodeSessionId).toBe("mcode-a");
    expect(lease.credentials.authenticate(previousGrant.token)).toBeNull();
  });

  it("releases staged and refreshed leases during shutdown", () => {
    const lease = configuredLease();
    const staged = lease.stage(browserScope());
    const grant = lease.issue(browserScope({ mcodeSessionId: "mcode-b", providerSessionId: "provider-b" }))!;
    const unrelatedGrant = lease.issue(browserScope({
      providerId: "claude",
      mcodeSessionId: "mcode-other",
      providerSessionId: "provider-other",
    }))!;
    const provider = Object.create(CursorProvider.prototype) as any;
    provider.id = "cursor";
    provider.browserAutomationLease = lease;
    provider.pendingPermissions = new Map();
    provider.pendingBrowserLeases = new Map([["mcode-a", staged satisfies BrowserAutomationSessionLeaseStage]]);
    provider.pendingBrowserContext = new Map();
    provider.pendingBrowserGrants = new Map([["mcode-b", grant satisfies BrowserAutomationSessionLeaseGrant]]);
    provider.pendingBrowserGrantContext = new Map();
    provider.planQuestionModeThreads = new Set();
    provider.sdkSessionIds = new Map();
    provider.liveSessionIds = new Set(["mcode-b"]);
    provider.runtime = { shutdown: vi.fn().mockResolvedValue(undefined) };

    provider.shutdown();

    expect(lease.credentials.authenticate(grant.token)).toBeNull();
    expect(lease.credentials.authenticate(unrelatedGrant.token)?.providerId).toBe("claude");
    expect(lease.status()).toEqual({ active: 1, pending: 0 });
  });
});
