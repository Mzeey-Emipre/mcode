import "reflect-metadata";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { AgentEventType } from "@mcode/contracts";

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));

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

import { ClaudeProvider } from "../claude-provider.js";

function provider(): ClaudeProvider {
  return new ClaudeProvider(
    { getEnv: () => ({}) } as any,
    { addProcess: () => {}, removeProcess: () => {}, killAll: async () => {} } as any,
  );
}

function makeAsyncIterable(messages: Record<string, unknown>[]) {
  const iterable = (async function* () {
    for (const message of messages) yield message;
  })();
  return Object.assign(iterable, {
    close: vi.fn(),
    interrupt: vi.fn(),
    setPermissionMode: vi.fn(),
    setModel: vi.fn(),
    getStderr: vi.fn(() => ""),
  });
}

function nativeSessionEntry(pushMessage: ReturnType<typeof vi.fn>, pendingToolUses = new Set<string>()) {
  return {
    sessionId: "mcode-thread-1",
    cwd: process.cwd(),
    query: { close: vi.fn() },
    pushMessage,
    closeQueue: vi.fn(),
    model: "claude-sonnet-4-6",
    permissionMode: "default",
    contextWindowMode: undefined,
    lastUsedAt: Date.now(),
    pendingToolUses,
    hasFiredToolThisTurn: false,
  };
}

describe("ClaudeProvider native goal support detection", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("enables native mode only when system/init slash_commands contains goal", () => {
    const claude = provider();

    claude.observeNativeGoalCommands("mcode-thread-1", ["goal"], "2.1.186");
    claude.observeNativeGoalCommands("mcode-thread-2", [], "2.1.186");

    expect(claude.hasNativeGoalCommand("mcode-thread-1")).toBe(true);
    expect(claude.hasNativeGoalCommand("mcode-thread-2")).toBe(false);
  });

  it("does not enable native mode from version telemetry alone", () => {
    const claude = provider();

    expect(claude.hasNativeGoalCommand("mcode-thread-1")).toBe(false);
  });

  it("still emits system status events after observing slash_commands", async () => {
    mockQuery.mockReturnValueOnce(makeAsyncIterable([
      { type: "system", subtype: "init", slash_commands: ["goal"], claude_code_version: "2.1.186" },
      { type: "system", subtype: "status", status: "compacting" },
    ]));
    const claude = provider();
    const events: Array<{ type: string; active?: boolean }> = [];
    claude.on("event", (event) => events.push(event as { type: string; active?: boolean }));

    await claude.sendTurn({
      turnExecutionId: "test-execution",
      sessionId: "mcode-thread-1",
      workspaceId: "workspace-test",
      threadId: "thread-1",
      message: "hello",
      cwd: process.cwd(),
      model: "claude-sonnet-4-6",
      permissionMode: "default",
      interactionMode: "build",
      providerOptions: {},
    });

    for (let i = 0; i < 20 && !events.some((event) => event.type === AgentEventType.Compacting); i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    expect(claude.hasNativeGoalCommand("mcode-thread-1")).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({
      type: AgentEventType.Compacting,
      active: true,
    }));
  });

  it("does not enqueue native /goal when the pooled session is busy", async () => {
    const claude = provider();
    const pushMessage = vi.fn();
    claude.observeNativeGoalCommands("mcode-thread-1", ["goal"], "2.1.186");
    (claude as any).runtime = {
      get: vi.fn(() => nativeSessionEntry(pushMessage, new Set(["tool-1"]))),
    };

    await expect(claude.runNativeGoalCommand("mcode-thread-1", "/goal", 10)).resolves.toBeNull();
    expect(pushMessage).not.toHaveBeenCalled();
  });
});
