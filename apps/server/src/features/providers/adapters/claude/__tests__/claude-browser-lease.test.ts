import "reflect-metadata";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { MCODE_BROWSER_GUIDE } from "@mcode/thread-orchestration";
import {
  BrowserAutomationSessionLease,
  type BrowserAutomationSessionLeaseScope,
} from "../../../../browser-automation/index.js";
import { ClaudeProvider } from "../claude-provider.js";

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: mockQuery }));
vi.mock("@mcode/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mcode/shared")>();
  return { ...actual, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } };
});

const scope: BrowserAutomationSessionLeaseScope = {
  providerId: "claude",
  providerSessionId: "mcode-thread-1",
  mcodeSessionId: "mcode-thread-1",
  threadId: "thread-1",
  workspaceId: "workspace-1",
  permissionCapability: "interact",
};

function configuredLease(): BrowserAutomationSessionLease {
  const lease = new BrowserAutomationSessionLease();
  lease.configure({ mcpUrl: "http://127.0.0.1:19400/mcp", worktreeIdentity: "worktree-1" });
  return lease;
}

function makeProvider(lease: BrowserAutomationSessionLease) {
  const provider = Object.create(ClaudeProvider.prototype) as ClaudeProvider;
  const existingState = {
    sessionId: "mcode-thread-1",
    cwd: process.cwd(),
    query: { close: vi.fn() },
    pushMessage: vi.fn(),
    closeQueue: vi.fn(),
    model: "claude-sonnet-4-6",
    permissionMode: "default",
    contextWindowMode: undefined,
    orchestrationMode: "standard",
    lastUsedAt: Date.now(),
    pendingToolUses: new Set<string>(),
    hasFiredToolThisTurn: false,
    workspaceId: "workspace-1",
    browserPermissionCapability: "interact" as const,
  } as unknown as Parameters<ClaudeProvider["close"]>[0];
  let spawnedState: unknown;
  const runtime = {
    get: vi.fn(() => existingState),
    recordUsage: vi.fn(),
    acquire: vi.fn(async (args: any) => {
      const result = await (provider as any).spawn(args);
      spawnedState = result.state;
      return result.state;
    }),
    stop: vi.fn(async () => {
      await (provider as any).close(existingState);
    }),
    shutdown: vi.fn(async () => {}),
  };
  Object.assign(provider as any, {
    id: "claude",
    runtime,
    pendingSpawnTurns: new Map(),
    pendingBrowserAccess: new Map(),
    sdkSessionIds: new Map(),
    recentStderr: new Map(),
    goalsBySession: new Map(),
    nativeGoalsBySession: new Map(),
    nativeGoalSupportBySession: new Map(),
    pendingStops: new Set(),
    suppressEndedQueries: new Set(),
    suppressSessionStartHooks: new Set(),
    planAnswerThreads: new Set(),
    pendingPermissions: new Map(),
    browserAutomationSessionLease: lease,
    scopedPreGrant: { tryConsume: () => false },
    envService: { getEnv: () => ({}) },
    jobObject: { isWindowsJob: false },
    threadControlMcp: undefined,
    startStreamLoop: vi.fn(),
  });
  return {
    provider,
    runtime,
    existingState,
    get spawnedState() { return spawnedState as any; },
  };
}

function request() {
  return {
    sessionId: "mcode-thread-1",
    workspaceId: "workspace-1",
    threadId: "thread-1",
    message: "hello",
    cwd: process.cwd(),
    model: "claude-sonnet-4-6",
    permissionMode: "default",
    interactionMode: "build" as const,
    providerOptions: {},
  } as any;
}

describe("ClaudeProvider browser session lease lifecycle", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockReturnValue({ close: vi.fn() });
  });

  it("appends the shared Browser v2 guide to the native system prompt", async () => {
    const lease = configuredLease();
    const harness = makeProvider(lease);
    (harness.provider as any).runtime.get = vi.fn(() => undefined);

    await (harness.provider as any).sendTurn(request());

    const append = mockQuery.mock.calls[0][0].options.systemPrompt.append;
    expect(append).toContain("browser_inspect");
    expect(append).toContain("yield_to_user");
    expect(append).not.toContain("browser_status");
    expect(append).toContain(MCODE_BROWSER_GUIDE.trim());
    await (harness.provider as any).close(harness.spawnedState);
  });

  it("closes a refreshed replacement with no active or pending lease", async () => {
    const lease = configuredLease();
    const oldGrant = lease.issue(scope)!;
    const harness = makeProvider(lease);
    const { provider, runtime, existingState } = harness;
    existingState.browserLease = { ...oldGrant, expiresAt: 0 };
    (provider as any).runtime.get = vi.fn(() => existingState);
    (provider as any).pendingBrowserAccess.set("mcode-thread-1", {
      scope,
      stage: lease.stage(scope),
    });

    await (provider as any).sendTurn(request());

    expect(runtime.stop).toHaveBeenCalledOnce();
    const options = mockQuery.mock.calls[0][0].options;
    const token = options.mcpServers["mcode-browser"].headers.Authorization.slice("Bearer ".length);
    expect(lease.credentials.authenticate(oldGrant.token)).toBeNull();
    expect(lease.credentials.authenticate(token)).not.toBeNull();
    expect((provider as any).browserAutomationSessionLease.status()).toEqual({ active: 1, pending: 0 });
    const spawnedState = harness.spawnedState;
    expect(spawnedState).toBeDefined();
    await (provider as any).close(spawnedState);
    expect(lease.status()).toEqual({ active: 0, pending: 0 });
  });

  it("releases a fresh grant when SDK spawn fails", async () => {
    const lease = configuredLease();
    const { provider } = makeProvider(lease);
    (provider as any).runtime.get = vi.fn(() => undefined);
    const spawnError = new Error("spawn failed");
    mockQuery.mockImplementationOnce(() => { throw spawnError; });

    await expect((provider as any).sendTurn(request())).rejects.toBe(spawnError);
    expect(lease.status()).toEqual({ active: 0, pending: 0 });
  });

  it("releases active grant exactly once on close", async () => {
    const lease = configuredLease();
    const grant = lease.issue(scope)!;
    const { provider } = makeProvider(lease);
    const state = { ...(makeProvider(lease).existingState), browserLease: grant };

    await (provider as any).close(state);
    await (provider as any).close(state);
    expect(lease.status()).toEqual({ active: 0, pending: 0 });
  });

  it("delegates shutdown without revoking leases owned by other providers", () => {
    const lease = configuredLease();
    const claudeGrant = lease.issue(scope)!;
    const nonClaudeGrant = lease.issue({
      ...scope,
      providerId: "codex",
      providerSessionId: "codex-thread-1",
    })!;
    const provider = new ClaudeProvider(
      { getEnv: () => ({}) } as any,
      { isWindowsJob: false } as any,
      undefined,
      lease,
    );
    const shutdown = vi.spyOn((provider as any).runtime, "shutdown").mockResolvedValue(undefined);

    provider.shutdown();

    expect(shutdown).toHaveBeenCalledOnce();
    expect(lease.credentials.authenticate(nonClaudeGrant.token)).not.toBeNull();
    expect(lease.credentials.authenticate(claudeGrant.token)).not.toBeNull();
  });
});
