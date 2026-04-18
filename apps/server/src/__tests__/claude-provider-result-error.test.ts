import "reflect-metadata";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: mockQuery }));
vi.mock("@mcode/shared", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { ClaudeProvider } from "../providers/claude/claude-provider";
import { queryMethodStubs } from "./helpers/mock-sdk-query";
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
      ...queryMethodStubs(),
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

  afterEach(() => {
    provider.shutdown();
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
    const ended = events.filter((e) => e.type === AgentEventType.Ended);
    expect(ended).toHaveLength(1);
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

  it("emits Error (not Message/TurnComplete) when is_error arrives after assistant text", async () => {
    mockQuery.mockImplementation(mockSdkStream([
      { type: "assistant", message: { content: [{ type: "text", text: "partial thought" }] } },
      { type: "result", is_error: true, errors: ["api_overload"] },
    ]));

    const events: Array<{ type: string; error?: string; content?: string }> = [];
    provider.on("event", (e: { type: string; error?: string; content?: string }) => events.push(e));

    await provider.sendMessage({
      sessionId: "mcode-thread-3",
      message: "hi",
      cwd: "/tmp",
      model: "claude-sonnet-4-6",
      resume: false,
      permissionMode: "default",
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(events.some((e) => e.type === AgentEventType.Error)).toBe(true);
    expect(events.some((e) => e.type === AgentEventType.TurnComplete)).toBe(false);
    // Partial assistant text is dropped because the result errored out
    expect(events.some((e) => e.type === AgentEventType.Message)).toBe(false);
  });
});
