import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: mockQuery }));
vi.mock("@mcode/shared", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { ClaudeProvider } from "../providers/claude/claude-provider";
import { AgentEventType } from "@mcode/contracts";

/** Build a minimal mock Query that yields one non-result message (so sessionInitialized=true), then the requested result. */
function mockSdkStream(results: Array<Record<string, unknown>>) {
  return ({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    const iterator = prompt[Symbol.asyncIterator]();
    const queue = [
      { type: "system", subtype: "init", session_id: "sdk-abc" },
      ...results,
    ];
    let i = 0;
    const gen: AsyncGenerator<Record<string, unknown>, void> = {
      async next() {
        if (i === 0) await iterator.next(); // consume first user message
        if (i < queue.length) return { value: queue[i++], done: false };
        return { value: undefined as never, done: true };
      },
      async return() { return { value: undefined as never, done: true }; },
      async throw(e: unknown) { throw e; },
      [Symbol.asyncIterator]() { return this; },
    };
    return Object.assign(gen, {
      interrupt: vi.fn(), setPermissionMode: vi.fn(), setModel: vi.fn(),
      setMaxThinkingTokens: vi.fn(), applyFlagSettings: vi.fn(),
      initializationResult: vi.fn(), supportedCommands: vi.fn(),
      supportedModels: vi.fn(), supportedAgents: vi.fn(),
      mcpServerStatus: vi.fn(), accountInfo: vi.fn(), rewindFiles: vi.fn(),
      reconnectMcpServer: vi.fn(), toggleMcpServer: vi.fn(),
      setMcpServers: vi.fn(), streamInput: vi.fn(), stopTask: vi.fn(),
      close: vi.fn(),
    });
  };
}

describe("ClaudeProvider result is_error handling (#293)", () => {
  let provider: ClaudeProvider;
  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ClaudeProvider();
  });

  it("emits Error event and NO TurnComplete when result.is_error is true", async () => {
    mockQuery.mockImplementation(mockSdkStream([
      { type: "result", is_error: true, errors: ["rate_limit_exceeded"] },
    ]));

    const events: Array<{ type: string; error?: string }> = [];
    provider.on("event", (e: { type: string; error?: string }) => events.push(e));

    await provider.sendMessage({
      sessionId: "mcode-thread-1",
      message: "hi",
      cwd: "/tmp",
      model: "claude-sonnet-4-6",
      resume: false,
      permissionMode: "default",
    });

    // Allow the stream loop microtasks to drain
    await new Promise((r) => setTimeout(r, 10));

    const errorEvents = events.filter((e) => e.type === AgentEventType.Error);
    const turnComplete = events.filter((e) => e.type === AgentEventType.TurnComplete);
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0].error).toContain("rate_limit_exceeded");
    expect(turnComplete).toHaveLength(0);
  });

  it("emits TurnComplete (not Error) for a successful result", async () => {
    mockQuery.mockImplementation(mockSdkStream([
      { type: "result", is_error: false, result: "ok", usage: {}, modelUsage: {} },
    ]));

    const events: Array<{ type: string }> = [];
    provider.on("event", (e: { type: string }) => events.push(e));

    await provider.sendMessage({
      sessionId: "mcode-thread-2",
      message: "hi",
      cwd: "/tmp",
      model: "claude-sonnet-4-6",
      resume: false,
      permissionMode: "default",
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(events.some((e) => e.type === AgentEventType.Error)).toBe(false);
    expect(events.some((e) => e.type === AgentEventType.TurnComplete)).toBe(true);
  });
});
