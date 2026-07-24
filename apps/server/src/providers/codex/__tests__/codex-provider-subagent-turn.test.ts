import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@mcode/shared", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock("../codex-version.js", () => ({
  checkCodexVersion: () => ({ ok: true, version: "0.40.0" }),
  meetsMinVersion: () => true,
}));

const { sendTurnMock, getChildThreadMetadataMock } = vi.hoisted(() => ({
  sendTurnMock: vi.fn().mockResolvedValue("turn-main"),
  getChildThreadMetadataMock: vi.fn().mockResolvedValue({ model: "gpt-5.6-sol", reasoningEffort: "medium" }),
}));

vi.mock("../codex-app-server.js", async () => {
  const { EventEmitter } = await import("events");
  class MockCodexAppServer extends EventEmitter {
    isAlive = true;
    threadId = "sdk-thread-1";
    resumeFailed = false;
    async start(): Promise<void> {}
    async sendTurn(input: unknown, turnOptions: unknown): Promise<string> {
      return sendTurnMock(input, turnOptions);
    }
    async getChildThreadMetadata(childThreadId: string): Promise<{ model: string; reasoningEffort: string }> {
      return getChildThreadMetadataMock(childThreadId);
    }
    async interruptTurn(): Promise<void> {}
    async kill(): Promise<void> {}
  }
  return { CodexAppServer: MockCodexAppServer };
});

import { CodexProvider } from "../codex-provider.js";
import { AgentEventType } from "@mcode/contracts";
import type { AgentEvent } from "@mcode/contracts";
import { stubEnvService } from "../../../__tests__/stub-env-service.js";

interface PoolEntry {
  pendingTurnId: string | null;
  server: { emit: (event: string, payload: unknown) => void };
}

/** Spawns a provider session and returns its pool entry once the first turn was sent. */
async function startSession(
  provider: CodexProvider,
  sessionId: string,
  threadId: string,
): Promise<PoolEntry> {
  await provider.sendTurn({
    sessionId,
    threadId,
    message: "hey",
    cwd: process.cwd(),
    model: "gpt-5.4",
    interactionMode: "build",
    providerOptions: {},
    permissionMode: "auto",
  });

  for (let i = 0; i < 20 && sendTurnMock.mock.calls.length === 0; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(sendTurnMock).toHaveBeenCalled();

  const pool = (
    provider as unknown as {
      runtime: { get: (id: string) => PoolEntry | undefined };
    }
  ).runtime;
  const entry = pool.get(sessionId);
  expect(entry).toBeDefined();
  return entry!;
}

function makeProvider(): CodexProvider {
  return new CodexProvider(
    { get: async () => ({ provider: { cli: { codex: "codex" } } }) } as never,
    { assign: vi.fn(), isWindowsJob: false } as never,
    stubEnvService() as never,
    { persistGeneratedImageFromPath: vi.fn() } as never,
    {
      currentSkills: vi.fn(() => []),
      currentPrompts: vi.fn(() => []),
      refreshCustomPrompts: vi.fn(async () => ({ prompts: [] })),
      refresh: vi.fn(async () => ({ skills: [] })),
      onSkillsChanged: vi.fn(() => () => undefined),
      shutdown: vi.fn(async () => undefined),
    } as never,
  );
}

/**
 * Regression: Codex sub-agent (collab receiver) threads stream their own
 * turn/started + turn/completed over the same app-server connection. The
 * provider's turn bookkeeping must only react to main-thread lifecycle
 * notifications — otherwise a finishing sub-agent resolves the main runTurn
 * wait, emits Ended mid-turn, and the UI drops the running indicator while
 * narration keeps streaming (and the still-busy session becomes evictable).
 */
describe("CodexProvider sub-agent turn lifecycle isolation", () => {
  beforeEach(() => {
    sendTurnMock.mockClear();
    getChildThreadMetadataMock.mockClear();
  });

  it("enriches nested native sub-agents from one authoritative child lookup each", async () => {
    const provider = makeProvider();
    const events: AgentEvent[] = [];
    provider.on("event", (event: AgentEvent) => events.push(event));
    const entry = await startSession(provider, "mcode-subagent-metadata", "subagent-metadata");

    entry.server.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "sdk-thread-1",
        item: {
          type: "subAgentActivity",
          id: "call-outer",
          kind: "started",
          agentThreadId: "child-outer",
          agentPath: "/root/explorer",
        },
      },
    });
    entry.server.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "child-outer",
        item: {
          type: "subAgentActivity",
          id: "call-inner",
          kind: "started",
          agentThreadId: "child-inner",
          agentPath: "/root/implementer",
        },
      },
    });
    entry.server.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "child-outer",
        item: {
          type: "subAgentActivity",
          id: "call-inner",
          kind: "started",
          agentThreadId: "child-inner",
          agentPath: "/root/implementer",
        },
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(getChildThreadMetadataMock).toHaveBeenCalledTimes(2);
    expect(events).toContainEqual(expect.objectContaining({
      type: AgentEventType.ToolUse,
      toolCallId: "call-inner",
      parentToolCallId: "call-outer",
      toolInput: expect.objectContaining({ model: "gpt-5.6-sol", reasoningEffort: "medium" }),
    }));
  });

  it("bounds child metadata lookup dedupe to the active main turn", async () => {
    const provider = makeProvider();
    const entry = await startSession(provider, "mcode-subagent-metadata-reset", "subagent-metadata-reset");
    const childActivity = {
      method: "item/completed",
      params: {
        threadId: "sdk-thread-1",
        item: {
          type: "subAgentActivity",
          id: "call-repeat-child",
          kind: "started",
          agentThreadId: "child-repeat",
          agentPath: "/root/explorer",
        },
      },
    };

    entry.server.emit("notification", childActivity);
    await new Promise<void>((resolve) => setImmediate(resolve));
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-next" } },
    });
    entry.server.emit("notification", childActivity);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(getChildThreadMetadataMock).toHaveBeenCalledTimes(2);
  });

  it("ignores stale metadata lookup results after a new main turn starts", async () => {
    let resolveOldMetadata: ((value: { model: string; reasoningEffort: string }) => void) | undefined;
    getChildThreadMetadataMock
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOldMetadata = resolve; }))
      .mockResolvedValueOnce({ model: "gpt-current", reasoningEffort: "high" });
    const provider = makeProvider();
    const events: AgentEvent[] = [];
    provider.on("event", (event: AgentEvent) => events.push(event));
    const entry = await startSession(provider, "mcode-subagent-metadata-race", "subagent-metadata-race");
    const oldActivity = {
      method: "item/completed",
      params: {
        threadId: "sdk-thread-1",
        item: {
          type: "subAgentActivity",
          id: "call-old-metadata",
          kind: "started",
          agentThreadId: "child-reused",
          agentPath: "/root/explorer",
        },
      },
    };

    entry.server.emit("notification", oldActivity);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(getChildThreadMetadataMock).toHaveBeenCalledTimes(1);

    await provider.sendTurn({
      sessionId: "mcode-subagent-metadata-race",
      threadId: "subagent-metadata-race",
      message: "next turn",
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "auto",
    });
    for (let i = 0; i < 20 && sendTurnMock.mock.calls.length < 2; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(sendTurnMock).toHaveBeenCalledTimes(2);
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-next" } },
    });
    entry.server.emit("notification", {
      ...oldActivity,
      params: {
        ...oldActivity.params,
        item: { ...oldActivity.params.item, id: "call-current-metadata" },
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    resolveOldMetadata?.({ model: "gpt-stale", reasoningEffort: "low" });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const currentMetadataEvents = events.filter((event) =>
      event.type === AgentEventType.ToolUse
      && event.toolCallId === "call-current-metadata"
      && event.toolInput.model !== undefined,
    );
    expect(currentMetadataEvents).toEqual([expect.objectContaining({
      toolInput: expect.objectContaining({ model: "gpt-current", reasoningEffort: "high" }),
    })]);
  });

  it("does not let a child-thread turn/started overwrite pendingTurnId", async () => {
    const provider = makeProvider();
    const entry = await startSession(provider, "mcode-subagent-a", "subagent-a");

    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-main" } },
    });
    expect(entry.pendingTurnId).toBe("turn-main");

    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "child-thread-9", turn: { id: "turn-child" } },
    });
    expect(entry.pendingTurnId).toBe("turn-main");
  });

  it("does not emit Ended when a child-thread turn completes mid main turn", async () => {
    const provider = makeProvider();
    const events: AgentEvent[] = [];
    provider.on("event", (e: AgentEvent) => events.push(e));

    const entry = await startSession(provider, "mcode-subagent-b", "subagent-b");

    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-main" } },
    });

    // Child completion with its own turn id.
    entry.server.emit("notification", {
      method: "turn/completed",
      params: { threadId: "child-thread-9", turn: { id: "turn-child", status: "completed" } },
    });
    // Child completion without a turn id (shape observed from wait-less collabs).
    entry.server.emit("notification", {
      method: "turn/completed",
      params: { threadId: "child-thread-10", turn: { status: "completed" } },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(events.filter((e) => e.type === AgentEventType.Ended)).toHaveLength(0);
    expect(entry.pendingTurnId).toBe("turn-main");

    const ended = new Promise<void>((resolve) => {
      provider.on("event", (e: AgentEvent) => {
        if (e.type === AgentEventType.Ended && e.threadId === "subagent-b") resolve();
      });
    });
    entry.server.emit("notification", {
      method: "turn/completed",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-main", status: "completed" } },
    });
    await ended;
  });
});
