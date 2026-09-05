import { describe, it, expect, vi, beforeEach } from "vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { MCODE_BROWSER_GUIDE } from "@mcode/thread-orchestration";

vi.mock("@mcode/shared", () => ({
  getMcodeDir: () => process.env.MCODE_DATA_DIR ?? ".",
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const { checkCodexVersionMock, meetsMinVersionMock } = vi.hoisted(() => ({
  checkCodexVersionMock: vi.fn<() =>
    | { ok: true; version: string }
    | { ok: false; error: string }>(() => ({ ok: true, version: "0.40.0" })),
  meetsMinVersionMock: vi.fn(() => true),
}));

vi.mock("../../private/codex/codex-version.js", () => ({
  checkCodexVersion: checkCodexVersionMock,
  meetsMinVersion: meetsMinVersionMock,
}));

const { sendTurnMock, readConfigMock, appServers, startError } = vi.hoisted(() => ({
  sendTurnMock: vi.fn().mockResolvedValue("turn-test-id"),
  readConfigMock: vi.fn(),
  appServers: [] as Array<import("node:events").EventEmitter & {
    isAlive: boolean;
    options: Record<string, unknown>;
    spawnedEnv?: Record<string, string>;
  }>,
  startError: { current: null as Error | null },
}));

vi.mock("../../private/codex/codex-app-server.js", async () => {
  const { EventEmitter } = await import("node:events");
  class MockCodexAppServer extends EventEmitter {
    isAlive = true;
    threadId = "sdk-thread-1";
    resumeFailed = false;
    options: Record<string, unknown>;
    constructor(options: unknown) {
      super();
      this.options = options as Record<string, unknown>;
      appServers.push(this);
    }
    spawnedEnv?: Record<string, string>;
    async start(): Promise<void> {
      const getSpawnEnv = (this.options as { getSpawnEnv?: () => Record<string, string> }).getSpawnEnv;
      const env = getSpawnEnv?.();
      this.spawnedEnv = env ? { ...env } : undefined;
      if (startError.current) {
        this.isAlive = false;
        throw startError.current;
      }
    }
    async readConfig(cwd: string): Promise<unknown> {
      return readConfigMock(cwd);
    }
    async sendTurn(input: unknown, turnOptions: unknown): Promise<string> {
      return sendTurnMock(input, turnOptions);
    }
    async interruptTurn(): Promise<void> {}
    async interruptTurnAndDrain(turnId: string): Promise<void> {
      this.emit("notification", {
        method: "turn/completed",
        params: {
          threadId: this.threadId,
          turn: { id: turnId, status: "interrupted" },
        },
      });
    }
    async kill(): Promise<void> {
      this.isAlive = false;
    }
  }
  return { CodexAppServer: MockCodexAppServer };
});

import { BrowserAutomationSessionLease, CodexProvider, stubEnvService } from "./codex-provider-test-fixture.js";
import { AgentEventSchema, AgentEventType } from "@mcode/contracts";
import type { ProviderRuntimeEvent, ProviderTurnDiffUpdate } from "@mcode/contracts";

const schemaValidExecutionId = "00000000-0000-4000-8000-000000000001";

function makeProvider(
  catalogService: {
    currentSkills: (cwd?: string) => unknown[];
    currentPrompts: () => unknown[];
    refreshCustomPrompts: () => Promise<{ prompts: unknown[] }>;
    refresh: (cwd?: string) => Promise<{ skills: unknown[] }>;
    onSkillsChanged: (handler: () => void) => () => void;
    shutdown: () => Promise<void>;
  } = {
    currentSkills: vi.fn(() => []),
    currentPrompts: vi.fn(() => []),
    refreshCustomPrompts: vi.fn(async () => ({ prompts: [] })),
    refresh: vi.fn(async () => ({ skills: [] })),
    onSkillsChanged: vi.fn(() => () => undefined),
    shutdown: vi.fn(async () => undefined),
  },
  browserAutomationLease = new BrowserAutomationSessionLease(),
  threadControlMcp: {
    createCodexConfiguration?: () => Promise<unknown>;
    close?: (sessionId: string) => Promise<void>;
  } = undefined as never,
): CodexProvider {
  return new CodexProvider(
    { get: async () => ({ provider: { cli: { codex: "codex" } } }) } as never,
    stubEnvService() as never,
    { persistGeneratedImageFromPath: vi.fn() } as never,
    catalogService as never,
    browserAutomationLease,
    threadControlMcp as never,
  );
}

/**
 * Regression: the first turn on a new Codex session must reach `turn/start`.
 * SessionRuntime registers pool state after `spawn` resolves; scheduling the
 * first turn on queueMicrotask ran before that and skipped runTurn entirely.
 */
describe("CodexProvider first turn on new session", () => {
  const threadId = "first-turn-thread";
  const sessionId = `mcode-${threadId}`;

  beforeEach(() => {
    sendTurnMock.mockClear();
    checkCodexVersionMock.mockClear();
    meetsMinVersionMock.mockClear();
    appServers.length = 0;
    startError.current = null;
    readConfigMock.mockReset();
    readConfigMock.mockResolvedValue({
      config: { mcp_servers: { mcode_internal_thread_control: {} } },
    });
  });

  it("pushes complete native aggregates with dispatch identity and rejects foreign native turns", async () => {
    const provider = makeProvider();
    const updates: ProviderTurnDiffUpdate[] = [];
    const unsubscribe = provider.onTurnDiff((event) => updates.push(event));
    await provider.sendTurn({
      turnId: "mcode-turn", turnExecutionId: schemaValidExecutionId, deliveryAttempt: 2,
      sessionId, workspaceId: "workspace-test", threadId, message: "edit", cwd: process.cwd(),
      model: "gpt-5.4", interactionMode: "build", providerOptions: {}, permissionMode: "full",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const server = appServers[0]!;
    const notify = (turnId: string, diff: string) => server.emit("notification", {
      method: "turn/diff/updated", params: { threadId: "sdk-thread-1", turnId, diff },
    });
    notify("foreign-turn", "ignored");
    notify("turn-test-id", "first aggregate");
    notify("turn-test-id", "replacement aggregate");
    notify("turn-test-id", "");
    expect(updates).toEqual([
      { turnId: "mcode-turn", turnExecutionId: schemaValidExecutionId, deliveryAttempt: 2, revision: 1, state: "snapshot", nativeFidelity: "agent", patch: "first aggregate" },
      { turnId: "mcode-turn", turnExecutionId: schemaValidExecutionId, deliveryAttempt: 2, revision: 2, state: "snapshot", nativeFidelity: "agent", patch: "replacement aggregate" },
      { turnId: "mcode-turn", turnExecutionId: schemaValidExecutionId, deliveryAttempt: 2, revision: 3, state: "indeterminate-empty" },
    ]);
    unsubscribe();
    notify("turn-test-id", "unsubscribed");
    expect(updates).toHaveLength(3);
    provider.shutdown();
  });

  it("passes loopback browser MCP config and a child-only bearer token", async () => {
    const lease = new BrowserAutomationSessionLease();
    const inheritedBrowserToken = process.env.MCODE_BROWSER_MCP_TOKEN;
    lease.configure({
      mcpUrl: "http://127.0.0.1:19400/mcp",
      worktreeIdentity: "worktree-test",
    });
    const provider = makeProvider(undefined, lease);

    await provider.sendTurn({
      turnId: "test-turn",
      turnExecutionId: "test-execution",
      sessionId,
      workspaceId: "workspace-test",
      threadId,
      message: "inspect the page",
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "supervised",
    });

    const server = appServers.at(-1)!;
    expect(server.options.configOverrides).toEqual([
      'mcp_servers.mcode-browser.url="http://127.0.0.1:19400/mcp"',
      'mcp_servers.mcode-browser.bearer_token_env_var="MCODE_BROWSER_MCP_TOKEN"',
      'plugins."browser@openai-bundled".enabled=false',
    ]);
    expect(server.options.developerInstructions).toContain("browser_inspect");
    expect(server.options.developerInstructions).toContain("yield_to_user");
    expect(server.options.developerInstructions).not.toContain("browser_status");
    expect(server.options.developerInstructions).toContain(MCODE_BROWSER_GUIDE.trim());
    expect(server.spawnedEnv?.MCODE_BROWSER_MCP_TOKEN).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(process.env.MCODE_BROWSER_MCP_TOKEN).toBe(inheritedBrowserToken);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await provider.stopSession(sessionId);
    expect(lease.credentials.size()).toBe(0);
  });

  it("does not disable the bundled Browser plugin without a Browser v2 grant", async () => {
    const provider = makeProvider();

    await provider.sendTurn({
      turnId: "test-turn",
      turnExecutionId: "test-execution",
      sessionId: "mcode-without-browser-grant",
      workspaceId: "workspace-test",
      threadId: "without-browser-grant",
      message: "continue without Browser",
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "supervised",
    });

    const server = appServers.at(-1)!;
    expect(server.options.configOverrides).not.toContain(
      'plugins."browser@openai-bundled".enabled=false',
    );
    await provider.stopSession("mcode-without-browser-grant");
  });

  it("routes an explicit child brief through provider collaboration guidance", async () => {
    const provider = makeProvider();
    const childBrief = "Spawn one nested child and return NESTED_DONE exactly.";

    await provider.sendTurn({
      turnId: "test-turn",
      turnExecutionId: "child-routing-execution",
      sessionId: "mcode-child-routing",
      workspaceId: "workspace-test",
      threadId: "child-routing",
      message: childBrief,
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "supervised",
    });

    const server = appServers.at(-1)!;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(server.options.developerInstructions).toContain("provider-native collaboration");
    expect(server.options.developerInstructions).toContain("preserve the exact requested brief");
    expect(server.options.developerInstructions).toContain("does not authorize Mcode thread control");
    expect(sendTurnMock).toHaveBeenCalledWith(
      [{ type: "text", text: childBrief }],
      { model: "gpt-5.4" },
    );
    await provider.stopSession("mcode-child-routing");
  });

  it("tells Luna parents to choose the nested-capable Sol child model", async () => {
    const provider = makeProvider();

    await provider.sendTurn({
      turnId: "test-turn",
      turnExecutionId: "nested-model-guidance-execution",
      sessionId: "mcode-nested-model-guidance",
      workspaceId: "workspace-test",
      threadId: "nested-model-guidance",
      message: "Spawn a child that must spawn one nested child.",
      cwd: process.cwd(),
      model: "gpt-5.6-luna",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "supervised",
      threadControlEligible: false,
    });

    const server = appServers.at(-1)!;
    expect(server.options.developerInstructions).toContain("gpt-5.6-sol");
    expect(server.options.developerInstructions).toContain("parent spawn_agent call");
    await provider.stopSession("mcode-nested-model-guidance");
  });

  it("revokes a browser credential when app-server startup fails", async () => {
    const lease = new BrowserAutomationSessionLease();
    lease.configure({
      mcpUrl: "http://127.0.0.1:19400/mcp",
      worktreeIdentity: "worktree-test",
    });
    startError.current = new Error("handshake failed");
    const provider = makeProvider(undefined, lease);
    const events: ProviderRuntimeEvent[] = [];
    provider.on("event", (event: ProviderRuntimeEvent) => events.push(event));

    await provider.sendTurn({
      turnId: "test-turn",
      turnExecutionId: "test-execution",
      sessionId: "mcode-browser-spawn-failure",
      workspaceId: "workspace-test",
      threadId: "browser-spawn-failure",
      message: "inspect the page",
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "supervised",
    });

    expect(lease.credentials.size()).toBe(0);
    expect(appServers.at(-1)?.isAlive).toBe(false);
    expect(sendTurnMock).not.toHaveBeenCalled();
    expect(events).toEqual([
      {
        event: {
          type: AgentEventType.Error,
          threadId: "browser-spawn-failure",
          error: "handshake failed",
          turnExecutionId: "test-execution",
        },
      },
      {
        event: {
          type: AgentEventType.Ended,
          threadId: "browser-spawn-failure",
          turnExecutionId: "test-execution",
        },
      },
    ]);
  });

  it("keeps Browser available when internal MCP configuration fails", async () => {
    const lease = new BrowserAutomationSessionLease();
    lease.configure({
      mcpUrl: "http://127.0.0.1:19400/mcp",
      worktreeIdentity: "worktree-test",
    });
    const events: ProviderRuntimeEvent[] = [];
    const provider = makeProvider(undefined, lease, {
      createCodexConfiguration: vi.fn().mockRejectedValue(new Error("MCP config failed")),
    });
    provider.on("event", (event: ProviderRuntimeEvent) => events.push(event));

    await provider.sendTurn({
      turnId: "test-turn",
      turnExecutionId: schemaValidExecutionId,
      sessionId: "mcode-browser-config-failure",
      workspaceId: "workspace-test",
      threadId: "browser-config-failure",
      message: "inspect the page",
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "supervised",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(lease.status()).toEqual({ active: 1, pending: 0 });
    expect(sendTurnMock).toHaveBeenCalledWith(
      [{ type: "text", text: "inspect the page" }],
      { model: "gpt-5.4" },
    );
    expect(appServers.at(-1)?.isAlive).toBe(true);
    const failure = events.filter((runtimeEvent) => runtimeEvent.event.type === AgentEventType.McpServerStartupStatus);
    expect(failure).toHaveLength(1);
    expect(failure[0]?.event).toMatchObject({
      threadId: "browser-config-failure",
      providerId: "codex",
      serverThreadId: "sdk-thread-1",
      name: "mcode_internal_thread_control",
      status: "failed",
      error: "MCP config failed",
      turnExecutionId: schemaValidExecutionId,
    });
    expect(AgentEventSchema().parse(failure[0]?.event)).toEqual(failure[0]?.event);
    expect(events.some((runtimeEvent) => runtimeEvent.event.type === AgentEventType.Error)).toBe(false);
    expect(events.some((runtimeEvent) => runtimeEvent.event.type === AgentEventType.Ended)).toBe(false);
    await provider.stopSession("mcode-browser-config-failure");
  });

  it("releases the previous staged browser access for overlapping sends", async () => {
    const lease = new BrowserAutomationSessionLease();
    lease.configure({
      mcpUrl: "http://127.0.0.1:19400/mcp",
      worktreeIdentity: "worktree-test",
    });
    const provider = makeProvider(undefined, lease);
    let rejectAcquire!: (error: Error) => void;
    const acquirePromise = new Promise<never>((_, reject) => {
      rejectAcquire = reject;
    });
    (provider as any).runtime.acquire = vi.fn(() => acquirePromise);
    const release = vi.spyOn(lease, "release");
    const request = {
      turnId: "test-turn",
      turnExecutionId: "test-execution",
      sessionId: "mcode-overlapping-browser-stage",
      workspaceId: "workspace-test",
      threadId: "overlapping-browser-stage",
      message: "inspect the page",
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build" as const,
      providerOptions: {},
      permissionMode: "supervised" as const,
    };

    const firstSend = provider.sendTurn(request);
    await vi.waitFor(() => expect(lease.status()).toEqual({ active: 0, pending: 1 }));
    const firstStage = (provider as any).pendingBrowserAccess.get(request.sessionId).stage.leaseId;

    const secondSend = provider.sendTurn({ ...request, message: "inspect again" });
    await vi.waitFor(() => expect(release).toHaveBeenCalledWith(firstStage));
    expect(lease.status()).toEqual({ active: 0, pending: 1 });
    expect((provider as any).pendingBrowserAccess.get(request.sessionId).stage.leaseId).not.toBe(firstStage);

    rejectAcquire(new Error("acquire failed"));
    await Promise.all([firstSend, secondSend]);
    expect(lease.status()).toEqual({ active: 0, pending: 0 });
  });

  it("releases staged browser access when stopped before runtime acquisition", async () => {
    const lease = new BrowserAutomationSessionLease();
    lease.configure({
      mcpUrl: "http://127.0.0.1:19400/mcp",
      worktreeIdentity: "worktree-test",
    });
    const provider = makeProvider(undefined, lease);
    let rejectAcquire!: (error: Error) => void;
    const acquirePromise = new Promise<never>((_, reject) => {
      rejectAcquire = reject;
    });
    (provider as any).runtime.acquire = vi.fn(() => acquirePromise);

    const sessionId = "mcode-pending-stop";
    const sendPromise = provider.sendTurn({
      turnId: "test-turn",
      turnExecutionId: "test-execution",
      sessionId,
      workspaceId: "workspace-test",
      threadId: "pending-stop",
      message: "inspect the page",
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "supervised",
    });

    await vi.waitFor(() => expect(lease.status()).toEqual({ active: 0, pending: 1 }));
    await provider.stopSession(sessionId);
    expect(lease.status()).toEqual({ active: 0, pending: 0 });

    rejectAcquire(new Error("stop requested"));
    await sendPromise;
  });

  it("does not shut down the shared lease when Codex stops", () => {
    const lease = new BrowserAutomationSessionLease();
    lease.configure({
      mcpUrl: "http://127.0.0.1:19400/mcp",
      worktreeIdentity: "worktree-test",
    });
    const claudeGrant = lease.issue({
      providerId: "claude",
      providerSessionId: "claude-session",
      mcodeSessionId: "claude-session",
      threadId: "claude-thread",
      workspaceId: "workspace-test",
      permissionCapability: "interact",
    })!;
    const codexGrant = lease.issue({
      providerId: "codex",
      providerSessionId: "codex-session",
      mcodeSessionId: "codex-session",
      threadId: "codex-thread",
      workspaceId: "workspace-test",
      permissionCapability: "interact",
    })!;
    const provider = makeProvider(undefined, lease);
    const shutdown = vi.spyOn(lease, "shutdown");

    provider.shutdown();

    expect(shutdown).not.toHaveBeenCalled();
    expect(lease.credentials.authenticate(claudeGrant.token)).not.toBeNull();
    expect(lease.credentials.authenticate(codexGrant.token)).not.toBeNull();
  });

  it("sent turn/start after spawn when the runtime pool registers on the next tick", async () => {
    const provider = makeProvider();

    const ended = new Promise<void>((resolve) => {
      provider.on("event", (event: ProviderRuntimeEvent) => {
        if (event.event.type === AgentEventType.Ended && event.event.threadId === threadId) resolve();
      });
    });

    await provider.sendTurn({
      turnId: "test-turn",
      turnExecutionId: "test-execution",
      sessionId,
      workspaceId: "workspace-test",
      threadId,
      message: "hey",
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "auto",
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(sendTurnMock).toHaveBeenCalledTimes(1);

    const pool = (
      provider as unknown as {
        runtime: { get: (id: string) => { server: { emit: (e: string, n: unknown) => void } } | undefined };
      }
    ).runtime;
    const state = pool.get(sessionId);
    expect(state).toBeDefined();
    state!.server.emit("notification", {
      method: "turn/completed",
      params: { turn: { id: "turn-test-id", status: "completed" } },
    });

    await ended;
  });

  it("drains the main terminal notification before stop clears turn ownership", async () => {
    const provider = makeProvider();
    const events: ProviderRuntimeEvent[] = [];
    provider.on("event", (event: ProviderRuntimeEvent) => events.push(event));

    await provider.sendTurn({
      turnId: "test-turn",
      turnExecutionId: "test-execution",
      sessionId,
      workspaceId: "workspace-test",
      threadId,
      message: "stop this turn",
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "auto",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const runtime = (provider as unknown as {
      runtime: {
        get: (id: string) => { abortPendingTurnWait?: () => void } | undefined;
      };
    }).runtime;
    const state = runtime.get(sessionId);
    expect(state).toBeDefined();

    try {
      await provider.stopSession(sessionId);
      await vi.waitFor(() => {
        expect(events).toContainEqual({
          event: {
            type: AgentEventType.Ended,
            threadId,
            turnExecutionId: "test-execution",
            outcome: "cancelled",
          },
        });
      });
    } finally {
      state?.abortPendingTurnWait?.();
    }
  });

  it("reports provider_lost without an outcome when main-turn drain fails", async () => {
    const provider = makeProvider();
    const events: ProviderRuntimeEvent[] = [];
    provider.on("event", (event: ProviderRuntimeEvent) => events.push(event));

    await provider.sendTurn({
      turnId: "test-turn",
      turnExecutionId: "test-execution",
      sessionId,
      workspaceId: "workspace-test",
      threadId,
      message: "stop this turn",
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "auto",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const server = appServers.at(-1)! as typeof appServers[number] & {
      interruptTurnAndDrain: (turnId: string) => Promise<void>;
    };
    let interruptRejected = false;
    server.interruptTurnAndDrain = vi.fn(async () => {
      interruptRejected = true;
      throw new Error("Main interruption timed out waiting for terminal completion.");
    });
    const runtime = (provider as unknown as {
      runtime: {
        get: (id: string) => { abortPendingTurnWait?: () => void } | undefined;
      };
    }).runtime;
    const state = runtime.get(sessionId);

    try {
      await provider.stopSession(sessionId);
      expect(interruptRejected).toBe(true);
      expect(events).toContainEqual({
        event: {
          type: AgentEventType.Ended,
          threadId,
          turnExecutionId: "test-execution",
          reason: "provider_lost",
        },
      });
      expect(events.some((event) => event.event.type === AgentEventType.Error)).toBe(false);
    } finally {
      state?.abortPendingTurnWait?.();
    }
  });

  it("reports provider_lost when stop begins before Codex assigns a native turn id", async () => {
    const provider = makeProvider();
    const events: ProviderRuntimeEvent[] = [];
    provider.on("event", (event: ProviderRuntimeEvent) => events.push(event));

    await provider.sendTurn({
      turnId: "test-turn",
      turnExecutionId: "test-execution",
      sessionId,
      workspaceId: "workspace-test",
      threadId,
      message: "stop before native identity",
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "auto",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const runtime = (provider as unknown as {
      runtime: {
        get: (id: string) => { currentNativeTurnId?: string; abortPendingTurnWait?: () => void } | undefined;
      };
    }).runtime;
    const state = runtime.get(sessionId);
    expect(state).toBeDefined();
    if (state) state.currentNativeTurnId = undefined;

    try {
      await provider.stopSession(sessionId);
      expect(events).toContainEqual({
        event: {
          type: AgentEventType.Ended,
          threadId,
          turnExecutionId: "test-execution",
          reason: "provider_lost",
        },
      });
    } finally {
      state?.abortPendingTurnWait?.();
    }
  });

  it("emits Error before Ended when CLI preflight fails before runtime acquire", async () => {
    checkCodexVersionMock.mockReturnValueOnce({ ok: false, error: "Codex CLI unavailable" });
    const provider = makeProvider();
    const events: ProviderRuntimeEvent[] = [];
    provider.on("event", (event: ProviderRuntimeEvent) => events.push(event));

    await provider.sendTurn({
      turnId: "test-turn",
      turnExecutionId: "test-execution",
      sessionId: "mcode-preflight-failure",
      workspaceId: "workspace-test",
      threadId: "preflight-failure",
      message: "hello",
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "auto",
    });

    expect(events).toEqual([
      { event: { type: AgentEventType.Error, threadId: "preflight-failure", error: "Codex CLI unavailable", turnExecutionId: "test-execution" } },
      { event: { type: AgentEventType.Ended, threadId: "preflight-failure", turnExecutionId: "test-execution" } },
    ]);
    expect(appServers).toHaveLength(0);
  });

  it("skips CLI preflight when reusing a live session", async () => {
    const provider = makeProvider();
    const sessionId = "mcode-reusable-session";
    const threadId = "reusable-session";
    const events: ProviderRuntimeEvent[] = [];
    provider.on("event", (event: ProviderRuntimeEvent) => events.push(event));
    const request = {
      turnId: "test-turn",
      turnExecutionId: "test-execution",
      sessionId,
      workspaceId: "workspace-test",
      threadId,
      message: "first",
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build" as const,
      providerOptions: {},
      permissionMode: "auto" as const,
    };

    await provider.sendTurn(request);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(checkCodexVersionMock).toHaveBeenCalledTimes(1);
    const runtime = (provider as unknown as {
      runtime: { get: (id: string) => { server: { emit: (event: string, value: unknown) => void } } | undefined };
    }).runtime;
    const state = runtime.get(sessionId);
    expect(state).toBeDefined();
    state!.server.emit("notification", {
      method: "turn/completed",
      params: { turn: { id: "turn-test-id", status: "completed" } },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    await provider.sendTurn({ ...request, message: "second" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(checkCodexVersionMock).toHaveBeenCalledTimes(1);
    state!.server.emit("notification", {
      method: "turn/completed",
      params: { turn: { id: "turn-test-id", status: "completed" } },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events.filter((runtimeEvent) => runtimeEvent.event.type === AgentEventType.Ended)).toHaveLength(2);
  });

  it("keeps caller-specific policy for unsupported CLI versions", async () => {
    checkCodexVersionMock.mockReturnValueOnce({ ok: true, version: "0.36.0" });
    meetsMinVersionMock.mockReturnValueOnce(false);
    const provider = makeProvider();
    const events: ProviderRuntimeEvent[] = [];
    provider.on("event", (event: ProviderRuntimeEvent) => events.push(event));

    await provider.sendTurn({
      turnId: "test-turn",
      turnExecutionId: "test-execution",
      sessionId: "mcode-unsupported-version",
      workspaceId: "workspace-test",
      threadId: "unsupported-version",
      message: "hello",
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "auto",
    });

    expect(events).toEqual([
      {
        event: {
          type: AgentEventType.Error,
          threadId: "unsupported-version",
          error: "Codex CLI version 0.36.0 is not supported. Minimum required: 0.37.0. Update with: npm install -g @openai/codex",
          turnExecutionId: "test-execution",
        },
      },
      { event: { type: AgentEventType.Ended, threadId: "unsupported-version", turnExecutionId: "test-execution" } },
    ]);

    checkCodexVersionMock.mockReturnValueOnce({ ok: true, version: "0.36.0" });
    meetsMinVersionMock.mockReturnValueOnce(false);
    await expect(provider.runSideChannelQuery({
      parentThreadId: "parent-thread",
      parentSdkSessionId: "sdk-thread-1",
      prompt: "Generate the handoff.",
      cwd: process.cwd(),
    })).rejects.toMatchObject({
      code: "ETIMEDOUT",
      message: "Codex CLI version 0.36.0 is too old for side-channel handoff",
    });
    expect(appServers).toHaveLength(0);
  });

  it("starts the first turn from cached Skills without waiting for catalog I/O", async () => {
    const nativeSkill = {
      name: "review",
      description: "Review changes",
      kind: "skill" as const,
      source: "project" as const,
      providers: ["codex"],
      nativeName: "review",
      path: "C:/repo/.codex/skills/review/SKILL.md",
    };
    const currentSkills = vi.fn(() => [nativeSkill]);
    const refresh = vi.fn(() => new Promise<{ skills: unknown[] }>(() => undefined));
    const provider = makeProvider({
      currentSkills,
      currentPrompts: vi.fn(() => []),
      refreshCustomPrompts: vi.fn(async () => ({ prompts: [] })),
      refresh,
      onSkillsChanged: vi.fn(() => () => undefined),
      shutdown: vi.fn(async () => undefined),
    });

    await provider.sendTurn({
      turnId: "test-turn",
      turnExecutionId: "test-execution",
      sessionId: "mcode-catalog-independent",
      workspaceId: "workspace-test",
      threadId: "catalog-independent",
      message: "hello",
      cwd: "C:/repo",
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "auto",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(sendTurnMock).toHaveBeenCalledTimes(1);
    expect(currentSkills).toHaveBeenCalledWith("C:/repo");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("maps proactive orchestration to Ultra only on supported Codex models", async () => {
    const provider = makeProvider();

    await provider.sendTurn({
      turnId: "test-turn",
      turnExecutionId: "test-execution",
      sessionId: "mcode-ultra-sol",
      workspaceId: "workspace-test",
      threadId: "ultra-sol",
      message: "delegate this work",
      cwd: process.cwd(),
      model: "gpt-5.6-sol",
      reasoningLevel: "high",
      interactionMode: "build",
      orchestrationMode: "proactive",
      providerOptions: {},
      permissionMode: "auto",
    });

    for (let i = 0; i < 20 && sendTurnMock.mock.calls.length === 0; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(sendTurnMock.mock.calls[0]?.[1]).toMatchObject({ effort: "ultra" });

    sendTurnMock.mockClear();
    await provider.sendTurn({
      turnId: "test-turn",
      turnExecutionId: "test-execution",
      sessionId: "mcode-ultra-luna",
      workspaceId: "workspace-test",
      threadId: "ultra-luna",
      message: "delegate this work",
      cwd: process.cwd(),
      model: "gpt-5.6-luna",
      reasoningLevel: "high",
      interactionMode: "build",
      orchestrationMode: "proactive",
      providerOptions: {},
      permissionMode: "auto",
    });

    for (let i = 0; i < 20 && sendTurnMock.mock.calls.length === 0; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(sendTurnMock.mock.calls[0]?.[1]).toMatchObject({ effort: "high" });
  });

  it("did not overwrite pendingTurnId when a superseding runTurn finished sendTurn first", async () => {
    const supersedeThreadId = "supersede-turn-thread";
    const supersedeSessionId = `mcode-${supersedeThreadId}`;

    let resolveSend!: (id: string) => void;
    const sendTurnDeferred = new Promise<string>((resolve) => {
      resolveSend = resolve;
    });
    sendTurnMock.mockImplementationOnce(() => sendTurnDeferred);

    const provider = makeProvider();

    void provider.sendTurn({
      turnId: "test-turn",
      turnExecutionId: "test-execution",
      sessionId: supersedeSessionId,
      workspaceId: "workspace-test",
      threadId: supersedeThreadId,
      message: "hey",
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "auto",
    });

    for (let i = 0; i < 20 && sendTurnMock.mock.calls.length === 0; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(sendTurnMock).toHaveBeenCalled();

    const pool = (
      provider as unknown as {
        runtime: {
          get: (id: string) => { runTurnSeq: number; pendingTurnId: string | null } | undefined;
        };
      }
    ).runtime;
    const entry = pool.get(supersedeSessionId);
    expect(entry).toBeDefined();
    const staleSeq = entry!.runTurnSeq;
    entry!.runTurnSeq += 1;
    entry!.pendingTurnId = "superseding-turn";

    resolveSend("stale-turn-id");
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(staleSeq).toBeLessThan(entry!.runTurnSeq);
    expect(entry!.pendingTurnId).toBe("superseding-turn");
  });

  it("sends Codex native skill input for slash skill invocations", async () => {
    const skillPath = "C:\\Users\\Test\\.codex\\plugins\\cache\\openai-bundled\\browser\\1.0.0\\skills\\control-in-app-browser\\SKILL.md";
    const nativeSkill = {
      name: "browser:control-in-app-browser",
      nativeName: "control-in-app-browser",
      description: "Control browser",
      kind: "skill",
      source: "plugin",
      providers: ["codex"],
      path: skillPath,
    };
    const provider = makeProvider({
      currentSkills: vi.fn(() => [nativeSkill]),
      currentPrompts: vi.fn(() => []),
      refreshCustomPrompts: vi.fn(async () => ({ prompts: [] })),
      refresh: vi.fn(async () => ({ skills: [nativeSkill] })),
      onSkillsChanged: vi.fn(() => () => undefined),
      shutdown: vi.fn(async () => undefined),
    });

    await provider.sendTurn({
      turnId: "test-turn",
      turnExecutionId: "test-execution",
      sessionId: "mcode-skill-turn",
      workspaceId: "workspace-test",
      threadId: "skill-turn",
      message: "/browser:control-in-app-browser inspect localhost",
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "auto",
    });

    for (let i = 0; i < 20 && sendTurnMock.mock.calls.length === 0; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    expect(sendTurnMock).toHaveBeenCalledWith([
      { type: "skill", name: "control-in-app-browser", path: skillPath },
      { type: "text", text: "$control-in-app-browser inspect localhost" },
    ], expect.anything());
  });

  it("sends selected file mentions as native Codex mention input", async () => {
    const provider = makeProvider();

    await provider.sendTurn({
      turnId: "test-turn",
      turnExecutionId: "test-execution",
      sessionId: "mcode-mentioned-file",
      workspaceId: "workspace-test",
      threadId: "mentioned-file",
      message: "check @src/app.ts",
      mentions: [{
        id: "mention-1",
        kind: "file",
        label: "src/app.ts",
        path: "src/app.ts",
        range: { start: 6, end: 17 },
      }],
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "auto",
    });

    for (let i = 0; i < 20 && sendTurnMock.mock.calls.length === 0; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    expect(sendTurnMock.mock.calls[0][0]).toEqual([
      { type: "mention", name: "src/app.ts", path: "src/app.ts" },
      { type: "text", text: "check @src/app.ts" },
    ]);
  });

  it("sends selected plugin mentions as native Codex mention input", async () => {
    const provider = makeProvider();

    await provider.sendTurn({
      turnId: "test-turn",
      turnExecutionId: "test-execution",
      sessionId: "mcode-mentioned-plugin",
      workspaceId: "workspace-test",
      threadId: "mentioned-plugin",
      message: "@Browser inspect the page",
      mentions: [{
        id: "mention-plugin-1",
        kind: "plugin",
        label: "Browser",
        name: "Browser",
        path: "plugin://browser@openai-bundled",
        range: { start: 0, end: 8 },
      }],
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      permissionMode: "auto",
      providerOptions: {},
    });

    for (let i = 0; i < 20 && sendTurnMock.mock.calls.length === 0; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    expect(sendTurnMock.mock.calls[0][0]).toEqual([
      { type: "mention", name: "Browser", path: "plugin://browser@openai-bundled" },
      { type: "text", text: "@Browser inspect the page" },
    ]);
  });

  it("sends selected agent mentions as Codex subagent URI input", async () => {
    const provider = makeProvider();

    await provider.sendTurn({
      turnId: "test-turn",
      turnExecutionId: "test-execution",
      sessionId: "mcode-mentioned-agent",
      workspaceId: "workspace-test",
      threadId: "mentioned-agent",
      message: "ask @planner",
      mentions: [{
        id: "mention-agent-1",
        kind: "agent",
        label: "planner",
        name: "planner",
        path: "C:\\Users\\Test\\.codex\\agents\\planner.toml",
        provider: "codex",
        range: { start: 4, end: 12 },
      }],
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "auto",
    });

    for (let i = 0; i < 20 && sendTurnMock.mock.calls.length === 0; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    expect(sendTurnMock.mock.calls[0][0]).toEqual([
      { type: "text", text: "ask subagent://planner" },
    ]);
  });

  it("expands Codex prompt commands before turn/start", async () => {
    const promptDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codex-provider-prompt-"));
    try {
      const promptPath = NodePath.join(promptDir, "draftpr.md");
      NodeFS.writeFileSync(
        promptPath,
        "---\ndescription: Draft a PR\n---\nDraft a PR for $FILES titled $PR_TITLE. Args: $ARGUMENTS",
      );
      const prompt = {
        name: "prompts:draftpr",
        nativeName: "draftpr",
        description: "Draft a PR",
        kind: "command",
        source: "user",
        providers: ["codex"],
        path: promptPath,
      };
      const refreshCustomPrompts = vi.fn(async () => ({ prompts: [prompt] }));
      const provider = makeProvider({
          currentSkills: vi.fn(() => []),
          currentPrompts: vi.fn(() => []),
          refreshCustomPrompts,
          refresh: vi.fn(async () => ({ skills: [] })),
          onSkillsChanged: vi.fn(() => () => undefined),
          shutdown: vi.fn(async () => undefined),
      });

      await provider.sendTurn({
      turnId: "test-turn",
      turnExecutionId: "test-execution",
        sessionId: "mcode-prompt-turn",
        workspaceId: "workspace-test",
        threadId: "prompt-turn",
        message: '/prompts:draftpr FILES="src/a.ts src/b.ts" PR_TITLE="Add files"',
        cwd: process.cwd(),
        model: "gpt-5.4",
        interactionMode: "build",
        providerOptions: {},
        permissionMode: "auto",
      });

      for (let i = 0; i < 20 && sendTurnMock.mock.calls.length === 0; i++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }

      expect(sendTurnMock.mock.calls[0][0]).toEqual([{
        type: "text",
        text: 'Draft a PR for src/a.ts src/b.ts titled Add files. Args: FILES="src/a.ts src/b.ts" PR_TITLE="Add files"',
      }]);
      expect(refreshCustomPrompts).toHaveBeenCalledTimes(1);
    } finally {
      NodeFS.rmSync(promptDir, { recursive: true, force: true });
    }
  });

  it("uses selected catalog identity when a Skill and custom prompt share a name", async () => {
    const promptDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codex-provider-collision-"));
    try {
      const promptPath = NodePath.join(promptDir, "release.md");
      const skillPath = NodePath.join(promptDir, "release-skill", "SKILL.md");
      NodeFS.writeFileSync(promptPath, "Prompt release $ARGUMENTS");
      const prompt = {
        name: "prompts:release",
        nativeName: "release",
        description: "Prompt release",
        kind: "command",
        source: "user",
        providers: ["codex"],
        path: promptPath,
      };
      const skill = {
        name: "prompts:release",
        nativeName: "prompts:release",
        description: "Skill release",
        kind: "skill",
        source: "user",
        providers: ["codex"],
        path: skillPath,
      };
      const provider = makeProvider({
          currentSkills: vi.fn(() => [skill]),
          currentPrompts: vi.fn(() => [prompt]),
          refreshCustomPrompts: vi.fn(async () => ({ prompts: [prompt] })),
          refresh: vi.fn(async () => ({ skills: [skill] })),
          onSkillsChanged: vi.fn(() => () => undefined),
          shutdown: vi.fn(async () => undefined),
      });

      await provider.sendTurn({
      turnId: "test-turn",
      turnExecutionId: "test-execution",
        sessionId: "mcode-prompt-collision",
        workspaceId: "workspace-test",
        threadId: "prompt-collision",
        message: "/prompts:release alpha",
        mentions: [{
          id: "command:command:prompts:release",
          kind: "command",
          label: "prompts:release",
          namespace: "command",
          capabilityIdentity: {
            providerId: "codex",
            kind: "customPrompt",
            nativeId: "release",
          },
          range: { start: 0, end: 16 },
        }],
        cwd: process.cwd(),
        model: "gpt-5.4",
        interactionMode: "build",
        providerOptions: {},
        permissionMode: "auto",
      });
      await provider.sendTurn({
      turnId: "test-turn",
      turnExecutionId: "test-execution",
        sessionId: "mcode-skill-collision",
        workspaceId: "workspace-test",
        threadId: "skill-collision",
        message: "/prompts:release beta",
        mentions: [{
          id: "command:skill:prompts:release",
          kind: "command",
          label: "prompts:release",
          namespace: "skill",
          capabilityIdentity: {
            providerId: "codex",
            kind: "skill",
            nativeId: skillPath,
          },
          range: { start: 0, end: 16 },
        }],
        cwd: process.cwd(),
        model: "gpt-5.4",
        interactionMode: "build",
        providerOptions: {},
        permissionMode: "auto",
      });

      for (let i = 0; i < 20 && sendTurnMock.mock.calls.length < 2; i++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }

      expect(sendTurnMock.mock.calls[0][0]).toEqual([
        { type: "text", text: "Prompt release alpha" },
      ]);
      expect(sendTurnMock.mock.calls[1][0]).toEqual([
        { type: "skill", name: "prompts:release", path: skillPath },
        { type: "text", text: "$prompts:release beta" },
      ]);
    } finally {
      NodeFS.rmSync(promptDir, { recursive: true, force: true });
    }
  });

  it("emits a controlled error when a listed Codex prompt cannot be read", async () => {
    const promptDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "missing-codex-prompt-"));
    try {
      const prompt = {
        name: "prompts:draftpr",
        nativeName: "draftpr",
        description: "Draft a PR",
        kind: "command",
        source: "user",
        providers: ["codex"],
        path: NodePath.join(promptDir, "draftpr.md"),
      };
      const provider = makeProvider({
          currentSkills: vi.fn(() => []),
          currentPrompts: vi.fn(() => []),
          refreshCustomPrompts: vi.fn(async () => ({ prompts: [prompt] })),
          refresh: vi.fn(async () => ({ skills: [] })),
          onSkillsChanged: vi.fn(() => () => undefined),
          shutdown: vi.fn(async () => undefined),
      });
      const events: ProviderRuntimeEvent[] = [];
      provider.on("event", (event: ProviderRuntimeEvent) => events.push(event));

      await provider.sendTurn({
      turnId: "test-turn",
      turnExecutionId: "test-execution",
        sessionId: "mcode-missing-prompt",
        workspaceId: "workspace-test",
        threadId: "missing-prompt",
        message: "/prompts:draftpr src/a.ts",
        cwd: process.cwd(),
        model: "gpt-5.4",
        interactionMode: "build",
        providerOptions: {},
        permissionMode: "auto",
      });

      expect(sendTurnMock).not.toHaveBeenCalled();
      expect(events).toEqual([
        {
          event: {
            type: AgentEventType.Error,
            threadId: "missing-prompt",
            error: "Could not load Codex prompt /prompts:draftpr. Refresh commands and try again.",
            turnExecutionId: "test-execution",
          },
        },
        { event: { type: AgentEventType.Ended, threadId: "missing-prompt", turnExecutionId: "test-execution" } },
      ]);
    } finally {
      NodeFS.rmSync(promptDir, { recursive: true, force: true });
    }
  });

  it("leaves unknown slash commands unchanged", async () => {
    const provider = makeProvider();

    await provider.sendTurn({
      turnId: "test-turn",
      turnExecutionId: "test-execution",
      sessionId: "mcode-unknown-slash",
      workspaceId: "workspace-test",
      threadId: "unknown-slash",
      message: "/goal clear",
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "auto",
    });

    for (let i = 0; i < 20 && sendTurnMock.mock.calls.length === 0; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    expect(sendTurnMock.mock.calls[0][0]).toEqual([{ type: "text", text: "/goal clear" }]);
  });

  it("runs side-channel handoff turns at low effort", async () => {
    const provider = makeProvider();

    const result = provider.runSideChannelQuery({
      parentThreadId: "parent-thread",
      parentSdkSessionId: "sdk-thread-1",
      prompt: "Generate the handoff.",
      cwd: process.cwd(),
    });

    for (let i = 0; i < 20 && sendTurnMock.mock.calls.length === 0; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    expect(sendTurnMock).toHaveBeenCalledWith(
      [{ type: "text", text: "Generate the handoff." }],
      { effort: "low" },
    );

    expect(appServers[0]).toBeDefined();
    const sideChannelServer = appServers[0]!;
    expect(sideChannelServer.options).toMatchObject({
      sandbox: "read-only",
      approvalPolicy: "on-request",
      resumeThreadId: undefined,
    });
    expect(sideChannelServer.options).not.toHaveProperty("configOverrides");
    sideChannelServer.emit("notification", {
      method: "item/agentMessage/delta",
      params: { delta: "# Handoff" },
    });
    sideChannelServer.emit("notification", {
      method: "turn/completed",
      params: { turn: { status: "completed" } },
    });

    await expect(result).resolves.toBe("# Handoff");
  });

  it("closes partial internal MCP authority when bootstrap fails", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const events: ProviderRuntimeEvent[] = [];
    const provider = makeProvider(undefined, new BrowserAutomationSessionLease(), {
      createCodexConfiguration: vi.fn().mockRejectedValue(new Error("MCP setup failed")),
      close,
    });
    provider.on("event", (event: ProviderRuntimeEvent) => events.push(event));

    await provider.sendTurn({
      turnId: "test-turn",
      turnExecutionId: schemaValidExecutionId,
      sessionId: "mcode-mcp-failure",
      workspaceId: "workspace-mcp-failure",
      threadId: "mcp-failure",
      message: "hello",
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "auto",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(close).toHaveBeenCalledWith("mcode-mcp-failure");
    expect((provider as unknown as { runtime: { get: (sessionId: string) => unknown } }).runtime.get("mcode-mcp-failure")).toBeDefined();
    expect(appServers.at(-1)?.isAlive).toBe(true);
    expect(sendTurnMock).toHaveBeenCalledTimes(1);
    const failure = events.filter((runtimeEvent) => runtimeEvent.event.type === AgentEventType.McpServerStartupStatus);
    expect(failure).toHaveLength(1);
    expect(AgentEventSchema().parse(failure[0]?.event)).toEqual(failure[0]?.event);
    expect(events.some((runtimeEvent) => runtimeEvent.event.type === AgentEventType.Error)).toBe(false);
    expect(events.some((runtimeEvent) => runtimeEvent.event.type === AgentEventType.Ended)).toBe(false);
    await provider.stopSession("mcode-mcp-failure");
  });

  it("continues the first turn when internal MCP startup reports failure", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const provider = makeProvider(undefined, new BrowserAutomationSessionLease(), {
      createCodexConfiguration: vi.fn().mockResolvedValue({ configOverrides: [], env: {} }),
      close,
    });
    const events: ProviderRuntimeEvent[] = [];
    provider.on("event", (event: ProviderRuntimeEvent) => events.push(event));

    const send = provider.sendTurn({
      turnId: "test-turn",
      turnExecutionId: schemaValidExecutionId,
      sessionId: "mcode-mcp-startup-failure",
      workspaceId: "workspace-mcp-failure",
      threadId: "mcp-startup-failure",
      message: "continue without the failed MCP",
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "auto",
    });

    await vi.waitFor(() => expect(appServers.at(-1)).toBeDefined());
    const server = appServers.at(-1)!;
    server.emit("notification", {
      method: "mcpServer/startupStatus/updated",
      params: {
        threadId: "sdk-thread-1",
        name: "mcode_internal_thread_control",
        status: "failed",
        error: "fixture MCP failed to start",
      },
    });

    await send;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(sendTurnMock).toHaveBeenCalledWith(
      [{ type: "text", text: "continue without the failed MCP" }],
      { model: "gpt-5.4" },
    );
    expect(readConfigMock).not.toHaveBeenCalled();
    expect(server.isAlive).toBe(true);
    expect(close).not.toHaveBeenCalled();
    expect(events).not.toContainEqual(expect.objectContaining({ event: expect.objectContaining({ type: AgentEventType.Error }) }));
    const failures = events.filter((runtimeEvent) => runtimeEvent.event.type === AgentEventType.McpServerStartupStatus);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.event).toMatchObject({
      threadId: "mcp-startup-failure",
      providerId: "codex",
      serverThreadId: "sdk-thread-1",
      name: "mcode_internal_thread_control",
      status: "failed",
      error: "fixture MCP failed to start",
      turnExecutionId: schemaValidExecutionId,
    });
    expect(AgentEventSchema().parse(failures[0]?.event)).toEqual(failures[0]?.event);
    await provider.stopSession("mcode-mcp-startup-failure");
  });

  it("normalizes a legacy internal MCP error status without duplicating the failure event", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const provider = makeProvider(undefined, new BrowserAutomationSessionLease(), {
      createCodexConfiguration: vi.fn().mockResolvedValue({ configOverrides: [], env: {} }),
      close,
    });
    const events: ProviderRuntimeEvent[] = [];
    provider.on("event", (event: ProviderRuntimeEvent) => events.push(event));

    const send = provider.sendTurn({
      turnId: "test-turn",
      turnExecutionId: schemaValidExecutionId,
      sessionId: "mcode-mcp-legacy-error",
      workspaceId: "workspace-mcp-legacy-error",
      threadId: "mcp-legacy-error",
      message: "continue after the legacy MCP error",
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "auto",
    });

    await vi.waitFor(() => expect(appServers.at(-1)).toBeDefined());
    const server = appServers.at(-1)!;
    server.emit("notification", {
      method: "mcpServer/startupStatus/updated",
      params: {
        threadId: "sdk-thread-1",
        name: "mcode_internal_thread_control",
        status: "error",
        failureReason: "legacy fixture failure",
      },
    });

    await send;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(sendTurnMock).toHaveBeenCalledWith(
      [{ type: "text", text: "continue after the legacy MCP error" }],
      { model: "gpt-5.4" },
    );
    expect(readConfigMock).not.toHaveBeenCalled();
    expect(server.isAlive).toBe(true);
    expect(close).not.toHaveBeenCalled();
    const failures = events.filter((runtimeEvent) => runtimeEvent.event.type === AgentEventType.McpServerStartupStatus);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.event).toMatchObject({
      status: "failed",
      failureReason: "legacy fixture failure",
      turnExecutionId: schemaValidExecutionId,
    });
    expect(AgentEventSchema().parse(failures[0]?.event)).toEqual(failures[0]?.event);
    expect(events.some((runtimeEvent) => runtimeEvent.event.type === AgentEventType.Error)).toBe(false);
    expect(events.some((runtimeEvent) => runtimeEvent.event.type === AgentEventType.Ended)).toBe(false);
    await provider.stopSession("mcode-mcp-legacy-error");
  });

  it("continues promptly when native internal MCP startup is cancelled", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const provider = makeProvider(undefined, new BrowserAutomationSessionLease(), {
      createCodexConfiguration: vi.fn().mockResolvedValue({ configOverrides: [], env: {} }),
      close,
    });
    const events: ProviderRuntimeEvent[] = [];
    provider.on("event", (event: ProviderRuntimeEvent) => events.push(event));

    const send = provider.sendTurn({
      turnId: "test-turn",
      turnExecutionId: schemaValidExecutionId,
      sessionId: "mcode-mcp-cancelled",
      workspaceId: "workspace-mcp-cancelled",
      threadId: "mcp-cancelled",
      message: "continue after MCP cancellation",
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "auto",
    });

    await vi.waitFor(() => expect(appServers.at(-1)).toBeDefined());
    const server = appServers.at(-1)!;
    server.emit("notification", {
      method: "mcpServer/startupStatus/updated",
      params: {
        threadId: "sdk-thread-1",
        name: "mcode_internal_thread_control",
        status: "cancelled",
      },
    });

    await send;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(sendTurnMock).toHaveBeenCalledWith(
      [{ type: "text", text: "continue after MCP cancellation" }],
      { model: "gpt-5.4" },
    );
    expect(readConfigMock).not.toHaveBeenCalled();
    expect(server.isAlive).toBe(true);
    expect(close).not.toHaveBeenCalled();
    const statuses = events.filter((runtimeEvent) => runtimeEvent.event.type === AgentEventType.McpServerStartupStatus);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.event).toMatchObject({
      threadId: "mcp-cancelled",
      providerId: "codex",
      serverThreadId: "sdk-thread-1",
      name: "mcode_internal_thread_control",
      status: "cancelled",
      turnExecutionId: schemaValidExecutionId,
    });
    expect(AgentEventSchema().parse(statuses[0]?.event)).toEqual(statuses[0]?.event);
    expect(events.some((runtimeEvent) => runtimeEvent.event.type === AgentEventType.Error)).toBe(false);
    expect(events.some((runtimeEvent) => runtimeEvent.event.type === AgentEventType.Ended)).toBe(false);
    expect(events.some((runtimeEvent) => runtimeEvent.event.type === AgentEventType.McpServerStartupStatus && runtimeEvent.event.status === "failed")).toBe(false);
    await provider.stopSession("mcode-mcp-cancelled");
  });

  it.each([
    ["missing registration", { config: { mcp_servers: {} } }, "Codex app-server did not register mcode_internal_thread_control in effective configuration"],
    ["read failure", new Error("effective config unavailable"), "effective config unavailable"],
  ] as const)("continues when internal MCP effective config has a $0", async (_name, result, expectedError) => {
    if (result instanceof Error) {
      readConfigMock.mockRejectedValue(result);
    } else {
      readConfigMock.mockResolvedValue(result);
    }
    const close = vi.fn().mockResolvedValue(undefined);
    const provider = makeProvider(undefined, new BrowserAutomationSessionLease(), {
      createCodexConfiguration: vi.fn().mockResolvedValue({ configOverrides: [], env: {} }),
      close,
    });
    const events: ProviderRuntimeEvent[] = [];
    provider.on("event", (event: ProviderRuntimeEvent) => events.push(event));

    const sessionId = `mcode-mcp-config-${_name.replaceAll(" ", "-")}`;
    const threadId = `mcp-config-${_name.replaceAll(" ", "-")}`;
    const send = provider.sendTurn({
      turnId: "test-turn",
      turnExecutionId: schemaValidExecutionId,
      sessionId,
      workspaceId: "workspace-mcp-config",
      threadId,
      message: "continue after config verification",
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "auto",
    });

    await vi.waitFor(() => expect(appServers.at(-1)).toBeDefined());
    const server = appServers.at(-1)!;
    server.emit("notification", {
      method: "mcpServer/startupStatus/updated",
      params: {
        threadId: "sdk-thread-1",
        name: "mcode_internal_thread_control",
        status: "ready",
      },
    });

    await send;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(readConfigMock).toHaveBeenCalledTimes(1);
    expect(sendTurnMock).toHaveBeenCalledWith(
      [{ type: "text", text: "continue after config verification" }],
      { model: "gpt-5.4" },
    );
    expect(server.isAlive).toBe(true);
    expect(close).toHaveBeenCalledWith(sessionId);
    const failures = events.filter((runtimeEvent) => runtimeEvent.event.type === AgentEventType.McpServerStartupStatus && runtimeEvent.event.status === "failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]?.event).toMatchObject({
      threadId,
      providerId: "codex",
      serverThreadId: "sdk-thread-1",
      name: "mcode_internal_thread_control",
      status: "failed",
      error: expectedError,
      turnExecutionId: schemaValidExecutionId,
    });
    expect(AgentEventSchema().parse(failures[0]?.event)).toEqual(failures[0]?.event);
    expect(events.some((runtimeEvent) => runtimeEvent.event.type === AgentEventType.Error)).toBe(false);
    expect(events.some((runtimeEvent) => runtimeEvent.event.type === AgentEventType.Ended)).toBe(false);
    await provider.stopSession(sessionId);
  });

  it("omits internal thread-control MCP configuration for an ineligible turn", async () => {
    const createCodexConfiguration = vi.fn().mockResolvedValue({
      configOverrides: ["mcp_servers.mcode_internal_thread_control.url=\"http://127.0.0.1\""],
      env: { MCODE_INTERNAL_THREAD_CONTROL_TOKEN: "token" },
    });
    const provider = makeProvider(undefined, new BrowserAutomationSessionLease(), {
      createCodexConfiguration,
    });

    await provider.sendTurn({
      turnId: "test-turn",
      turnExecutionId: "ineligible-execution",
      sessionId: "mcode-ineligible",
      workspaceId: "workspace-test",
      threadId: "ineligible",
      message: "Spawn a provider-native child",
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "supervised",
      threadControlEligible: false,
    });

    const server = appServers.at(-1)!;
    expect(createCodexConfiguration).not.toHaveBeenCalled();
    expect(server.options.configOverrides).not.toContain(expect.stringContaining("mcode_internal_thread_control"));
    expect(server.options.developerInstructions).not.toContain("mcode_internal_thread_control");
    await provider.stopSession("mcode-ineligible");
  });

  it("restarts a pooled session when Mcode thread-control eligibility changes", async () => {
    const createCodexConfiguration = vi.fn().mockResolvedValue({
      configOverrides: ["mcp_servers.mcode_internal_thread_control.url=\"http://127.0.0.1\""],
      env: { MCODE_INTERNAL_THREAD_CONTROL_TOKEN: "token" },
    });
    const provider = makeProvider(undefined, new BrowserAutomationSessionLease(), {
      createCodexConfiguration,
    });

    const request = {
      turnId: "test-turn",
      turnExecutionId: "eligible-execution",
      sessionId: "mcode-eligibility-transition",
      workspaceId: "workspace-test",
      threadId: "eligibility-transition",
      message: "Create an Mcode thread named child",
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build" as const,
      providerOptions: {},
      permissionMode: "supervised",
    };
    const firstSend = provider.sendTurn({ ...request, threadControlEligible: true });
    await vi.waitFor(() => expect(appServers.at(-1)).toBeDefined());
    appServers[0]!.emit("notification", {
      method: "mcpServer/startupStatus/updated",
      params: {
        threadId: "sdk-thread-1",
        name: "mcode_internal_thread_control",
        status: "ready",
      },
    });
    await firstSend;
    await provider.sendTurn({
      ...request,
      turnExecutionId: "ineligible-execution",
      message: "Spawn a provider-native child named child",
      threadControlEligible: false,
    });

    expect(appServers).toHaveLength(2);
    expect(appServers[0]?.options.configOverrides).toEqual([
      'mcp_servers.mcode_internal_thread_control.url="http://127.0.0.1"',
    ]);
    expect(appServers[1]?.options.configOverrides).toEqual([]);
    expect(createCodexConfiguration).toHaveBeenCalledTimes(1);
    await provider.stopSession("mcode-eligibility-transition");
  });

  it("continues after an internal MCP startup timeout and keeps the authority open", async () => {
    vi.useFakeTimers();
    try {
      readConfigMock.mockImplementation(() => new Promise(() => undefined));
      const close = vi.fn().mockResolvedValue(undefined);
      const provider = makeProvider(undefined, new BrowserAutomationSessionLease(), {
        createCodexConfiguration: vi.fn().mockResolvedValue({ configOverrides: [], env: {} }),
        close,
      });
      const events: ProviderRuntimeEvent[] = [];
      provider.on("event", (event: ProviderRuntimeEvent) => events.push(event));

      const send = provider.sendTurn({
        turnId: "test-turn",
        turnExecutionId: schemaValidExecutionId,
        sessionId: "mcode-mcp-startup-timeout",
        workspaceId: "workspace-mcp-timeout",
        threadId: "mcp-startup-timeout",
        message: "hello",
        cwd: process.cwd(),
        model: "gpt-5.4",
        interactionMode: "build",
        providerOptions: {},
        permissionMode: "auto",
      });

      await vi.advanceTimersByTimeAsync(10_000);
      await send;
      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();

      expect(close).not.toHaveBeenCalled();
      expect(appServers.at(-1)?.isAlive).toBe(true);
      expect(sendTurnMock).toHaveBeenCalledWith(
        [{ type: "text", text: "hello" }],
        { model: "gpt-5.4" },
      );
      expect(readConfigMock).not.toHaveBeenCalled();
      const failures = events.filter((runtimeEvent) => runtimeEvent.event.type === AgentEventType.McpServerStartupStatus);
      expect(failures).toHaveLength(1);
      expect(failures[0]?.event).toMatchObject({
        threadId: "mcp-startup-timeout",
        providerId: "codex",
        serverThreadId: "sdk-thread-1",
        name: "mcode_internal_thread_control",
        status: "failed",
        error: "Codex internal MCP startup timed out",
        turnExecutionId: schemaValidExecutionId,
      });
      expect(AgentEventSchema().parse(failures[0]?.event)).toEqual(failures[0]?.event);
      expect(events.some((runtimeEvent) => runtimeEvent.event.type === AgentEventType.Error)).toBe(false);
      expect(events.some((runtimeEvent) => runtimeEvent.event.type === AgentEventType.Ended)).toBe(false);
      await provider.stopSession("mcode-mcp-startup-timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("maps side-channel CLI preflight failures to transient errors before creating a server", async () => {
    checkCodexVersionMock.mockReturnValueOnce({ ok: false, error: "Codex CLI unavailable" });
    const provider = makeProvider();

    await expect(provider.runSideChannelQuery({
      parentThreadId: "parent-thread",
      parentSdkSessionId: "sdk-thread-1",
      prompt: "Generate the handoff.",
      cwd: process.cwd(),
    })).rejects.toMatchObject({
      code: "ETIMEDOUT",
      message: "Codex CLI unavailable",
    });
    expect(appServers).toHaveLength(0);
  });
});
