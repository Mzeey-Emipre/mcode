import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Verifies the off-band handoff bypass in ClaudeProvider.canUseTool (PRD #538):
 * a Read pre-granted via ScopedPreGrantService is auto-allowed without emitting
 * a permission_request, and all other tool calls fall through to the normal
 * permission flow unchanged.
 *
 * The fake SDK captures the `canUseTool` callback passed to query() so the test
 * can invoke it directly (the real SDK only calls it when the model requests a
 * tool, which this lightweight mock does not simulate).
 */
function makeFakeSdkQuery(captured: { canUseTool?: Function }) {
  return ({
    prompt,
    options,
  }: {
    prompt: AsyncIterable<unknown>;
    options: Record<string, unknown>;
  }) => {
    captured.canUseTool = options.canUseTool as Function;
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
      interrupt: vi.fn(async () => {}),
      close: vi.fn(() => {}),
    });
    return generator;
  };
}

const { captured, mockQuery } = vi.hoisted(() => {
  const captured: { canUseTool?: Function } = {};
  return { captured, mockQuery: vi.fn() };
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

import { ClaudeProvider } from "../providers/claude/claude-provider";
import { ScopedPreGrantService } from "../features/agents/permissions/scoped-pre-grant";
import { stubEnvService } from "../runtime/environment/__tests__/stub-env-service.js";
import { stubJobObject } from "../runtime/process/containment/__tests__/stub-job-object.js";

describe("ClaudeProvider scoped pre-grant (off-band handoff Read)", () => {
  let provider: ClaudeProvider;
  let scopedPreGrant: ScopedPreGrantService;

  beforeEach(() => {
    vi.clearAllMocks();
    captured.canUseTool = undefined;
    mockQuery.mockImplementation(makeFakeSdkQuery(captured));
    scopedPreGrant = new ScopedPreGrantService();
    provider = new ClaudeProvider(stubEnvService(), stubJobObject(), scopedPreGrant);
  });

  async function startTurn(threadId: string): Promise<void> {
    await provider.sendTurn({
      turnExecutionId: "test-execution",
      sessionId: `mcode-${threadId}`,
      threadId,
      message: "hello",
      cwd: process.cwd(),
      model: "claude-sonnet-4-6",
      // supervised => SDK "default": tool calls would normally prompt.
      permissionMode: "supervised",
      interactionMode: "build",
      providerOptions: {},
    });
  }

  it("auto-allows a pre-granted Read without emitting a permission_request", async () => {
    const threadId = "thread-grant";
    const grantedPath = "/tmp/mcode-handoff-thread-grant-123.md";
    scopedPreGrant.issue({ threadId, toolName: "Read", path: grantedPath });

    await startTurn(threadId);
    expect(captured.canUseTool).toBeTypeOf("function");

    const permissionEvents: unknown[] = [];
    provider.on("permission_request", (e) => permissionEvents.push(e));

    const result = await captured.canUseTool!("Read", { path: grantedPath }, {});
    expect(result).toEqual({ behavior: "allow", updatedInput: { path: grantedPath } });
    expect(permissionEvents).toHaveLength(0);
    // One-shot: the grant is consumed and not active afterwards.
    expect(scopedPreGrant.hasActiveGrant(threadId)).toBe(false);
  });

  it("does not bypass a Read of a different path (emits a permission_request)", async () => {
    const threadId = "thread-other";
    scopedPreGrant.issue({ threadId, toolName: "Read", path: "/tmp/granted.md" });

    await startTurn(threadId);
    const permissionEvents: unknown[] = [];
    provider.on("permission_request", (e) => permissionEvents.push(e));

    // Invoke with a non-granted path; the callback awaits a user decision, so
    // race it against a tick to confirm it emitted a request rather than
    // returning an immediate allow.
    const decision = captured.canUseTool!("Read", { path: "/tmp/other.md" }, {});
    await Promise.resolve();
    expect(permissionEvents).toHaveLength(1);
    void decision; // left pending; no resolution needed for this assertion
  });
});
