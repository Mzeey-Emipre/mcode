/**
 * Tests for the sessionless side-channel fallback in ClaudeProvider.
 *
 * When `resume:` fails because the SDK's process-local session cache is empty
 * (typically after a server restart), `runSideChannelQuery` should transparently
 * retry without `resume:` when `conversationHistory` is supplied, keeping path B
 * alive instead of forcing a fall to path D. When the parent has no live SDK
 * subprocess at all, it should skip resume entirely and use sessionless path
 * B-prime on the first call.
 *
 * NOTE: ClaudeProvider injects EnvService via tsyringe DI and spawns real SDK
 * subprocesses; unit-testing it end-to-end requires mocking both the DI
 * container and the SDK `query()` call. The tests below mock `query` at the
 * module level and construct the provider with a minimal DI stub.
 */

import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted ensures the mock reference is initialized before vi.mock() runs
// (vi.mock calls are hoisted to the top of the file by vitest's transformer).
const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: mockQuery,
}));

// Stub shared logger to suppress noise.
vi.mock("@mcode/shared", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  getMcodeDir: vi.fn(() => "/tmp/mcode"),
  resolveHandoffDir: vi.fn(() => "/tmp/mcode/handoff"),
  newHandoffUlid: vi.fn(() => "01ABCDEF"),
}));

import { ClaudeProvider } from "../claude-provider.js";

/** Minimal EnvService stub used to avoid DI container setup. */
function makeEnvService() {
  return { getEnv: vi.fn(() => ({})) };
}

/** Minimal JobObject stub. */
function makeJobObject() {
  return { assign: vi.fn() };
}

/** Build a ClaudeProvider bypassing DI via Object.create + manual field assignment. */
function makeProvider() {
  const provider = Object.create(ClaudeProvider.prototype) as ClaudeProvider;
  (provider as any).envService = makeEnvService();
  (provider as any).jobObject = makeJobObject();
  // The constructor is bypassed (Object.create) to avoid spawning. After the
  // SessionRuntime migration, runSideChannelQuery reads parent liveness via
  // this.runtime.get(...), so provide a Map-backed runtime stub. The
  // `sessions` map remains the seeding surface used by withLiveParentSession.
  const sessions = new Map();
  (provider as any).sessions = sessions;
  (provider as any).runtime = { get: (id: string) => sessions.get(id) };
  (provider as any).emitter = { emit: vi.fn(), on: vi.fn() };
  return provider;
}

/**
 * Build an async iterable that yields the given messages in sequence.
 * This mimics what the Claude SDK `query()` function returns.
 */
function makeAsyncIterable(messages: Record<string, unknown>[]) {
  return (async function* () {
    for (const m of messages) yield m;
  })();
}

/** Mark the parent thread as having a live SDK subprocess (resume path eligible). */
function withLiveParentSession(provider: ClaudeProvider, threadId = "t_parent") {
  (provider as any).sessions.set(`mcode-${threadId}`, {
    query: { close: vi.fn() },
    pushMessage: vi.fn(),
    closeQueue: vi.fn(),
    model: "claude-sonnet-4-6",
    permissionMode: "default",
    contextWindowMode: undefined,
    lastUsedAt: Date.now(),
    pendingToolUses: new Set<string>(),
  });
}

describe("runSideChannelQuery sessionless fallback", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("uses sessionless path immediately when parent has no live SDK session", async () => {
    const successResult = [
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "# Handoff\n\n## Goal\nStale session fork" }],
        },
      },
    ];
    mockQuery.mockReturnValueOnce(makeAsyncIterable(successResult));

    const provider = makeProvider();
    const result = await (provider as any).runSideChannelQuery({
      parentThreadId: "t_parent",
      parentSdkSessionId: "sdk_abc123",
      prompt: "Generate a handoff document.",
      conversationHistory: "User: hello\nAssistant: hi there",
      cwd: "/tmp/test-cwd",
    });

    expect(result).toBe("# Handoff\n\n## Goal\nStale session fork");
    // Must not attempt resume when no live parent session exists.
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][0].options).not.toHaveProperty("resume");
  });

  it("returns the second call's text when the first call fails with session-missing error and history is provided", async () => {
    const sessionMissingResult = [
      {
        type: "result",
        is_error: true,
        errors: ["No conversation found with session ID: abc123"],
        subtype: "error_max_turns",
        duration_ms: 0,
      },
    ];
    const successResult = [
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "# Handoff\n\n## Goal\nForked task" }],
        },
      },
    ];

    mockQuery
      .mockReturnValueOnce(makeAsyncIterable(sessionMissingResult))
      .mockReturnValueOnce(makeAsyncIterable(successResult));

    const provider = makeProvider();
    withLiveParentSession(provider);
    const result = await (provider as any).runSideChannelQuery({
      parentThreadId: "t_parent",
      parentSdkSessionId: "sdk_abc123",
      prompt: "Generate a handoff document.",
      conversationHistory: "User: hello\nAssistant: hi there",
      cwd: "/tmp/test-cwd",
    });

    expect(result).toBe("# Handoff\n\n## Goal\nForked task");

    // Second call (sessionless) must NOT include `resume` in its options.
    expect(mockQuery).toHaveBeenCalledTimes(2);
    const [, secondCallArgs] = mockQuery.mock.calls;
    expect(secondCallArgs[0].options).not.toHaveProperty("resume");
  });

  it("propagates as ETIMEDOUT when session-missing occurs and no history is provided", async () => {
    const sessionMissingResult = [
      {
        type: "result",
        is_error: true,
        errors: ["No conversation found with session ID: abc123"],
        subtype: "error_max_turns",
        duration_ms: 0,
      },
    ];

    mockQuery.mockReturnValueOnce(makeAsyncIterable(sessionMissingResult));

    const provider = makeProvider();
    const err = await (provider as any)
      .runSideChannelQuery({
        parentThreadId: "t_parent",
        parentSdkSessionId: "sdk_abc123",
        prompt: "Generate a handoff document.",
        cwd: "/tmp/test-cwd",
        // No conversationHistory — should rethrow as ETIMEDOUT
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as any).code).toBe("ETIMEDOUT");
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});
