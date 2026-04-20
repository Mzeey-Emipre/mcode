import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Minimal SDK mock returning an async generator that yields one "result"
 * message per user message pushed to the prompt queue. The generator also
 * exposes `setModel`, `setPermissionMode`, and `close` so the provider's
 * existing-session logic can call them without blowing up.
 */
function makeFakeSdkQuery(
  pushCalls: Array<{ options: Record<string, unknown> }>,
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
      setPermissionMode: vi.fn(async () => {}),
      interrupt: vi.fn(async () => {}),
      close: vi.fn(() => {}),
    });

    createdQueries.push(generator as unknown as { setPermissionMode: ReturnType<typeof vi.fn> });

    return generator;
  };
}

const { sdkCalls, createdQueries, mockQuery } = vi.hoisted(() => {
  const sdkCalls: Array<{ options: Record<string, unknown> }> = [];
  const createdQueries: Array<{ setPermissionMode: ReturnType<typeof vi.fn> }> = [];
  return { sdkCalls, createdQueries, mockQuery: vi.fn() };
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: mockQuery,
}));

vi.mock("@mcode/shared", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { ClaudeProvider } from "../providers/claude/claude-provider";

describe("ClaudeProvider permission mode changes", () => {
  let provider: ClaudeProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    sdkCalls.length = 0;
    createdQueries.length = 0;
    mockQuery.mockImplementation(makeFakeSdkQuery(sdkCalls));
    provider = new ClaudeProvider();
  });

  it("reuses the session when permissionMode is unchanged", async () => {
    await provider.sendMessage({
      sessionId: "mcode-thread-a",
      message: "first",
      cwd: process.cwd(),
      model: "claude-sonnet-4-6",
      resume: false,
      permissionMode: "supervised",
    });
    await provider.sendMessage({
      sessionId: "mcode-thread-a",
      message: "second",
      cwd: process.cwd(),
      model: "claude-sonnet-4-6",
      resume: false,
      permissionMode: "supervised",
    });

    // One underlying sdk subprocess for both messages.
    expect(sdkCalls.length).toBe(1);
  });

  it("calls setPermissionMode on the existing session when permissionMode changes", async () => {
    await provider.sendMessage({
      sessionId: "mcode-thread-b",
      message: "first",
      cwd: process.cwd(),
      model: "claude-sonnet-4-6",
      resume: false,
      permissionMode: "supervised",
    });
    await provider.sendMessage({
      sessionId: "mcode-thread-b",
      message: "second",
      cwd: process.cwd(),
      model: "claude-sonnet-4-6",
      resume: false,
      permissionMode: "full",
    });

    // Same subprocess is reused. The mode change does NOT force recreate.
    expect(sdkCalls.length).toBe(1);

    // The SDK's setPermissionMode is called once with the new SDK-mode string.
    expect(createdQueries[0]!.setPermissionMode).toHaveBeenCalledTimes(1);
    expect(createdQueries[0]!.setPermissionMode).toHaveBeenCalledWith("bypassPermissions");

    // The one sdk subprocess was spawned in supervised mode and stayed that way
    // at startup. The live mode switch is via setPermissionMode, not options.
    expect(sdkCalls[0]!.options.permissionMode).toBe("default");
    expect(sdkCalls[0]!.options.allowDangerouslySkipPermissions).toBeUndefined();
  });
});
