import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Simulates real SDK query() behavior: reads user messages from the prompt
 * queue, yields assistant/result messages, then tries to read the next
 * message (blocking if the queue is still open).
 */
function createMockSdkQuery(responseText: string) {
  return ({ prompt }: { prompt: AsyncIterable<unknown>; options: unknown }) => {
    const iterator = prompt[Symbol.asyncIterator]();
    let yielded = false;

    const generator: AsyncGenerator<Record<string, unknown>, void> = {
      async next() {
        if (!yielded) {
          // Read the first user message from the prompt queue
          const userMsg = await iterator.next();
          if (userMsg.done) {
            return { value: undefined as unknown as Record<string, unknown>, done: true };
          }

          yielded = true;

          // Yield the result (simulating SDK response)
          return {
            value: {
              type: "result",
              is_error: false,
              result: responseText,
              usage: { input_tokens: 10, output_tokens: 20 },
              modelUsage: {},
            },
            done: false,
          };
        }

        // After yielding the result, the SDK tries to read the next user message.
        // This is where the deadlock happens if the queue is never closed:
        // the SDK blocks here forever waiting for the next message.
        const nextMsg = await iterator.next();
        if (nextMsg.done) {
          return { value: undefined as unknown as Record<string, unknown>, done: true };
        }
        // If we somehow got another message, just end
        return { value: undefined as unknown as Record<string, unknown>, done: true };
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

    // Return a mock Query object (async generator + control methods)
    return Object.assign(generator, {
      interrupt: vi.fn(),
      setPermissionMode: vi.fn(),
      setModel: vi.fn(),
      setMaxThinkingTokens: vi.fn(),
      applyFlagSettings: vi.fn(),
      initializationResult: vi.fn(),
      supportedCommands: vi.fn(),
      supportedModels: vi.fn(),
      supportedAgents: vi.fn(),
      mcpServerStatus: vi.fn(),
      accountInfo: vi.fn(),
      rewindFiles: vi.fn(),
      reconnectMcpServer: vi.fn(),
      toggleMcpServer: vi.fn(),
      setMcpServers: vi.fn(),
      streamInput: vi.fn(),
      stopTask: vi.fn(),
      close: vi.fn(),
    });
  };
}

const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: mockQuery,
}));

vi.mock("@mcode/shared", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { ClaudeProvider } from "../providers/claude/claude-provider";

describe("ClaudeProvider.complete()", () => {
  let provider: ClaudeProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ClaudeProvider();
  });

  it("resolves with the result text (does not deadlock)", async () => {
    const jsonResponse = JSON.stringify({
      title: "feat: add widget",
      body: "## What\nAdded widget",
    });

    mockQuery.mockImplementation(createMockSdkQuery(jsonResponse));

    // This would hang forever before the fix due to the queue deadlock.
    // Use a timeout to detect the deadlock.
    const result = await Promise.race([
      provider.complete("Generate PR draft", "claude-haiku-4-5-20251001", "/tmp"),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("complete() deadlocked — timed out after 3s")), 3000),
      ),
    ]);

    expect(result).toBe(jsonResponse);
  });

  it("throws when SDK returns an error result", async () => {
    mockQuery.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown>; options: unknown }) => {
      const iterator = prompt[Symbol.asyncIterator]();
      let yielded = false;
      const gen: AsyncGenerator<Record<string, unknown>, void> = {
        async next() {
          if (!yielded) {
            await iterator.next();
            yielded = true;
            return {
              value: { type: "result", is_error: true, errors: ["Invalid API key"] },
              done: false,
            };
          }
          const n = await iterator.next();
          return n.done
            ? { value: undefined as unknown as Record<string, unknown>, done: true }
            : { value: undefined as unknown as Record<string, unknown>, done: true };
        },
        async return() { return { value: undefined as unknown as Record<string, unknown>, done: true }; },
        async throw(e: unknown) { throw e; },
        [Symbol.asyncIterator]() { return this; },
      };
      return Object.assign(gen, {
        interrupt: vi.fn(), setPermissionMode: vi.fn(), setModel: vi.fn(),
        setMaxThinkingTokens: vi.fn(), applyFlagSettings: vi.fn(),
        initializationResult: vi.fn(), supportedCommands: vi.fn(),
        supportedModels: vi.fn(), supportedAgents: vi.fn(), mcpServerStatus: vi.fn(),
        accountInfo: vi.fn(), rewindFiles: vi.fn(), reconnectMcpServer: vi.fn(),
        toggleMcpServer: vi.fn(), setMcpServers: vi.fn(), streamInput: vi.fn(),
        stopTask: vi.fn(), close: vi.fn(),
      });
    });

    await expect(
      Promise.race([
        provider.complete("fail prompt", "claude-haiku-4-5-20251001", "/tmp"),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("complete() deadlocked")), 3000),
        ),
      ]),
    ).rejects.toThrow("Claude SDK error: Invalid API key");
  });
});
