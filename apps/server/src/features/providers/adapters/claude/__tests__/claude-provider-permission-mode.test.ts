import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Minimal SDK mock returning an async generator that yields one "result"
 * message per user message pushed to the prompt queue. The generator also
 * exposes `setModel`, `interrupt`, and `close` so the provider's existing-session
 * logic (including teardown on permissionMode change) can call them without blowing up.
 */
function makeFakeSdkQuery(
  pushCalls: Array<{ options: Record<string, unknown> }>,
  flagSettingsCalls: Array<Record<string, unknown>>,
) {
  return ({
    prompt,
    options,
  }: {
    prompt: AsyncIterable<unknown>;
    options: Record<string, unknown>;
  }) => {
    pushCalls.push({ options });
    const iterator = prompt[Symbol.asyncIterator]();

    const generator: AsyncGenerator<Record<string, unknown>, void> = {
      async next() {
        const userMsg = await iterator.next();
        if (userMsg.done) {
          return { value: undefined as unknown as Record<string, unknown>, done: true };
        }
        return {
          value: {
            type: "result",
            is_error: false,
            result: "ok",
            usage: { input_tokens: 1, output_tokens: 1 },
            modelUsage: {},
          },
          done: false,
        };
      },
      async return() {
        return { value: undefined as unknown as Record<string, unknown>, done: true };
      },
      async throw(e: unknown) {
        throw e;
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };

    Object.assign(generator, {
      setModel: vi.fn(async () => {}),
      applyFlagSettings: vi.fn(async (settings: Record<string, unknown>) => {
        flagSettingsCalls.push(settings);
      }),
      interrupt: vi.fn(async () => {}),
      close: vi.fn(() => {}),
    });

    return generator;
  };
}

const { sdkCalls, mockQuery } = vi.hoisted(() => {
  const sdkCalls: Array<{ options: Record<string, unknown> }> = [];
  return { sdkCalls, mockQuery: vi.fn() };
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: mockQuery,
}));

vi.mock("@mcode/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mcode/shared")>();
  return {
    ...actual,
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
  };
});

import { ClaudeProvider } from "../claude-provider.js";
import { stubEnvService } from "../../../../../runtime/environment/__tests__/stub-env-service.js";
import { stubJobObject } from "../../../../../runtime/process/containment/__tests__/stub-job-object.js";
import {
  BrowserAutomationCredentialRegistry,
  BrowserAutomationSessionLease,
} from "../../../../browser-automation/index.js";

describe("ClaudeProvider permission mode changes", () => {
  let provider: ClaudeProvider;
  const flagSettingsCalls: Array<Record<string, unknown>> = [];

  beforeEach(() => {
    vi.clearAllMocks();
    sdkCalls.length = 0;
    flagSettingsCalls.length = 0;
    mockQuery.mockImplementation(makeFakeSdkQuery(sdkCalls, flagSettingsCalls));
    provider = new ClaudeProvider(stubEnvService(), stubJobObject());
  });

  it("passes browser MCP through query options without touching process.env", async () => {
    const credentials = new BrowserAutomationCredentialRegistry();
    const lease = new BrowserAutomationSessionLease(credentials);
    lease.configure({
      mcpUrl: "http://127.0.0.1:19400/mcp",
      worktreeIdentity: "worktree-test",
    });
    provider = new ClaudeProvider(stubEnvService(), stubJobObject(), undefined, lease);

    try {
      await provider.sendTurn({
      turnExecutionId: "test-execution",
        sessionId: "mcode-browser-claude",
        workspaceId: "workspace-test",
        threadId: "browser-claude",
        message: "inspect the page",
        cwd: process.cwd(),
        model: "claude-sonnet-4-6",
        permissionMode: "supervised",
        interactionMode: "build",
        providerOptions: {},
      });

      expect(sdkCalls[0]!.options.mcpServers).toMatchObject({
        "mcode-browser": {
          type: "http",
          url: "http://127.0.0.1:19400/mcp",
          headers: { Authorization: expect.stringMatching(/^Bearer [A-Za-z0-9_-]{40,}$/) },
        },
      });
      expect(process.env.MCODE_BROWSER_MCP_TOKEN).toBeUndefined();
      await provider.stopSession("mcode-browser-claude");
    } finally {
      lease.shutdown();
    }
    expect(credentials.size()).toBe(0);
  });

  it("reuses the session when permissionMode is unchanged", async () => {
    await provider.sendTurn({
      turnExecutionId: "test-execution",
      sessionId: "mcode-thread-a",
      threadId: "thread-a",
      message: "first",
      cwd: process.cwd(),
      model: "claude-sonnet-4-6",
      permissionMode: "supervised",
      interactionMode: "build",
      providerOptions: {},
    });
    await provider.sendTurn({
      turnExecutionId: "test-execution",
      sessionId: "mcode-thread-a",
      threadId: "thread-a",
      message: "second",
      cwd: process.cwd(),
      model: "claude-sonnet-4-6",
      permissionMode: "supervised",
      interactionMode: "build",
      providerOptions: {},
    });

    // One underlying sdk subprocess for both messages.
    expect(sdkCalls.length).toBe(1);
  });

  it("tears down and respawns the session when permissionMode changes", async () => {
    await provider.sendTurn({
      turnExecutionId: "test-execution",
      sessionId: "mcode-thread-b",
      threadId: "thread-b",
      message: "first",
      cwd: process.cwd(),
      model: "claude-sonnet-4-6",
      permissionMode: "supervised",
      interactionMode: "build",
      providerOptions: {},
    });
    await provider.sendTurn({
      turnExecutionId: "test-execution",
      sessionId: "mcode-thread-b",
      threadId: "thread-b",
      message: "second",
      cwd: process.cwd(),
      model: "claude-sonnet-4-6",
      permissionMode: "full",
      interactionMode: "build",
      providerOptions: {},
    });

    // The SDK subprocess is respawned because permissionMode is fixed at spawn.
    expect(sdkCalls.length).toBe(2);

    // First spawn was in supervised (SDK "default") mode with no bypass flag.
    expect(sdkCalls[0]!.options.permissionMode).toBe("default");
    expect(sdkCalls[0]!.options.allowDangerouslySkipPermissions).toBeUndefined();

    // Second spawn is in full (SDK "bypassPermissions") mode, still no CLI bypass flag.
    expect(sdkCalls[1]!.options.permissionMode).toBe("bypassPermissions");
    expect(sdkCalls[1]!.options.allowDangerouslySkipPermissions).toBeUndefined();
  });

  it("starts proactive sessions with Ultracode enabled", async () => {
    await provider.sendTurn({
      turnExecutionId: "test-execution",
      sessionId: "mcode-ultracode-new",
      threadId: "ultracode-new",
      message: "delegate this work",
      cwd: process.cwd(),
      model: "claude-opus-4-8",
      permissionMode: "supervised",
      interactionMode: "build",
      orchestrationMode: "proactive",
      providerOptions: {},
    });

    expect(sdkCalls).toHaveLength(1);
    expect(sdkCalls[0]!.options.settings).toMatchObject({ ultracode: true });
  });

  it("applies Ultracode when orchestration changes on a reusable session", async () => {
    const baseRequest = {
      sessionId: "mcode-ultracode-toggle",
      threadId: "ultracode-toggle",
      cwd: process.cwd(),
      model: "claude-opus-4-8",
      permissionMode: "supervised" as const,
      interactionMode: "build" as const,
      providerOptions: {},
    };
    await provider.sendTurn({
      turnExecutionId: "test-execution", ...baseRequest, message: "first", orchestrationMode: "standard" });
    await provider.sendTurn({
      turnExecutionId: "test-execution", ...baseRequest, message: "second", orchestrationMode: "proactive" });

    expect(sdkCalls).toHaveLength(1);
    expect(flagSettingsCalls).toEqual([{ ultracode: true }]);
  });
});
