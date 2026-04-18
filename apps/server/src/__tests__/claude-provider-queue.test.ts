import "reflect-metadata";
import { describe, it, expect, afterEach } from "vitest";
import { createPromptQueue } from "../providers/claude/claude-provider";

/** Minimal SDKUserMessage shape for push() calls. */
function msg(text: string) {
  return {
    type: "user" as const,
    message: { role: "user" as const, content: text },
    parent_tool_use_id: null,
    session_id: "sid",
  };
}

describe("createPromptQueue (#292)", () => {
  it("throws a descriptive error when push() is called after close()", () => {
    const q = createPromptQueue();
    q.close();
    expect(() => q.push(msg("hello"))).toThrow(/closed/i);
  });

  it("accepts push() before close() as before (no regression)", () => {
    const q = createPromptQueue();
    expect(() => q.push(msg("hello"))).not.toThrow();
    q.close();
  });

  it("yields queued messages then ends after close()", async () => {
    const q = createPromptQueue();
    q.push(msg("a"));
    q.push(msg("b"));
    q.close();

    const got: string[] = [];
    for await (const m of q.iterable) {
      got.push((m.message.content as string));
    }
    expect(got).toEqual(["a", "b"]);
  });
});

import { vi } from "vitest";
import { AgentEventType } from "@mcode/contracts";

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: mockQuery }));
vi.mock("@mcode/shared", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { ClaudeProvider } from "../providers/claude/claude-provider";
import { queryMethodStubs } from "./helpers/mock-sdk-query";

describe("ClaudeProvider sendMessage on closed queue (#292)", () => {
  let provider: ClaudeProvider | undefined;

  afterEach(() => {
    provider?.shutdown();
    provider = undefined;
  });

  it("emits Error event when the session's queue was already closed", async () => {
    // A mock Query that consumes the first user message then hangs.
    mockQuery.mockImplementation(({ prompt }) => {
      const it = (prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
      const gen: AsyncGenerator<Record<string, unknown>, void> = {
        async next() {
          await it.next();
          return new Promise(() => { /* hang */ });
        },
        async return() { return { value: undefined as never, done: true }; },
        async throw(e: unknown) { throw e; },
        [Symbol.asyncIterator]() { return this; },
      };
      return Object.assign(gen, {
        ...queryMethodStubs(),
        close: vi.fn(),
      });
    });

    provider = new ClaudeProvider();
    const events: Array<{ type: string; error?: string }> = [];
    provider.on("event", (e: { type: string; error?: string }) => events.push(e));

    // First send establishes the session
    await provider.sendMessage({
      sessionId: "mcode-t1",
      message: "first",
      cwd: "/tmp",
      model: "claude-sonnet-4-6",
      resume: false,
      permissionMode: "default",
    });

    // Simulate race by closing the queue directly
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entry = (provider as any).sessions.get("mcode-t1");
    entry.closeQueue();

    // Second send on same sessionId: push hits a closed queue
    await expect(
      provider.sendMessage({
        sessionId: "mcode-t1",
        message: "second",
        cwd: "/tmp",
        model: "claude-sonnet-4-6",
        resume: false,
        permissionMode: "default",
      }),
    ).rejects.toThrow(/closed/i);

    const errorEvents = events.filter((e) => e.type === AgentEventType.Error);
    expect(errorEvents.length).toBeGreaterThan(0);
  });

  it("keeps the session alive on queue overflow (does not delete)", async () => {
    // SDK mock that accepts the first message then never asks for more,
    // so subsequent pushes stack up in the queue until it overflows.
    mockQuery.mockImplementation(({ prompt }) => {
      const it = (prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
      let consumedFirst = false;
      const gen: AsyncGenerator<Record<string, unknown>, void> = {
        async next() {
          if (!consumedFirst) {
            consumedFirst = true;
            await it.next();
          }
          return new Promise(() => { /* hang, do not drain further */ });
        },
        async return() { return { value: undefined as never, done: true }; },
        async throw(e: unknown) { throw e; },
        [Symbol.asyncIterator]() { return this; },
      };
      return Object.assign(gen, {
        ...queryMethodStubs(),
        close: vi.fn(),
      });
    });

    provider = new ClaudeProvider();
    const events: Array<{ type: string; error?: string }> = [];
    provider.on("event", (e: { type: string; error?: string }) => events.push(e));

    // First send establishes the session
    await provider.sendMessage({
      sessionId: "mcode-overflow",
      message: "first",
      cwd: "/tmp",
      model: "claude-sonnet-4-6",
      resume: false,
      permissionMode: "default",
    });

    // Saturate the queue: MAX_QUEUE_DEPTH is 20, so push many more than that.
    // Some will succeed (within depth), then one will throw with "queue full".
    let overflowErr: Error | undefined;
    for (let i = 0; i < 25; i++) {
      try {
        await provider.sendMessage({
          sessionId: "mcode-overflow",
          message: `msg-${i}`,
          cwd: "/tmp",
          model: "claude-sonnet-4-6",
          resume: false,
          permissionMode: "default",
        });
      } catch (e) {
        overflowErr = e as Error;
        break;
      }
    }

    expect(overflowErr).toBeDefined();
    expect(overflowErr!.message).toMatch(/queue full/i);

    // Critical behavior: the session entry must still exist so the next
    // delivery is not forced into a full cold-start.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sessions = (provider as any).sessions as Map<string, unknown>;
    expect(sessions.has("mcode-overflow")).toBe(true);

    // And an Error event surfaced to the caller, but with the raw overflow
    // message (not the "session was shutting down" closed-session wording).
    const errorEvents = events.filter((e) => e.type === AgentEventType.Error);
    expect(errorEvents.length).toBeGreaterThan(0);
    expect(errorEvents.some((e) => /queue full/i.test(e.error ?? ""))).toBe(true);
    expect(errorEvents.every((e) => !/shutting down/i.test(e.error ?? ""))).toBe(true);
  });
});
