import "reflect-metadata";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: mockQuery }));
vi.mock("@mcode/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mcode/shared")>();
  return {
    ...actual,
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
  };
});

import { ClaudeProvider } from "../providers/claude/claude-provider";
import { stubEnvService } from "../runtime/environment/__tests__/stub-env-service.js";
import { stubJobObject } from "../runtime/process/containment/__tests__/stub-job-object.js";
import { queryMethodStubs } from "./helpers/mock-sdk-query";

/** Mock SDK that yields a tool_use then pauses indefinitely (simulating a long-running tool). */
function makeToolUseStream() {
  return ({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    const it = prompt[Symbol.asyncIterator]();
    const queue: Array<Record<string, unknown>> = [
      { type: "system", subtype: "init", session_id: "sdk-1" },
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "tool-1", name: "Bash", input: { cmd: "sleep 900" } },
          ],
        },
      },
    ];
    let i = 0;
    let resolvePause: (() => void) | null = null;
    const paused = new Promise<void>((r) => { resolvePause = r; });
    const gen: AsyncGenerator<Record<string, unknown>, void> = {
      async next() {
        if (i === 0) await it.next();
        if (i < queue.length) return { value: queue[i++], done: false };
        await paused;
        return { value: undefined as never, done: true };
      },
      async return() { resolvePause?.(); return { value: undefined as never, done: true }; },
      async throw(e: unknown) { throw e; },
      [Symbol.asyncIterator]() { return this; },
    };
    return Object.assign(gen, {
      ...queryMethodStubs(),
      close: vi.fn(() => resolvePause?.()),
    });
  };
}

describe("ClaudeProvider idle eviction with pending tool_use (#291)", () => {
  let provider: ClaudeProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    provider = new ClaudeProvider(stubEnvService(), stubJobObject());
  });

  afterEach(() => {
    provider.shutdown();
    vi.useRealTimers();
  });

  it("does NOT evict a session while a tool_use is still pending", async () => {
    mockQuery.mockImplementation(makeToolUseStream());

    await provider.sendTurn({
      turnExecutionId: "test-execution",
      sessionId: "mcode-t1",
      threadId: "t1",
      message: "run something long",
      cwd: "/tmp",
      model: "claude-sonnet-4-6",
      permissionMode: "default",
      interactionMode: "build",
      providerOptions: {},
    });

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);

    // Session lifecycle now lives in the SessionRuntime; the provider's
    // `isBusy` adapter method keeps a session with pending tool_use out of
    // idle eviction (logging the skip), so the session must still be live.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runtime = (provider as any).runtime as { get: (id: string) => unknown };
    expect(runtime.get("mcode-t1")).toBeDefined();
    const { logger } = await import("@mcode/shared");
    expect(logger.debug).toHaveBeenCalledWith(
      "Skipping eviction: pending tool calls",
      expect.objectContaining({ pending: 1 }),
    );
  });

  it("evicts the session once the tool completes and the idle window elapses", async () => {
    let resolveTool: (() => void) | null = null;
    const toolDone = new Promise<void>((r) => { resolveTool = r; });
    mockQuery.mockImplementation(({ prompt }) => {
      const it = (prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
      let phase = 0;
      const gen: AsyncGenerator<Record<string, unknown>, void> = {
        async next() {
          if (phase === 0) { await it.next(); phase = 1;
            return { value: { type: "system", subtype: "init", session_id: "sdk-2" }, done: false }; }
          if (phase === 1) { phase = 2;
            return { value: {
              type: "assistant",
              message: { content: [{ type: "tool_use", id: "tool-2", name: "Bash", input: {} }] },
            }, done: false }; }
          if (phase === 2) { await toolDone; phase = 3;
            return { value: { type: "tool_result", tool_use_id: "tool-2", content: "ok" }, done: false }; }
          return { value: undefined as never, done: true };
        },
        async return() { resolveTool?.(); return { value: undefined as never, done: true }; },
        async throw(e: unknown) { throw e; },
        [Symbol.asyncIterator]() { return this; },
      };
      return Object.assign(gen, {
        ...queryMethodStubs(),
        close: vi.fn(() => resolveTool?.()),
      });
    });

    await provider.sendTurn({
      turnExecutionId: "test-execution",
      sessionId: "mcode-t2",
      threadId: "t2",
      message: "run",
      cwd: "/tmp",
      model: "claude-sonnet-4-6",
      permissionMode: "default",
      interactionMode: "build",
      providerOptions: {},
    });

    await vi.advanceTimersByTimeAsync(100);

    // Complete the tool
    resolveTool!();
    await vi.advanceTimersByTimeAsync(100);

    // Now advance past the idle window
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);

    // The runtime's idle sweep evicts a non-busy session once its TTL lapses.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runtime = (provider as any).runtime as { get: (id: string) => unknown };
    expect(runtime.get("mcode-t2")).toBeUndefined();
  });
});
