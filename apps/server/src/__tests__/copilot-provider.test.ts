import "reflect-metadata";
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import type { AgentEvent } from "@mcode/contracts";

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

import which from "which";
import { CopilotProvider } from "../providers/copilot/copilot-provider.js";

/** Minimal SettingsService stub. */
function makeSettingsService(cliPath = "") {
  return {
    get: vi.fn().mockResolvedValue({
      provider: { cli: { copilot: cliPath } },
    }),
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

      const provider = new CopilotProvider(makeSettingsService() as any);
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

      const provider = new CopilotProvider(makeSettingsService() as any);
      await provider.listModels();

      // which should not be called when not in Electron
      expect(which).not.toHaveBeenCalled();
      const ctorCall = MockCopilotClient.mock.calls[0]?.[0] ?? {};
      expect(ctorCall.cliPath).toBeUndefined();
    });
  });

  describe("gh auth token", () => {
    it("passes githubToken when gh auth succeeds", async () => {
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: object, cb: (err: Error | null, result?: { stdout: string }) => void) => {
          cb(null, { stdout: "gho_abc123\n" });
        },
      );

      const provider = new CopilotProvider(makeSettingsService() as any);
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

      const provider = new CopilotProvider(makeSettingsService() as any);
      await provider.listModels();

      const opts = MockCopilotClient.mock.calls[0]?.[0] ?? {};
      expect(opts.githubToken).toBeUndefined();
    });
  });

  describe("client reuse", () => {
    it("reuses healthy connected client", async () => {
      const provider = new CopilotProvider(makeSettingsService() as any);

      await provider.listModels();
      mockClient.getState.mockReturnValue("connected");
      await provider.listModels();

      // CopilotClient constructor called only once
      expect(MockCopilotClient.mock.calls).toHaveLength(1);
    });
  });

  describe("error translation", () => {
    it("translates CLI server exited to auth instructions", async () => {
      mockClient.start.mockResolvedValue(undefined);
      mockClient.getState.mockReturnValue("connected");
      mockClient.createSession.mockRejectedValue(
        new Error("CLI server exited with code 1"),
      );

      const provider = new CopilotProvider(makeSettingsService() as any);

      const events: AgentEvent[] = [];
      provider.on("event", (e: AgentEvent) => events.push(e));

      await provider.sendMessage({
        sessionId: "mcode-test1",
        message: "hello",
        cwd: "/tmp",
        model: "gpt-4o",
        resume: false,
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

      const provider = new CopilotProvider(makeSettingsService() as any);

      const events: AgentEvent[] = [];
      provider.on("event", (e: AgentEvent) => events.push(e));

      await provider.sendMessage({
        sessionId: "mcode-test2",
        message: "hello",
        cwd: "/tmp",
        model: "gpt-4o",
        resume: false,
        permissionMode: "auto",
      });

      const errorEvt = events.find((e) => e.type === "error");
      expect(errorEvt).toBeDefined();
      expect(errorEvt?.type === "error" && errorEvt.error).toContain("npm install");
    });
  });
});

// ---------------------------------------------------------------------------
// session.usage_info → ContextEstimate
// ---------------------------------------------------------------------------

describe("CopilotProvider session.usage_info", () => {
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

  /**
   * Helper: run sendMessage with a mock session that fires the given events
   * in sequence after send() resolves, then fires session.idle to end the turn.
   */
  async function runWithSession(
    eventSequence: Array<{ name: string; data?: unknown }>,
  ): Promise<{ events: AgentEvent[] }> {
    const mockSession = makeMockSession();

    mockClient.getState.mockReturnValue("connected");
    mockClient.createSession.mockResolvedValue(mockSession);

    // After send() is called, fire the event sequence then resolve idle.
    mockSession.send.mockImplementation(async () => {
      for (const evt of eventSequence) {
        mockSession.fire(evt.name, evt.data);
      }
      mockSession.fire("session.idle");
    });

    const provider = new CopilotProvider(makeSettingsService() as any);
    const events: AgentEvent[] = [];
    provider.on("event", (e: AgentEvent) => events.push(e));

    await provider.sendMessage({
      sessionId: "mcode-ctx-test",
      message: "hello",
      cwd: "/tmp",
      model: "gpt-4o",
      resume: false,
      permissionMode: "auto",
    });

    return { events };
  }

  it("emits a contextEstimate event when session.usage_info fires", async () => {
    const { events } = await runWithSession([
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
    const { events } = await runWithSession([
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
    const { events } = await runWithSession([
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
    const { events } = await runWithSession([
      {
        name: "assistant.message",
        data: { content: "hello", outputTokens: 10 },
      },
    ]);

    expect(events.find((e) => e.type === "contextEstimate")).toBeUndefined();
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

    const provider = new CopilotProvider(makeSettingsService() as any);
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

    const provider = new CopilotProvider(makeSettingsService() as any);
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

    const provider = new CopilotProvider(makeSettingsService() as any);

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

    const provider = new CopilotProvider(makeSettingsService() as any);

    await expect(provider.complete("prompt", "gpt-4.1", "/tmp")).rejects.toThrow(
      "no text content",
    );
    expect(mockSession.disconnect).toHaveBeenCalled();
  });

  it("disconnects the session even when send() throws", async () => {
    const mockSession = makeMockSession();
    mockClient.createSession.mockResolvedValue(mockSession);
    mockSession.send.mockRejectedValue(new Error("network error"));

    const provider = new CopilotProvider(makeSettingsService() as any);

    await expect(provider.complete("prompt", "gpt-4.1", "/tmp")).rejects.toThrow(
      "network error",
    );
    expect(mockSession.disconnect).toHaveBeenCalled();
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

  it("returns cached models on the second call within TTL", async () => {
    mockClient.listModels.mockResolvedValue([
      { id: "gpt-4.1", name: "GPT-4.1", capabilities: {}, billing: {} },
    ]);

    const provider = new CopilotProvider(makeSettingsService() as any);

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

    const provider = new CopilotProvider(makeSettingsService() as any);

    await provider.listModels();
    // Advance past the 10-minute TTL
    vi.advanceTimersByTime(11 * 60 * 1000);
    await provider.listModels();

    expect(mockClient.listModels).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
