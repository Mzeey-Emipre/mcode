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
import { AgentEventType } from "@mcode/contracts";

/** Build a minimal mock Query that yields init, assistant messages, then result. */
function mockSdkStream(messages: Array<Record<string, unknown>>) {
  return ({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    const iterator = prompt[Symbol.asyncIterator]();
    const queue = [
      { type: "system", subtype: "init", session_id: "sdk-boundary" },
      ...messages,
    ];
    let i = 0;
    const gen: AsyncGenerator<Record<string, unknown>, void> = {
      async next() {
        if (i === 0) await iterator.next();
        if (i < queue.length) return { value: queue[i++], done: false };
        return { value: undefined as never, done: true };
      },
      async return() {
        return { value: undefined as never, done: true };
      },
      async throw(e: unknown) {
        throw e;
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    return Object.assign(gen, {
      ...queryMethodStubs(),
      close: vi.fn(),
    });
  };
}

describe("ClaudeProvider AssistantMessageBoundary from stop_reason", () => {
  let provider: ClaudeProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ClaudeProvider(stubEnvService(), stubJobObject());
  });

  afterEach(() => {
    provider.shutdown();
  });

  it("emits isFinalResponse=true when stop_reason is end_turn", async () => {
    mockQuery.mockImplementation(
      mockSdkStream([
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Here is the answer." }],
            stop_reason: "end_turn",
          },
        },
        { type: "result", is_error: false, result: "Here is the answer.", usage: { output_tokens: 5 } },
      ]),
    );

    const boundaries: Array<{ isFinalResponse?: boolean }> = [];
    provider.on("event", (e: { type: string; isFinalResponse?: boolean }) => {
      if (e.type === AgentEventType.AssistantMessageBoundary) boundaries.push(e);
    });

    await provider.sendTurn({
      turnExecutionId: "test-execution",
      sessionId: "mcode-thread-boundary-final",
      threadId: "thread-boundary-final",
      message: "hi",
      cwd: "/tmp",
      model: "claude-sonnet-4-6",
      permissionMode: "default",
      interactionMode: "build",
      providerOptions: {},
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(boundaries).toHaveLength(1);
    expect(boundaries[0]?.isFinalResponse).toBe(true);
  });

  it("emits isFinalResponse=false when stop_reason is tool_use", async () => {
    mockQuery.mockImplementation(
      mockSdkStream([
        {
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "Let me read the file." },
              {
                type: "tool_use",
                id: "tu-1",
                name: "Read",
                input: { file_path: "/a.ts" },
              },
            ],
            stop_reason: "tool_use",
          },
        },
        { type: "result", is_error: false, result: "done", usage: { output_tokens: 3 } },
      ]),
    );

    const boundaries: Array<{ isFinalResponse?: boolean }> = [];
    provider.on("event", (e: { type: string; isFinalResponse?: boolean }) => {
      if (e.type === AgentEventType.AssistantMessageBoundary) boundaries.push(e);
    });

    await provider.sendTurn({
      turnExecutionId: "test-execution",
      sessionId: "mcode-thread-boundary-preamble",
      threadId: "thread-boundary-preamble",
      message: "read file",
      cwd: "/tmp",
      model: "claude-sonnet-4-6",
      permissionMode: "default",
      interactionMode: "build",
      providerOptions: {},
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(boundaries).toHaveLength(1);
    expect(boundaries[0]?.isFinalResponse).toBe(false);
  });

  it("does not emit AssistantMessageBoundary for text-free tool-only messages", async () => {
    mockQuery.mockImplementation(
      mockSdkStream([
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "tu-2",
                name: "Read",
                input: { file_path: "/b.ts" },
              },
            ],
            stop_reason: "tool_use",
          },
        },
        { type: "result", is_error: false, result: "done", usage: { output_tokens: 1 } },
      ]),
    );

    const boundaries: unknown[] = [];
    provider.on("event", (e: { type: string }) => {
      if (e.type === AgentEventType.AssistantMessageBoundary) boundaries.push(e);
    });

    await provider.sendTurn({
      turnExecutionId: "test-execution",
      sessionId: "mcode-thread-boundary-no-text",
      threadId: "thread-boundary-no-text",
      message: "go",
      cwd: "/tmp",
      model: "claude-sonnet-4-6",
      permissionMode: "default",
      interactionMode: "build",
      providerOptions: {},
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(boundaries).toHaveLength(0);
  });

  it("keeps queued execution identity behind an internal result continuation", async () => {
    let releaseContinuation!: () => void;
    const continuationReleased = new Promise<void>((resolve) => {
      releaseContinuation = resolve;
    });
    let resolveTurnComplete!: () => void;
    const turnCompleteSeen = new Promise<void>((resolve) => {
      resolveTurnComplete = resolve;
    });
    let resolveBText!: () => void;
    const bTextSeen = new Promise<void>((resolve) => {
      resolveBText = resolve;
    });
    const events: Array<{ type: string; turnExecutionId?: string; delta?: string }> = [];

    mockQuery.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
      const iterator = prompt[Symbol.asyncIterator]();
      let stage = 0;
      const gen: AsyncGenerator<Record<string, unknown>, void> = {
        async next() {
          switch (stage++) {
            case 0:
              await iterator.next();
              return { value: { type: "system", subtype: "init", session_id: "sdk-ordering" }, done: false };
            case 1:
              return {
                value: {
                  type: "assistant",
                  message: { content: [{ type: "text", text: "A" }], stop_reason: "end_turn" },
                },
                done: false,
              };
            case 2:
              return { value: { type: "result", is_error: false, result: "A", usage: { output_tokens: 1 } }, done: false };
            case 3:
              await continuationReleased;
              return {
                value: {
                  type: "stream_event",
                  event: { type: "content_block_delta", delta: { type: "text_delta", text: "A continuation" } },
                },
                done: false,
              };
            case 4:
              await iterator.next();
              return {
                value: {
                  type: "assistant",
                  message: { content: [{ type: "text", text: "B" }], stop_reason: "end_turn" },
                },
                done: false,
              };
            case 5:
              return {
                value: {
                  type: "stream_event",
                  event: { type: "content_block_delta", delta: { type: "text_delta", text: "B started" } },
                },
                done: false,
              };
            case 6:
              return { value: { type: "result", is_error: false, result: "B", usage: { output_tokens: 1 } }, done: false };
            default:
              return { value: undefined as never, done: true };
          }
        },
        async return() {
          return { value: undefined as never, done: true };
        },
        async throw(error: unknown) {
          throw error;
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
      return Object.assign(gen, { ...queryMethodStubs(), close: vi.fn() });
    });

    provider.on("event", (event: { type: string; turnExecutionId?: string; delta?: string }) => {
      events.push(event);
      if (event.type === AgentEventType.TurnComplete && event.turnExecutionId === "A") {
        resolveTurnComplete();
      }
      if (event.type === AgentEventType.TextDelta && event.delta === "B started") {
        resolveBText();
      }
    });

    await provider.sendTurn({
      turnExecutionId: "A",
      sessionId: "mcode-thread-ordering",
      threadId: "thread-ordering",
      message: "first",
      cwd: "/tmp",
      model: "claude-sonnet-4-6",
      permissionMode: "default",
      interactionMode: "build",
      providerOptions: {},
    });
    await turnCompleteSeen;

    await provider.sendTurn({
      turnExecutionId: "B",
      sessionId: "mcode-thread-ordering",
      threadId: "thread-ordering",
      message: "second",
      cwd: "/tmp",
      model: "claude-sonnet-4-6",
      permissionMode: "default",
      interactionMode: "build",
      providerOptions: {},
    });
    releaseContinuation();
    await bTextSeen;

    const continuation = events.find(
      (event) => event.type === AgentEventType.TextDelta && event.delta === "A continuation",
    );
    expect(continuation?.turnExecutionId).toBe("A");
    expect(
      events.some(
        (event) => event.type === AgentEventType.TurnStarted && event.turnExecutionId === "B",
      ),
    ).toBe(true);
    expect(
      events.find((event) => event.type === AgentEventType.TextDelta && event.delta === "B started")?.turnExecutionId,
    ).toBe("B");
  });
});
