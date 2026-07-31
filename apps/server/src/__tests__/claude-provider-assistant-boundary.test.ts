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
import { stubEnvService } from "./stub-env-service.js";
import { stubJobObject } from "./stub-job-object.js";
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
});
