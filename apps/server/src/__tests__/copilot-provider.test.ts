import "reflect-metadata";
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import type { AgentEvent } from "@mcode/contracts";
import { MCODE_BROWSER_GUIDE } from "@mcode/thread-orchestration";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal mock CopilotSession whose `on()` stores handlers by event
 * name and returns a no-op unsubscriber. Call `fire(eventName, data)` to
 * invoke all registered handlers for that event.
 */
function makeMockSession() {
  const handlers = new Map<string, Array<(event: { data: unknown }) => void>>();

  const session = {
    sessionId: "sdk-session-123",
    on: vi.fn((eventName: string, handler: (event: { data: unknown }) => void) => {
      if (!handlers.has(eventName)) handlers.set(eventName, []);
      handlers.get(eventName)!.push(handler);
      return () => {};
    }),
    send: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    fire(eventName: string, data?: unknown) {
      for (const h of handlers.get(eventName) ?? []) {
        h({ data });
      }
    },
  };

  return session;
}

// --- Mocks (hoisted to avoid TDZ issues with vi.mock) ---

const { mockExecFile, mockClient, MockCopilotClient } = vi.hoisted(() => {
  const mockClient = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    getState: vi.fn().mockReturnValue("connected"),
    listModels: vi.fn().mockResolvedValue([]),
    createSession: vi.fn(),
    resumeSession: vi.fn(),
  };
  // Must use a regular function (not arrow) so it can be called with `new`.
  // Returning an object from a constructor makes `new` use that object.
  const MockCopilotClient = vi.fn(function (this: unknown) {
    return mockClient;
  });
  return { mockExecFile: vi.fn(), mockClient, MockCopilotClient };
});

vi.mock("which", () => ({ default: vi.fn() }));

vi.mock("child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("child_process")>();
  return { ...original, execFile: mockExecFile };
});

vi.mock("@github/copilot-sdk", () => ({
  CopilotClient: MockCopilotClient,
  approveAll: vi.fn(),
}));

// Mock the CLI resolver so provider tests never shell out (npm/which/powershell).
// Default: configured path resolves verbatim; otherwise a fixed npm-global entry.
const { resolveCopilotCliMock } = vi.hoisted(() => ({
  resolveCopilotCliMock: vi.fn((ctx?: { configuredPath?: string }) =>
    ctx?.configuredPath?.trim()
      ? { source: "configured", entry: ctx.configuredPath.trim(), version: null }
      : { source: "npm-global", entry: "/global/@github/copilot/index.js", version: "1.0.24" },
  ),
}));

vi.mock("../providers/copilot/copilot-cli-resolver.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../providers/copilot/copilot-cli-resolver.js")>();
  return {
    ...actual,
    resolveCopilotCli: resolveCopilotCliMock,
    createNodeResolverIO: vi.fn(() => ({
      exists: () => false,
      readFile: () => null,
      exec: () => null,
      platform: process.platform,
    })),
  };
});

/** Resets the CLI resolver mock to its default successful resolution. */
function resetResolverMock(): void {
  resolveCopilotCliMock.mockImplementation((ctx?: { configuredPath?: string }) =>
    ctx?.configuredPath?.trim()
      ? { source: "configured", entry: ctx.configuredPath.trim(), version: null }
      : { source: "npm-global", entry: "/global/@github/copilot/index.js", version: "1.0.24" },
  );
}

beforeEach(() => {
  resetResolverMock();
});

import which from "which";
import { CopilotProvider } from "../providers/copilot/copilot-provider.js";
import { stubEnvService } from "./stub-env-service.js";
import { stubJobObject } from "./stub-job-object.js";
import { BrowserAutomationSessionLease } from "../features/browser-automation/index.js";

/** Minimal SettingsService stub. */
function makeSettingsService(cliPath = "") {
  return {
    get: vi.fn().mockResolvedValue({
      provider: { cli: { copilot: cliPath } },
    }),
  };
}

/** Supplies the MCP connection required by provider send-turn fixtures. */
function makeThreadControlMcp() {
  return {
    createHttpConnection: vi.fn().mockResolvedValue({
      name: "mcode_internal_thread_control",
      url: "http://127.0.0.1:43123/session",
      headers: { Authorization: "Bearer fixture" },
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe("CopilotProvider bootstrap", () => {
  let origElectron: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    origElectron = process.versions.electron;
    mockClient.getState.mockReturnValue("disconnected");
    mockClient.start.mockResolvedValue(undefined);
    mockClient.listModels.mockResolvedValue([]);
    // Default: gh auth token succeeds.
    // Our mockExecFile doesn't have util.promisify.custom, so standard promisify
    // resolves with the first success callback arg. Pass { stdout } as that arg
    // so the provider's `const { stdout } = await execFileAsync(...)` works.
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: (err: Error | null, result?: { stdout: string }) => void) => {
        cb(null, { stdout: "gho_faketoken\n" });
      },
    );
  });

  afterEach(() => {
    Object.defineProperty(process.versions, "electron", {
      value: origElectron,
      configurable: true,
    });
  });

  describe("Electron executor override", () => {
    it("calls which('node') and prepends node dir to PATH in env when in Electron", async () => {
      Object.defineProperty(process.versions, "electron", {
        value: "28.0.0",
        configurable: true,
      });
      (which as unknown as Mock).mockResolvedValue("/usr/bin/node");

      const provider = new CopilotProvider(makeSettingsService() as any, stubJobObject(), stubEnvService());
      await provider.listModels();

      // which was called to find the real node binary
      expect(which).toHaveBeenCalledWith("node", { nothrow: true });
      // SDK client was constructed with env.PATH prepended with node binary dir
      const ctorCall = MockCopilotClient.mock.calls[0]?.[0];
      expect(ctorCall).toBeDefined();
      expect(ctorCall.env?.PATH).toMatch(/\/usr\/bin/);
    });

    it("skips executor override when not in Electron", async () => {
      Object.defineProperty(process.versions, "electron", {
        value: undefined,
        configurable: true,
      });

      const provider = new CopilotProvider(makeSettingsService() as any, stubJobObject(), stubEnvService());
      await provider.listModels();

      // which should not be called when not in Electron
      expect(which).not.toHaveBeenCalled();
      const ctorCall = MockCopilotClient.mock.calls[0]?.[0] ?? {};
      expect(ctorCall.cliPath).toBeUndefined();
      expect(resolveCopilotCliMock).not.toHaveBeenCalled();
    });

    it("passes an explicitly configured CLI entry to the SDK as cliPath", async () => {
      resolveCopilotCliMock.mockReturnValueOnce({
        source: "configured",
        entry: "/configured/copilot.js",
        version: "1.0.24",
      });
      const provider = new CopilotProvider(makeSettingsService("/configured/copilot.js") as any, stubJobObject(), stubEnvService());
      await provider.listModels();
      const ctorCall = MockCopilotClient.mock.calls[0]?.[0];
      expect(resolveCopilotCliMock).toHaveBeenCalledWith(
        { configuredPath: "/configured/copilot.js" },
        expect.anything(),
      );
      expect(ctorCall?.cliPath).toBe("/configured/copilot.js");
    });
  });

  describe("gh auth token", () => {
    it("passes githubToken when gh auth succeeds", async () => {
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: object, cb: (err: Error | null, result?: { stdout: string }) => void) => {
          cb(null, { stdout: "gho_abc123\n" });
        },
      );

      const provider = new CopilotProvider(makeSettingsService() as any, stubJobObject(), stubEnvService());
      await provider.listModels();

      const opts = MockCopilotClient.mock.calls[0]?.[0];
      expect(opts?.githubToken).toBe("gho_abc123");
    });

    it("omits githubToken when gh is not installed", async () => {
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: object, cb: (err: Error | null, result?: { stdout: string }) => void) => {
          cb(new Error("ENOENT"));
        },
      );

      const provider = new CopilotProvider(makeSettingsService() as any, stubJobObject(), stubEnvService());
      await provider.listModels();

      const opts = MockCopilotClient.mock.calls[0]?.[0] ?? {};
      expect(opts.githubToken).toBeUndefined();
    });
  });

  describe("client reuse", () => {
    it("reuses healthy connected client", async () => {
      const provider = new CopilotProvider(makeSettingsService() as any, stubJobObject(), stubEnvService());

      await provider.listModels();
      mockClient.getState.mockReturnValue("connected");
      await provider.listModels();

      // CopilotClient constructor called only once
      expect(MockCopilotClient.mock.calls).toHaveLength(1);
    });
  });

  it("configures only permission-compatible visible-browser MCP tools on a normal session", async () => {
    mockClient.getState.mockReturnValue("connected");
    const mockSession = makeMockSession();
    mockClient.createSession.mockResolvedValue(mockSession);
    const lease = new BrowserAutomationSessionLease();
    lease.configure({
      mcpUrl: "http://127.0.0.1:19400/mcp",
      worktreeIdentity: "worktree-test",
    });
    const provider = new CopilotProvider(
      makeSettingsService() as any,
      stubJobObject(),
      stubEnvService(),
      lease,
      makeThreadControlMcp() as any,
    );

    await provider.sendTurn({
      turnExecutionId: "test-execution",
      sessionId: "mcode-browser-copilot",
      workspaceId: "workspace-test",
      threadId: "browser-copilot",
      message: "inspect the page",
      cwd: "/tmp",
      model: "gpt-4o",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "supervised",
    });

    const config = mockClient.createSession.mock.calls[0]![0];
    expect(config.mcpServers["mcode-browser"]).toMatchObject({
      type: "http",
      url: "http://127.0.0.1:19400/mcp",
      headers: { Authorization: expect.stringMatching(/^Bearer [A-Za-z0-9_-]{40,}$/) },
    });
    expect(config.mcpServers["mcode-browser"].tools).toEqual(expect.arrayContaining(["browser_inspect", "browser_act"]));
    expect(config.mcpServers["mcode-browser"].tools).not.toContain("browser_evaluate");
    expect(config.systemMessage.content).toContain("browser_inspect");
    expect(config.systemMessage.content).toContain("yield_to_user");
    expect(config.systemMessage.content).not.toContain("browser_status");
    expect(config.systemMessage.content).toContain(MCODE_BROWSER_GUIDE.trim());
    expect(lease.status()).toEqual({ active: 1, pending: 0 });
    await provider.stopSession("mcode-browser-copilot");
    expect(lease.credentials.size()).toBe(0);
  });

  it("recreates a pooled session after its browser lease is revoked externally", async () => {
    mockClient.getState.mockReturnValue("connected");
    const firstSession = makeMockSession();
    const secondSession = makeMockSession();
    mockClient.createSession.mockResolvedValueOnce(firstSession).mockResolvedValueOnce(secondSession);
    const lease = new BrowserAutomationSessionLease();
    lease.configure({ mcpUrl: "http://127.0.0.1:19400/mcp", worktreeIdentity: "worktree-test" });
    const provider = new CopilotProvider(
      makeSettingsService() as any,
      stubJobObject(),
      stubEnvService(),
      lease,
      makeThreadControlMcp() as any,
    );
    const request = {
      sessionId: "mcode-browser-revoked",
      workspaceId: "workspace-test",
      threadId: "browser-revoked",
      message: "inspect the page",
      cwd: "/tmp",
      model: "gpt-4o",
      interactionMode: "build" as const,
      providerOptions: {},
      permissionMode: "supervised" as const,
    };

    await provider.sendTurn(request);
    const authHeader = mockClient.createSession.mock.calls[0]![0].mcpServers["mcode-browser"].headers.Authorization as string;
    const claims = lease.credentials.authenticate(authHeader.slice("Bearer ".length));
    expect(claims).not.toBeNull();
    lease.credentials.revoke(claims!.credentialId);

    await provider.sendTurn({
      turnExecutionId: "test-execution", ...request, message: "inspect again" });

    expect(mockClient.createSession).toHaveBeenCalledTimes(2);
    expect(firstSession.disconnect).toHaveBeenCalled();
    expect(lease.status()).toEqual({ active: 1, pending: 0 });
    await provider.stopSession(request.sessionId);
  });

  it("releases staged browser access when spawning fails", async () => {
    mockClient.getState.mockReturnValue("connected");
    mockClient.createSession.mockRejectedValue(new Error("spawn failed"));
    const lease = new BrowserAutomationSessionLease();
    lease.configure({ mcpUrl: "http://127.0.0.1:19400/mcp", worktreeIdentity: "worktree-test" });
    const provider = new CopilotProvider(
      makeSettingsService() as any,
      stubJobObject(),
      stubEnvService(),
      lease,
      makeThreadControlMcp() as any,
    );

    await expect(provider.sendTurn({
      turnExecutionId: "test-execution",
      sessionId: "mcode-browser-spawn-failed",
      workspaceId: "workspace-test",
      threadId: "browser-spawn-failed",
      message: "inspect the page",
      cwd: "/tmp",
      model: "gpt-4o",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "supervised",
    })).rejects.toThrow("spawn failed");

    expect(lease.status()).toEqual({ active: 0, pending: 0 });
  });

  it("releases exactly one staged handle when sends overlap", async () => {
    mockClient.getState.mockReturnValue("connected");
    mockClient.createSession.mockResolvedValue(makeMockSession());
    const lease = new BrowserAutomationSessionLease();
    lease.configure({ mcpUrl: "http://127.0.0.1:19400/mcp", worktreeIdentity: "worktree-test" });
    const provider = new CopilotProvider(
      makeSettingsService() as any,
      stubJobObject(),
      stubEnvService(),
      lease,
      makeThreadControlMcp() as any,
    );
    const request = {
      sessionId: "mcode-browser-overlap",
      workspaceId: "workspace-test",
      threadId: "browser-overlap",
      message: "inspect the page",
      cwd: "/tmp",
      model: "gpt-4o",
      interactionMode: "build" as const,
      providerOptions: {},
      permissionMode: "supervised" as const,
    };

    await Promise.all([provider.sendTurn({
      ...request,
      turnExecutionId: "test-execution-1",
    }), provider.sendTurn({
      ...request,
      turnExecutionId: "test-execution-2",
      message: "inspect again",
    })]);

    expect(lease.status()).toEqual({ active: 1, pending: 0 });
    await provider.stopSession(request.sessionId);
  });

  describe("error translation", () => {
    it("translates CLI server exited to auth instructions", async () => {
      mockClient.start.mockResolvedValue(undefined);
      mockClient.getState.mockReturnValue("connected");
      mockClient.createSession.mockRejectedValue(
        new Error("CLI server exited with code 1"),
      );

      const provider = new CopilotProvider(
        makeSettingsService() as any,
        stubJobObject(),
        stubEnvService(),
        undefined,
        makeThreadControlMcp() as any,
      );

      const events: AgentEvent[] = [];
      provider.on("event", (e: AgentEvent) => events.push(e));

      await provider.sendTurn({
      turnExecutionId: "test-execution",
        sessionId: "mcode-test1",
        threadId: "test1",
        message: "hello",
        cwd: "/tmp",
        model: "gpt-4o",
        interactionMode: "build",
        providerOptions: {},
        permissionMode: "auto",
      });

      const errorEvt = events.find((e) => e.type === "error");
      expect(errorEvt).toBeDefined();
      expect(errorEvt?.type === "error" && errorEvt.error).toContain("gh auth login");
    });

    it("translates package not found to install instructions", async () => {
      mockClient.start.mockResolvedValue(undefined);
      mockClient.getState.mockReturnValue("connected");
      mockClient.createSession.mockRejectedValue(
        new Error("Could not find @github/copilot"),
      );

      const provider = new CopilotProvider(
        makeSettingsService() as any,
        stubJobObject(),
        stubEnvService(),
        undefined,
        makeThreadControlMcp() as any,
      );

      const events: AgentEvent[] = [];
      provider.on("event", (e: AgentEvent) => events.push(e));

      await provider.sendTurn({
      turnExecutionId: "test-execution",
        sessionId: "mcode-test2",
        threadId: "test2",
        message: "hello",
        cwd: "/tmp",
        model: "gpt-4o",
        interactionMode: "build",
        providerOptions: {},
        permissionMode: "auto",
      });

      const errorEvt = events.find((e) => e.type === "error");
      expect(errorEvt).toBeDefined();
      expect(errorEvt?.type === "error" && errorEvt.error).toContain("npm install");
    });

    it("emits the resolver's not-found message when the CLI cannot be resolved", async () => {
      resolveCopilotCliMock.mockReturnValueOnce({
        source: "not-found",
        entry: null,
        version: null,
        message: "GitHub Copilot CLI not found. Install it with: npm install -g @github/copilot",
      });

      const provider = new CopilotProvider(makeSettingsService("/configured/copilot.js") as any, stubJobObject(), stubEnvService());
      const events: AgentEvent[] = [];
      provider.on("event", (e: AgentEvent) => events.push(e));

      await provider.sendTurn({
      turnExecutionId: "test-execution",
        sessionId: "mcode-test3",
        threadId: "test3",
        message: "hello",
        cwd: "/tmp",
        model: "gpt-4o",
        interactionMode: "build",
        providerOptions: {},
        permissionMode: "auto",
      });

      const errorEvt = events.find((e) => e.type === "error");
      expect(errorEvt).toBeDefined();
      expect(errorEvt?.type === "error" && errorEvt.error).toContain("npm install -g @github/copilot");
    });

    it("returns an empty model list when the CLI cannot be resolved", async () => {
      resolveCopilotCliMock.mockReturnValueOnce({
        source: "not-found",
        entry: null,
        version: null,
        message: "GitHub Copilot CLI not found. Install it with: npm install -g @github/copilot",
      });

      const provider = new CopilotProvider(makeSettingsService("/configured/copilot.js") as any, stubJobObject(), stubEnvService());
      await expect(provider.listModels()).resolves.toEqual([]);
    });

    it("throws the resolver install message from complete() when the CLI cannot be resolved", async () => {
      resolveCopilotCliMock.mockReturnValueOnce({
        source: "not-found",
        entry: null,
        version: null,
        message: "GitHub Copilot CLI not found. Install it with: npm install -g @github/copilot",
      });

      const provider = new CopilotProvider(makeSettingsService("/configured/copilot.js") as any, stubJobObject(), stubEnvService());
      await expect(provider.complete("hello", "gpt-4o", "/tmp")).rejects.toThrow(
        "npm install -g @github/copilot",
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Shared helper for event-sequence tests
// ---------------------------------------------------------------------------

/**
 * Run sendMessage with a fresh mock session that fires the given events
 * in sequence after send() resolves, then fires session.idle to end the turn.
 * Fully resets mock state on each call for isolation.
 */
async function runWithMockSession(
  eventSequence: Array<{ name: string; data?: unknown }>,
  sessionId = "mcode-shared-test",
): Promise<{ events: AgentEvent[] }> {
  vi.clearAllMocks();
  mockClient.getState.mockReturnValue("connected");
  mockClient.start.mockResolvedValue(undefined);
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: object, cb: (err: Error | null, result?: { stdout: string }) => void) => {
      cb(null, { stdout: "gho_faketoken\n" });
    },
  );

  const mockSession = makeMockSession();
  mockClient.createSession.mockResolvedValue(mockSession);
  mockSession.send.mockImplementation(async () => {
    for (const evt of eventSequence) {
      mockSession.fire(evt.name, evt.data);
    }
    mockSession.fire("session.idle");
  });

  const provider = new CopilotProvider(
    makeSettingsService() as any,
    stubJobObject(),
    stubEnvService(),
    undefined,
    makeThreadControlMcp() as any,
  );
  const events: AgentEvent[] = [];
  provider.on("event", (e: AgentEvent) => events.push(e));

  await provider.sendTurn({
      turnExecutionId: "test-execution",
    sessionId,
    threadId: sessionId.replace(/^mcode-/, ""),
    message: "hello",
    cwd: "/tmp",
    model: "gpt-4o",
    interactionMode: "build",
    providerOptions: {},
    permissionMode: "auto",
  });

  // The first turn now runs via a queueMicrotask inside the runtime-backed
  // spawn (it registers SDK handlers then awaits session.send()), so it has not
  // emitted by the time sendTurn resolves. Wait for the turn's terminal "ended"
  // event before reading the collected events.
  await waitForEnded(events);

  return { events };
}

/**
 * Resolve once an "ended" AgentEvent has been pushed, or after a bounded number
 * of event-loop ticks. The runtime schedules the first turn on a microtask and
 * runTurn awaits the async session.send(), so several ticks must drain before
 * the turn settles.
 */
async function waitForEnded(events: AgentEvent[]): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (events.some((e) => e.type === "ended")) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error("waitForEnded timed out waiting for 'ended' event");
}

// ---------------------------------------------------------------------------
// session.usage_info → ContextEstimate
// ---------------------------------------------------------------------------

describe("CopilotProvider session.usage_info", () => {

  it("emits a contextEstimate event when session.usage_info fires", async () => {
    const { events } = await runWithMockSession([
      {
        name: "session.usage_info",
        data: {
          tokenLimit: 128000,
          currentTokens: 5000,
          systemTokens: 1000,
          conversationTokens: 4000,
        },
      },
    ]);

    const ctxEvt = events.find((e) => e.type === "contextEstimate");
    expect(ctxEvt).toBeDefined();
    expect(ctxEvt?.type === "contextEstimate" && ctxEvt.tokensIn).toBe(5000);
    expect(ctxEvt?.type === "contextEstimate" && ctxEvt.contextWindow).toBe(128000);
  });

  it("populates contextWindow on turnComplete using the cached tokenLimit", async () => {
    const { events } = await runWithMockSession([
      {
        name: "session.usage_info",
        data: { tokenLimit: 128000, currentTokens: 5000 },
      },
      {
        name: "assistant.usage",
        data: { inputTokens: 5000, outputTokens: 200, cacheReadTokens: 0 },
      },
    ]);

    const turnEvt = events.find((e) => e.type === "turnComplete");
    expect(turnEvt).toBeDefined();
    expect(turnEvt?.type === "turnComplete" && turnEvt.contextWindow).toBe(128000);
  });

  it("leaves contextWindow undefined on turnComplete when no usage_info fired", async () => {
    const { events } = await runWithMockSession([
      {
        name: "assistant.usage",
        data: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0 },
      },
    ]);

    const turnEvt = events.find((e) => e.type === "turnComplete");
    expect(turnEvt).toBeDefined();
    expect(turnEvt?.type === "turnComplete" && turnEvt.contextWindow).toBeUndefined();
  });

  it("does not emit contextEstimate when session.usage_info is not fired", async () => {
    const { events } = await runWithMockSession([
      {
        name: "assistant.message",
        data: { content: "hello", outputTokens: 10 },
      },
    ]);

    expect(events.find((e) => e.type === "contextEstimate")).toBeUndefined();
  });

  it("emits exactly one turnComplete per turn even with multiple assistant.usage events", async () => {
    const { events } = await runWithMockSession([
      // First model call: agent decides to use a tool
      { name: "assistant.usage", data: { inputTokens: 3000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      // Tool executes, results sent back, second model call
      { name: "assistant.usage", data: { inputTokens: 5000, outputTokens: 200, cacheReadTokens: 100, cacheWriteTokens: 0 } },
      // Third model call: agent produces final response
      { name: "assistant.usage", data: { inputTokens: 7000, outputTokens: 150, cacheReadTokens: 200, cacheWriteTokens: 0 } },
    ]);

    const turnEvts = events.filter((e) => e.type === "turnComplete");
    expect(turnEvts).toHaveLength(1);

    // tokensIn uses the latest value (context grows)
    const tc = turnEvts[0]!;
    expect(tc.type === "turnComplete" && tc.tokensIn).toBe(7000);
    // tokensOut accumulates across all calls
    expect(tc.type === "turnComplete" && tc.tokensOut).toBe(450);
  });

  it("emits exactly one turnComplete when only one assistant.usage fires", async () => {
    const { events } = await runWithMockSession([
      { name: "assistant.usage", data: { inputTokens: 5000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    ]);

    // One usage event → still exactly one turnComplete (on session.idle, not on usage)
    expect(events.filter((e) => e.type === "turnComplete")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// complete() - one-shot text completion
// ---------------------------------------------------------------------------

describe("CopilotProvider.complete()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.getState.mockReturnValue("connected");
    mockClient.start.mockResolvedValue(undefined);
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: (err: Error | null, result?: { stdout: string }) => void) => {
        cb(null, { stdout: "gho_faketoken\n" });
      },
    );
  });

  it("returns collected text from assistant.message event", async () => {
    const mockSession = makeMockSession();
    mockClient.createSession.mockResolvedValue(mockSession);

    const jsonResponse = JSON.stringify({
      title: "feat: add widget",
      body: "## What\nAdded widget",
    });

    mockSession.send.mockImplementation(async () => {
      mockSession.fire("assistant.message", { content: jsonResponse, outputTokens: 42 });
      mockSession.fire("session.idle");
    });

    const provider = new CopilotProvider(makeSettingsService() as any, stubJobObject(), stubEnvService());
    const result = await provider.complete("Generate PR draft", "gpt-4.1", "/tmp");

    expect(result).toBe(jsonResponse);
    expect(mockSession.disconnect).toHaveBeenCalled();
  });

  it("falls back to accumulated deltas when assistant.message has no content", async () => {
    const mockSession = makeMockSession();
    mockClient.createSession.mockResolvedValue(mockSession);

    mockSession.send.mockImplementation(async () => {
      mockSession.fire("assistant.message_delta", { deltaContent: '{"title":' });
      mockSession.fire("assistant.message_delta", { deltaContent: '"feat: x","body":"b"}' });
      mockSession.fire("assistant.message", { content: "", outputTokens: 10 });
      mockSession.fire("session.idle");
    });

    const provider = new CopilotProvider(makeSettingsService() as any, stubJobObject(), stubEnvService());
    const result = await provider.complete("Generate PR draft", "gpt-4.1", "/tmp");

    expect(result).toBe('{"title":"feat: x","body":"b"}');
    expect(mockSession.disconnect).toHaveBeenCalled();
  });

  it("throws when session.error fires", async () => {
    const mockSession = makeMockSession();
    mockClient.createSession.mockResolvedValue(mockSession);

    mockSession.send.mockImplementation(async () => {
      mockSession.fire("session.error", { message: "Model not available" });
    });

    const provider = new CopilotProvider(makeSettingsService() as any, stubJobObject(), stubEnvService());

    await expect(provider.complete("prompt", "gpt-4.1", "/tmp")).rejects.toThrow(
      "Model not available",
    );
    expect(mockSession.disconnect).toHaveBeenCalled();
  });

  it("throws when no text is returned", async () => {
    const mockSession = makeMockSession();
    mockClient.createSession.mockResolvedValue(mockSession);

    mockSession.send.mockImplementation(async () => {
      mockSession.fire("session.idle");
    });

    const provider = new CopilotProvider(makeSettingsService() as any, stubJobObject(), stubEnvService());

    await expect(provider.complete("prompt", "gpt-4.1", "/tmp")).rejects.toThrow(
      "no text content",
    );
    expect(mockSession.disconnect).toHaveBeenCalled();
  });

  it("disconnects the session even when send() throws", async () => {
    const mockSession = makeMockSession();
    mockClient.createSession.mockResolvedValue(mockSession);
    mockSession.send.mockRejectedValue(new Error("network error"));

    const provider = new CopilotProvider(makeSettingsService() as any, stubJobObject(), stubEnvService());

    await expect(provider.complete("prompt", "gpt-4.1", "/tmp")).rejects.toThrow(
      "network error",
    );
    expect(mockSession.disconnect).toHaveBeenCalled();
  });
});

describe("CopilotProvider.runSideChannelQuery()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.getState.mockReturnValue("connected");
    mockClient.start.mockResolvedValue(undefined);
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: (err: Error | null, result?: { stdout: string }) => void) => {
        cb(null, { stdout: "gho_faketoken\n" });
      },
    );
  });

  it("creates a fresh MCP-free session instead of resuming the parent", async () => {
    const mockSession = makeMockSession();
    mockClient.createSession.mockResolvedValue(mockSession);
    mockSession.send.mockImplementation(async () => {
      mockSession.fire("assistant.message", { content: "isolated answer" });
      mockSession.fire("session.idle");
    });

    const provider = new CopilotProvider(makeSettingsService() as any, stubJobObject(), stubEnvService());
    const result = await provider.runSideChannelQuery({
      parentThreadId: "thread-1",
      parentSdkSessionId: "parent-sdk-session",
      prompt: "summarize",
      conversationHistory: "prior context",
      cwd: "/tmp",
    });

    expect(result).toBe("isolated answer");
    expect(mockClient.resumeSession).not.toHaveBeenCalled();
    expect(mockClient.createSession).toHaveBeenCalledTimes(1);
    expect(mockClient.createSession.mock.calls[0]?.[0]).not.toHaveProperty("mcpServers");
    expect(mockSession.send).toHaveBeenCalledWith({
      prompt: expect.stringContaining("prior context"),
    });
  });
});

// ---------------------------------------------------------------------------
// assistant.message phase filtering - thinking content must not reach the UI
// ---------------------------------------------------------------------------

describe("CopilotProvider assistant.message phase filtering", () => {
  it("emits a message event for a normal (no phase) assistant.message", async () => {
    const { events } = await runWithMockSession([
      { name: "assistant.message", data: { content: "Hello, world!", outputTokens: 5 } },
    ]);

    const msgEvts = events.filter((e) => e.type === "message");
    expect(msgEvts).toHaveLength(1);
    expect(msgEvts[0]?.type === "message" && msgEvts[0].content).toBe("Hello, world!");
  });

  it("emits a message event for a response-phase assistant.message", async () => {
    const { events } = await runWithMockSession([
      { name: "assistant.message", data: { content: "Final answer.", outputTokens: 10, phase: "response" } },
    ]);

    const msgEvts = events.filter((e) => e.type === "message");
    expect(msgEvts).toHaveLength(1);
    expect(msgEvts[0]?.type === "message" && msgEvts[0].content).toBe("Final answer.");
  });

  it("does NOT emit a message event for a thinking-phase assistant.message", async () => {
    const { events } = await runWithMockSession([
      { name: "assistant.message", data: { content: "I am reasoning internally...", outputTokens: 20, phase: "thinking" } },
    ]);

    const msgEvts = events.filter((e) => e.type === "message");
    expect(msgEvts).toHaveLength(0);
  });

  it("only emits the response-phase message when both phases fire in the same turn", async () => {
    const { events } = await runWithMockSession([
      { name: "assistant.message", data: { content: "Internal thoughts here.", outputTokens: 15, phase: "thinking" } },
      { name: "assistant.message", data: { content: "Here is my answer.", outputTokens: 8, phase: "response" } },
    ]);

    const msgEvts = events.filter((e) => e.type === "message");
    expect(msgEvts).toHaveLength(1);
    expect(msgEvts[0]?.type === "message" && msgEvts[0].content).toBe("Here is my answer.");
  });

  it("does NOT emit a message event when content is empty", async () => {
    const { events } = await runWithMockSession([
      { name: "assistant.message", data: { content: "", outputTokens: 0 } },
    ]);

    const msgEvts = events.filter((e) => e.type === "message");
    expect(msgEvts).toHaveLength(0);
  });

  it("does NOT emit textDelta events for assistant.reasoning_delta (no handler registered)", async () => {
    const { events } = await runWithMockSession([
      { name: "assistant.reasoning_delta", data: { reasoningId: "r-1", deltaContent: "thinking chunk" } },
      { name: "assistant.message", data: { content: "Actual response.", outputTokens: 5 } },
    ]);

    const deltaEvts = events.filter((e) => e.type === "textDelta");
    // No textDelta from reasoning events - only from assistant.message_delta
    expect(deltaEvts).toHaveLength(0);
    // Response message is still emitted
    const msgEvts = events.filter((e) => e.type === "message");
    expect(msgEvts).toHaveLength(1);
  });
});

describe("CopilotProvider tool completion output", () => {
  it("preserves the provider error message when a tool fails without a result", async () => {
    const { events } = await runWithMockSession([
      {
        name: "tool.execution_complete",
        data: {
          toolCallId: "browser-open-1",
          success: false,
          error: { message: "Browser target did not attach", code: "TOOL_ERROR" },
        },
      },
    ]);

    const result = events.find((event) => event.type === "toolResult");
    expect(result).toMatchObject({
      type: "toolResult",
      toolCallId: "browser-open-1",
      output: "Browser target did not attach",
      isError: true,
    });
  });

  it("prefers detailed UI output while retaining concise result fallback", async () => {
    const { events } = await runWithMockSession([
      {
        name: "tool.execution_complete",
        data: {
          toolCallId: "browser-snapshot-1",
          success: true,
          result: { content: "concise", detailedContent: "complete diagnostics" },
        },
      },
      {
        name: "tool.execution_complete",
        data: {
          toolCallId: "browser-status-1",
          success: true,
          result: { content: "status only" },
        },
      },
    ]);

    expect(events.filter((event) => event.type === "toolResult")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ toolCallId: "browser-snapshot-1", output: "complete diagnostics" }),
        expect.objectContaining({ toolCallId: "browser-status-1", output: "status only" }),
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// listModels() - TTL cache
// ---------------------------------------------------------------------------

describe("CopilotProvider.listModels() cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.getState.mockReturnValue("connected");
    mockClient.start.mockResolvedValue(undefined);
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: (err: Error | null, result?: { stdout: string }) => void) => {
        cb(null, { stdout: "gho_faketoken\n" });
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns cached models on the second call within TTL", async () => {
    mockClient.listModels.mockResolvedValue([
      { id: "gpt-4.1", name: "GPT-4.1", capabilities: {}, billing: {} },
    ]);

    const provider = new CopilotProvider(makeSettingsService() as any, stubJobObject(), stubEnvService());

    const first = await provider.listModels();
    const second = await provider.listModels();

    expect(first).toEqual(second);
    // SDK listModels called only once - second call served from cache
    expect(mockClient.listModels).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after cache expires", async () => {
    vi.useFakeTimers();
    mockClient.listModels.mockResolvedValue([
      { id: "gpt-4.1", name: "GPT-4.1", capabilities: {}, billing: {} },
    ]);

    const provider = new CopilotProvider(makeSettingsService() as any, stubJobObject(), stubEnvService());

    await provider.listModels();
    // Advance past the 10-minute TTL
    vi.advanceTimersByTime(11 * 60 * 1000);
    await provider.listModels();

    expect(mockClient.listModels).toHaveBeenCalledTimes(2);
  });
});
