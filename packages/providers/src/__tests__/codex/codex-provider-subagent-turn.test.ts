import { describe, it, expect, vi, beforeEach } from "vitest";

const { loggerWarnMock } = vi.hoisted(() => ({ loggerWarnMock: vi.fn() }));

vi.mock("@mcode/shared", () => ({
  logger: { warn: loggerWarnMock, info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock("../../private/codex/codex-version.js", () => ({
  checkCodexVersion: () => ({ ok: true, version: "0.40.0" }),
  meetsMinVersion: () => true,
}));

const { sendTurnMock, getChildThreadMetadataMock, interruptChildTurnMock } = vi.hoisted(() => ({
  sendTurnMock: vi.fn().mockResolvedValue(null),
  getChildThreadMetadataMock: vi.fn().mockResolvedValue({ model: "gpt-5.6-sol", reasoningEffort: "medium" }),
  interruptChildTurnMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../private/codex/codex-app-server.js", async () => {
  const { EventEmitter } = await import("events");
  class MockCodexAppServer extends EventEmitter {
    isAlive = true;
    threadId = "sdk-thread-1";
    resumeFailed = false;
    async start(): Promise<void> {}
    async sendTurn(input: unknown, turnOptions: unknown): Promise<string | null> {
      return sendTurnMock(input, turnOptions);
    }
    async getChildThreadMetadata(childThreadId: string): Promise<{ model: string; reasoningEffort: string }> {
      return getChildThreadMetadataMock(childThreadId);
    }
    async interruptTurn(): Promise<void> {}
    async interruptChildTurn(nativeThreadId: string, nativeTurnId: string): Promise<void> {
      await interruptChildTurnMock(nativeThreadId, nativeTurnId);
    }
    async kill(): Promise<void> {}
  }
  return { CodexAppServer: MockCodexAppServer };
});

import { CodexProvider, stubEnvService } from "./codex-provider-test-fixture.js";
import { AgentEventType } from "@mcode/contracts";
import type { AgentEvent } from "@mcode/contracts";

interface PoolEntry {
  pendingTurnId: string | null;
  server: { emit: (event: string, payload: unknown) => void };
  mapper: { prepareForTurn: () => void };
}

/** Spawns a provider session and returns its pool entry once the first turn was sent. */
async function startSession(
  provider: CodexProvider,
  sessionId: string,
  threadId: string,
): Promise<PoolEntry> {
  await provider.sendTurn({
    turnExecutionId: `exec-${sessionId}`,
    sessionId,
    workspaceId: "workspace-test",
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
    interruptChildTurnMock.mockClear();
    loggerWarnMock.mockClear();
  });

  it("assigns the active execution to main tool and text events before turn/start binds", async () => {
    const provider = makeProvider();
    const events: AgentEvent[] = [];
    provider.on("event", (event: AgentEvent) => events.push(event));
    const entry = await startSession(provider, "mcode-early-main", "early-main");
    const state = entry as PoolEntry & {
      currentTurnExecutionId?: string;
      activeParentTurnExecutionId?: string;
      nextTurnExecutionId?: string;
      turnBindingPhase: "idle" | "awaiting" | "bound";
      turnStartResponsePending: boolean;
      currentNativeTurnId?: string;
    };
    entry.mapper.prepareForTurn();
    state.currentTurnExecutionId = "exec-early-main";
    state.activeParentTurnExecutionId = "exec-early-main";
    state.nextTurnExecutionId = "exec-early-main";
    state.turnBindingPhase = "awaiting";
    state.turnStartResponsePending = true;
    state.currentNativeTurnId = undefined;

    entry.server.emit("notification", {
      method: "item/started",
      params: {
        threadId: "sdk-thread-1",
        turnId: "early-native-turn",
        item: { type: "commandExecution", id: "early-tool", command: "echo early" },
      },
    });
    entry.server.emit("notification", {
      method: "item/agentMessage/delta",
      params: { threadId: "sdk-thread-1", turnId: "early-native-turn", delta: "early text" },
    });
    entry.server.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: "sdk-thread-1",
        turn: { id: "early-native-turn", status: "completed", usage: {} },
      },
    });

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: AgentEventType.ToolUse, toolCallId: "early-tool", turnExecutionId: "exec-early-main" }),
      expect.objectContaining({ type: AgentEventType.TextDelta, delta: "early text", turnExecutionId: "exec-early-main" }),
      expect.objectContaining({ type: AgentEventType.TurnComplete, turnExecutionId: "exec-early-main" }),
    ]));
  });

  it("resolves an early main completion after turn/start returns its native id", async () => {
    const provider = makeProvider();
    const events: AgentEvent[] = [];
    provider.on("event", (event: AgentEvent) => events.push(event));
    let resolveNativeTurn!: (turnId: string) => void;
    sendTurnMock.mockImplementationOnce(() => new Promise<string>((resolve) => {
      resolveNativeTurn = resolve;
    }));

    const sessionId = "mcode-early-completion";
    const completion = provider.sendTurn({
      turnExecutionId: "exec-early-completion",
      sessionId,
      workspaceId: "workspace-test",
      threadId: "early-completion",
      message: "hey",
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "auto",
    });

    let entry: PoolEntry | undefined;
    for (let i = 0; i < 20 && !entry; i++) {
      entry = (
        provider as unknown as {
          runtime: { get: (id: string) => PoolEntry | undefined };
        }
      ).runtime.get(sessionId);
      if (!entry) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    expect(entry).toBeDefined();
    for (let i = 0; i < 20 && !resolveNativeTurn; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(resolveNativeTurn).toEqual(expect.any(Function));

    entry!.server.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: "sdk-thread-1",
        turn: { id: "early-native-turn", status: "completed", usage: {} },
      },
    });
    resolveNativeTurn("early-native-turn");

    await expect(completion).resolves.toBeUndefined();
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: AgentEventType.TurnComplete, turnExecutionId: "exec-early-completion" }),
    ]));
  });

  it("settles the root turn by native identity after a child thread id churn", async () => {
    const provider = makeProvider();
    const events: AgentEvent[] = [];
    provider.on("event", (event: AgentEvent) => events.push(event));
    sendTurnMock.mockResolvedValueOnce("root-native-turn");

    const completion = provider.sendTurn({
      turnExecutionId: "exec-root-child-churn",
      sessionId: "mcode-root-child-churn",
      workspaceId: "workspace-test",
      threadId: "root-child-churn",
      message: "delegate and summarize",
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "auto",
    });

    let entry: PoolEntry | undefined;
    for (let i = 0; i < 20 && !entry; i++) {
      entry = (
        provider as unknown as {
          runtime: { get: (id: string) => PoolEntry | undefined };
        }
      ).runtime.get("mcode-root-child-churn");
      if (!entry) await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(entry).toBeDefined();
    for (let i = 0; i < 20 && sendTurnMock.mock.calls.length === 0; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(sendTurnMock).toHaveBeenCalled();

    // A child thread/started notification without parentThreadId can churn the
    // app-server's mutable thread id while the root turn remains in flight.
    (entry!.server as unknown as { threadId: string }).threadId = "child-native-thread";
    entry!.server.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: "child-native-thread",
        turn: { id: "child-native-turn", status: "completed" },
      },
    });
    entry!.server.emit("notification", {
      method: "item/agentMessage/delta",
      params: { threadId: "sdk-thread-1", turnId: "root-native-turn", delta: "root final" },
    });
    entry!.server.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "sdk-thread-1",
        turnId: "root-native-turn",
        item: { type: "agentMessage", id: "root-message" },
      },
    });
    entry!.server.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: "sdk-thread-1",
        turn: { id: "root-native-turn", status: "completed", usage: {} },
      },
    });

    await expect(completion).resolves.toBeUndefined();
    expect(events.filter((event) => event.type === AgentEventType.TurnComplete)).toHaveLength(1);
    expect(events.filter((event) => event.type === AgentEventType.Ended)).toHaveLength(1);
    expect(events.find((event) => event.type === AgentEventType.Message)).toMatchObject({
      content: "root final",
    });
  });

  it("buffers ambiguous child events, replays after native mapping, and stays bounded", async () => {
    const provider = makeProvider();
    const events: AgentEvent[] = [];
    provider.on("event", (event: AgentEvent) => events.push(event));
    const entry = await startSession(provider, "mcode-child-buffer", "child-buffer");
    const state = entry as PoolEntry & {
      currentTurnExecutionId?: string;
      activeParentTurnExecutionId?: string;
      turnBindingPhase: "idle" | "awaiting" | "bound";
      currentNativeTurnId?: string;
      turnExecutionIdsByNativeTurn: Map<string, string>;
      nativeThreadExecutionIds: Map<string, string>;
      childExecutionGenerations: Map<string, { executionId: string; generation: number }>;
      pendingChildEvents: unknown[];
    };
    entry.mapper.prepareForTurn();
    state.currentTurnExecutionId = "exec-child-buffer";
    state.activeParentTurnExecutionId = "exec-child-buffer";
    state.turnBindingPhase = "bound";
    state.currentNativeTurnId = "main-native-turn";
    state.turnExecutionIdsByNativeTurn.set("main-native-turn", "exec-child-buffer");
    state.childExecutionGenerations.set("child-buffered", { executionId: "exec-child-buffer", generation: 1 });
    state.nativeThreadExecutionIds.set("child-buffered", "exec-child-buffer");
    entry.server.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "sdk-thread-1",
        turnId: "main-native-turn",
        item: {
          type: "collabAgentToolCall",
          id: "agent-child",
          tool: "spawnAgent",
          receiverThreadIds: ["child-buffered"],
        },
      },
    });
    entry.server.emit("notification", {
      method: "item/started",
      params: {
        threadId: "child-buffered",
        turnId: "child-native-turn",
        item: { type: "commandExecution", id: "child-tool", command: "echo child" },
      },
    });
    expect(events.find((event) => event.type === AgentEventType.ToolUse && event.toolCallId === "child-tool")).toBeUndefined();

    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "child-buffered", turn: { id: "child-native-turn" } },
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: AgentEventType.ToolUse,
      toolCallId: "child-tool",
      turnExecutionId: "exec-child-buffer",
    }));
    const childToolEvents = events.filter((event) => (
      event.type === AgentEventType.ToolUse && event.toolCallId === "child-tool"
    ));
    expect(childToolEvents).toHaveLength(1);
    entry.server.emit("notification", {
      method: "item/started",
      params: {
        threadId: "child-buffered",
        turnId: "child-native-turn",
        item: { type: "commandExecution", id: "child-tool", command: "echo child" },
      },
    });
    expect(events.filter((event) => (
      event.type === AgentEventType.ToolUse && event.toolCallId === "child-tool"
    ))).toHaveLength(1);

    for (let i = 0; i < 140; i++) {
      entry.server.emit("notification", {
        method: "item/started",
        params: {
          threadId: "child-buffered",
          turnId: `unbound-child-turn-${i}`,
          item: { type: "commandExecution", id: `child-tool-${i}`, command: "echo child" },
        },
      });
    }
    expect(state.pendingChildEvents).toHaveLength(128);
  });

  it("replays mapper and provider child buffers in structural order exactly once", async () => {
    const provider = makeProvider();
    const events: AgentEvent[] = [];
    provider.on("event", (event: AgentEvent) => events.push(event));
    const entry = await startSession(provider, "mcode-child-two-layer-replay", "child-two-layer-replay");
    const state = entry as PoolEntry & {
      currentTurnExecutionId?: string;
      activeParentTurnExecutionId?: string;
      turnBindingPhase: "idle" | "awaiting" | "bound";
      currentNativeTurnId?: string;
      turnExecutionIdsByNativeTurn: Map<string, string>;
      childExecutionGenerations: Map<string, { executionId: string; generation: number }>;
      nativeThreadExecutionIds: Map<string, string>;
      pendingChildEvents: unknown[];
    };
    entry.mapper.prepareForTurn();
    state.currentTurnExecutionId = "exec-mcode-child-two-layer-replay";
    state.activeParentTurnExecutionId = "exec-mcode-child-two-layer-replay";
    state.turnBindingPhase = "bound";
    state.currentNativeTurnId = "main-native-turn";
    state.turnExecutionIdsByNativeTurn.set("main-native-turn", state.currentTurnExecutionId);

    entry.server.emit("notification", {
      method: "item/started",
      params: {
        threadId: "sdk-thread-1",
        turnId: "main-native-turn",
        item: {
          type: "collabAgentToolCall",
          id: "agent-two-layer",
          tool: "spawnAgent",
          receiverThreadIds: ["child-two-layer"],
        },
      },
    });
    state.activeParentTurnExecutionId = undefined;
    entry.server.emit("notification", {
      method: "item/started",
      params: {
        threadId: "child-two-layer",
        item: { type: "commandExecution", id: "child-two-layer-item", command: "echo child" },
      },
    });
    entry.server.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "child-two-layer",
        item: {
          type: "commandExecution",
          id: "child-two-layer-item",
          command: "echo child",
          aggregatedOutput: "child output",
          exitCode: 0,
        },
      },
    });
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "child-two-layer", turn: { id: "child-two-layer-turn" } },
    });
    expect(state.pendingChildEvents).toHaveLength(3);

    state.activeParentTurnExecutionId = state.currentTurnExecutionId;
    entry.server.emit("notification", {
      method: "item/started",
      params: {
        threadId: "sdk-thread-1",
        turnId: "main-native-turn",
        item: {
          type: "subAgentActivity",
          id: "subagent-two-layer",
          kind: "started",
          agentThreadId: "child-two-layer",
          agentPath: "agents/child-two-layer",
        },
      },
    });

    const childEvents = events.filter((event) => (
      "codexChild" in event
      && event.codexChild?.nativeThreadId === "child-two-layer"
    ));
    expect(childEvents.map((event) => event.type)).toEqual([
      AgentEventType.TurnStarted,
      AgentEventType.ToolUse,
      AgentEventType.ToolResult,
    ]);
    expect(childEvents.map((event) => (
      event.type === AgentEventType.ToolUse || event.type === AgentEventType.ToolResult
        ? event.toolCallId
        : event.type
    ))).toEqual([
      AgentEventType.TurnStarted,
      "child-two-layer-item",
      "child-two-layer-item",
    ]);
    expect(childEvents).toHaveLength(3);
    expect(childEvents.every((event) => (
      (event as AgentEvent & { turnExecutionId?: string }).turnExecutionId
        === "exec-mcode-child-two-layer-replay"
    ))).toBe(true);
    const childEventIds = childEvents.map((event) => (
      "codexChild" in event ? event.codexChild?.nativeEventId : undefined
    ));
    expect(childEventIds.every((id): id is string => Boolean(id))).toBe(true);
    expect(new Set(childEventIds).size).toBe(3);

    entry.server.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "child-two-layer",
        item: {
          type: "commandExecution",
          id: "child-two-layer-item",
          command: "echo child",
          aggregatedOutput: "child output",
          exitCode: 0,
        },
      },
    });
    expect(events.filter((event) => (
      "codexChild" in event
      && event.codexChild?.nativeThreadId === "child-two-layer"
    ))).toHaveLength(3);
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
      turnExecutionId: "exec-next",
      sessionId: "mcode-subagent-metadata-race",
      workspaceId: "workspace-test",
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
    sendTurnMock.mockResolvedValueOnce("turn-main");
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
    sendTurnMock.mockResolvedValueOnce("turn-main");
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

  it("attributes reused-session child notifications to the active execution", async () => {
    const provider = makeProvider();
    const events: AgentEvent[] = [];
    provider.on("event", (event: AgentEvent) => events.push(event));
    const entry = await startSession(provider, "mcode-origin-a", "origin-a");
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-a" } },
    });
    entry.server.emit("notification", {
      method: "item/agentMessage/delta",
      params: { threadId: "sdk-thread-1", turnId: "turn-a", delta: "A" },
    });
    await provider.sendTurn({
      turnExecutionId: "exec-b",
      sessionId: "mcode-origin-a",
      workspaceId: "workspace-test",
      threadId: "origin-a",
      message: "next",
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "auto",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    (entry as PoolEntry & { nextTurnExecutionId?: string }).nextTurnExecutionId = "exec-b";
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-b" } },
    });
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "child-b", turn: { id: "child-turn-b" } },
    });
    entry.server.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "child-b",
        turnId: "child-turn-b",
        item: {
          type: "subAgentActivity",
          id: "call-child-b",
          kind: "started",
          agentThreadId: "child-b-nested",
          agentPath: "/root/worker",
        },
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(events.some((event) => event.turnExecutionId === "exec-b")).toBe(true);
  });

  it("keeps known native A mappings immutable after B starts", async () => {
    sendTurnMock.mockResolvedValueOnce("turn-a").mockResolvedValueOnce("turn-b");
    const provider = makeProvider();
    const events: AgentEvent[] = [];
    provider.on("event", (event: AgentEvent) => events.push(event));
    const entry = await startSession(provider, "mcode-origin-immutable", "origin-immutable");

    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-a" } },
    });
    entry.server.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "sdk-thread-1",
        turnId: "turn-a",
        item: {
          type: "subAgentActivity",
          id: "call-child-a",
          kind: "started",
          agentThreadId: "child-a",
        },
      },
    });
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "child-a", turn: { id: "child-turn-a" } },
    });
    entry.server.emit("notification", {
      method: "turn/completed",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-a", status: "completed" } },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    await provider.sendTurn({
      turnExecutionId: "exec-b",
      sessionId: "mcode-origin-immutable",
      workspaceId: "workspace-test",
      threadId: "origin-immutable",
      message: "next",
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
    (entry as PoolEntry & { nextTurnExecutionId?: string }).nextTurnExecutionId = "exec-b";
    await new Promise<void>((resolve) => setImmediate(resolve));

    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-b" } },
    });

    // Replay known A lifecycle ids after B is active. These duplicates must
    // remain attributed to A and never overwrite either native map.
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-a" } },
    });
    entry.server.emit("notification", {
      method: "item/agentMessage/delta",
      params: { threadId: "sdk-thread-1", turnId: "turn-a", delta: "late A" },
    });
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "child-a", turn: { id: "child-turn-a" } },
    });
    entry.server.emit("notification", {
      method: "item/agentMessage/delta",
      params: { threadId: "child-a", turnId: "child-turn-a", delta: "late child A" },
    });
    entry.server.emit("notification", {
      method: "turn/completed",
      params: { threadId: "child-a", turn: { id: "child-turn-a", status: "completed" } },
    });

    expect(entry.pendingTurnId).toBe("turn-b");
    const nativeMaps = entry as PoolEntry & {
      turnExecutionIdsByNativeTurn: Map<string, string>;
      nativeThreadExecutionIds: Map<string, string>;
    };
    expect(nativeMaps.turnExecutionIdsByNativeTurn.get("turn-a")).toBe("exec-mcode-origin-immutable");
    expect(nativeMaps.turnExecutionIdsByNativeTurn.get("child-turn-a")).toBe("exec-mcode-origin-immutable");
    expect(nativeMaps.nativeThreadExecutionIds.get("child-a")).toBe("exec-mcode-origin-immutable");

    entry.server.emit("notification", {
      method: "item/agentMessage/delta",
      params: { threadId: "sdk-thread-1", turnId: "turn-b", delta: "B" },
    });
    entry.server.emit("notification", {
      method: "turn/completed",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-b", status: "completed" } },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const lateA = events.find((event) => event.type === AgentEventType.TextDelta && event.delta === "late A");
    const bText = events.find((event) => event.type === AgentEventType.TextDelta && event.delta === "B");
    expect(lateA?.turnExecutionId).toBe("exec-mcode-origin-immutable");
    expect(bText?.turnExecutionId).toBe("exec-b");
    expect(events.filter((event) => event.type === AgentEventType.Ended).at(-1)?.turnExecutionId).toBe("exec-b");
  });

  it("does not settle B from late A completion before B binds", async () => {
    sendTurnMock.mockResolvedValueOnce("turn-a").mockResolvedValueOnce("turn-b");
    const provider = makeProvider();
    const events: AgentEvent[] = [];
    provider.on("event", (event: AgentEvent) => events.push(event));
    const entry = await startSession(provider, "mcode-late-completion", "late-completion");
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-a" } },
    });

    await provider.sendTurn({
      turnExecutionId: "exec-b",
      sessionId: "mcode-late-completion",
      workspaceId: "workspace-test",
      threadId: "late-completion",
      message: "next",
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "auto",
    });
    for (let i = 0; i < 20 && sendTurnMock.mock.calls.length < 2; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    entry.server.emit("notification", {
      method: "turn/completed",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-a", status: "completed" } },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events.some((event) => event.type === AgentEventType.Ended && event.turnExecutionId === "exec-b")).toBe(false);

    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-b" } },
    });
    entry.server.emit("notification", {
      method: "turn/completed",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-b", status: "completed" } },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events.some((event) => event.type === AgentEventType.Ended && event.turnExecutionId === "exec-b")).toBe(true);
  });

  it("does not rebind an evicted native A turn id from a late start", async () => {
    sendTurnMock.mockResolvedValueOnce("turn-a").mockResolvedValueOnce("turn-b");
    const provider = makeProvider();
    const events: AgentEvent[] = [];
    provider.on("event", (event: AgentEvent) => events.push(event));
    const entry = await startSession(provider, "mcode-evicted-turn", "evicted-turn");
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-a" } },
    });
    await provider.sendTurn({
      turnExecutionId: "exec-b",
      sessionId: "mcode-evicted-turn",
      workspaceId: "workspace-test",
      threadId: "evicted-turn",
      message: "next",
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "auto",
    });
    for (let i = 0; i < 20 && sendTurnMock.mock.calls.length < 2; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-b" } },
    });
    for (let i = 0; i < 129; i++) {
      entry.server.emit("notification", {
        method: "turn/started",
        params: { threadId: `child-${i}`, turn: { id: `child-turn-${i}` } },
      });
    }
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-a" } },
    });
    entry.server.emit("notification", {
      method: "turn/completed",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-a", status: "completed" } },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(events.some((event) => event.type === AgentEventType.Ended && event.turnExecutionId === "exec-b")).toBe(false);
  });

  it("attributes parent notifications without turn ids to active B", async () => {
    sendTurnMock.mockResolvedValueOnce("turn-a").mockResolvedValueOnce("turn-b");
    const provider = makeProvider();
    const events: AgentEvent[] = [];
    provider.on("event", (event: AgentEvent) => events.push(event));
    const entry = await startSession(provider, "mcode-parent-no-turn", "parent-no-turn");
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-a" } },
    });
    await provider.sendTurn({
      turnExecutionId: "exec-b",
      sessionId: "mcode-parent-no-turn",
      workspaceId: "workspace-test",
      threadId: "parent-no-turn",
      message: "next",
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "auto",
    });
    for (let i = 0; i < 20 && sendTurnMock.mock.calls.length < 2; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    (entry as PoolEntry & { nextTurnExecutionId?: string }).nextTurnExecutionId = "exec-b";
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-b" } },
    });
    entry.server.emit("notification", {
      method: "item/agentMessage/delta",
      params: { threadId: "sdk-thread-1", delta: "B no turn id" },
    });
    expect(events.find((event) => event.type === AgentEventType.TextDelta && event.delta === "B no turn id")?.turnExecutionId).toBe("exec-b");
  });

  it("bounds repeated native mapping conflict diagnostics", async () => {
    sendTurnMock.mockResolvedValueOnce("turn-a").mockResolvedValueOnce("turn-b");
    const provider = makeProvider();
    const entry = await startSession(provider, "mcode-conflict-bound", "conflict-bound");
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-a" } },
    });
    await provider.sendTurn({
      turnExecutionId: "exec-b",
      sessionId: "mcode-conflict-bound",
      workspaceId: "workspace-test",
      threadId: "conflict-bound",
      message: "next",
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "auto",
    });
    for (let i = 0; i < 20 && sendTurnMock.mock.calls.length < 2; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    (entry as PoolEntry & { nextTurnExecutionId?: string }).nextTurnExecutionId = "exec-b";
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-b" } },
    });
    for (let i = 0; i < 200; i++) {
      entry.server.emit("notification", {
        method: "turn/started",
        params: { threadId: "sdk-thread-1", turn: { id: "turn-a" } },
      });
    }
    expect(loggerWarnMock.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("fails closed when turn/started precedes a null turn/start response", async () => {
    let resolveTurnStart: ((turnId: string | null) => void) | undefined;
    sendTurnMock.mockImplementationOnce(() => new Promise<string | null>((resolve) => {
      resolveTurnStart = resolve;
    }));
    const provider = makeProvider();
    const events: AgentEvent[] = [];
    provider.on("event", (event: AgentEvent) => events.push(event));
    const entry = await startSession(provider, "mcode-null-before", "null-before");

    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-null-before" } },
    });
    resolveTurnStart?.(null);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events.some((event) => event.type === AgentEventType.Error && event.turnExecutionId === "exec-mcode-null-before")).toBe(true);
    expect(events.some((event) => event.type === AgentEventType.Ended && event.turnExecutionId === "exec-mcode-null-before")).toBe(true);
    expect((entry as PoolEntry & { turnBindingPhase?: string }).turnBindingPhase).toBe("idle");
    entry.server.emit("notification", {
      method: "turn/completed",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-null-before", status: "completed" } },
    });
  });

  it("fails closed when turn/started follows a null turn/start response", async () => {
    sendTurnMock.mockResolvedValueOnce(null);
    const provider = makeProvider();
    const events: AgentEvent[] = [];
    provider.on("event", (event: AgentEvent) => events.push(event));
    const entry = await startSession(provider, "mcode-null-after", "null-after");

    await new Promise<void>((resolve) => setImmediate(resolve));
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-null-after" } },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(events.some((event) => event.type === AgentEventType.Error && event.turnExecutionId === "exec-mcode-null-after")).toBe(true);
    expect(events.some((event) => event.type === AgentEventType.Ended && event.turnExecutionId === "exec-mcode-null-after")).toBe(true);
    expect((entry as PoolEntry & { turnBindingPhase?: string }).turnBindingPhase).toBe("idle");
  });

  it("drops text and tool events for a pruned A turn instead of falling back to B", async () => {
    sendTurnMock.mockResolvedValueOnce("turn-a").mockResolvedValueOnce("turn-b");
    const provider = makeProvider();
    const events: AgentEvent[] = [];
    provider.on("event", (event: AgentEvent) => events.push(event));
    const entry = await startSession(provider, "mcode-pruned-text", "pruned-text");
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-a" } },
    });
    await provider.sendTurn({
      turnExecutionId: "exec-b",
      sessionId: "mcode-pruned-text",
      workspaceId: "workspace-test",
      threadId: "pruned-text",
      message: "next",
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "auto",
    });
    for (let i = 0; i < 20 && sendTurnMock.mock.calls.length < 2; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    (entry as PoolEntry & { nextTurnExecutionId?: string }).nextTurnExecutionId = "exec-b";
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-b" } },
    });
    const maps = entry as PoolEntry & {
      turnExecutionIdsByNativeTurn: Map<string, string>;
      nativeThreadExecutionIds: Map<string, string>;
    };
    for (let i = 0; i < 129; i++) {
      maps.turnExecutionIdsByNativeTurn.set(`filler-${i}`, "exec-b");
    }
    maps.turnExecutionIdsByNativeTurn.delete("turn-a");
    entry.server.emit("notification", {
      method: "item/agentMessage/delta",
      params: { threadId: "sdk-thread-1", turnId: "turn-a", delta: "late pruned A" },
    });
    entry.server.emit("notification", {
      method: "item/started",
      params: {
        threadId: "sdk-thread-1",
        turnId: "turn-a",
        item: { type: "commandExecution", id: "late-pruned-tool", command: "echo stale" },
      },
    });

    const lateText = events.find((event) => event.type === AgentEventType.TextDelta && event.delta === "late pruned A");
    const lateTool = events.find((event) => event.type === AgentEventType.ToolUse && event.toolCallId === "late-pruned-tool");
    expect(lateText?.turnExecutionId).not.toBe("exec-b");
    expect(lateTool?.turnExecutionId).not.toBe("exec-b");
  });

  it("binds first child turn/start to B and preserves reused child A generation", async () => {
    sendTurnMock.mockResolvedValueOnce("turn-a").mockResolvedValueOnce("turn-b");
    const provider = makeProvider();
    const events: AgentEvent[] = [];
    provider.on("event", (event: AgentEvent) => events.push(event));
    const entry = await startSession(provider, "mcode-child-generation", "child-generation");
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-a" } },
    });
    entry.server.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "sdk-thread-1",
        turnId: "turn-a",
        item: { type: "subAgentActivity", id: "call-reused", kind: "started", agentThreadId: "child-reused" },
      },
    });
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "child-reused", turn: { id: "child-turn-a" } },
    });
    await provider.sendTurn({
      turnExecutionId: "exec-b",
      sessionId: "mcode-child-generation",
      workspaceId: "workspace-test",
      threadId: "child-generation",
      message: "next",
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "auto",
    });
    for (let i = 0; i < 20 && sendTurnMock.mock.calls.length < 2; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    (entry as PoolEntry & { nextTurnExecutionId?: string }).nextTurnExecutionId = "exec-b";
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-b" } },
    });
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "child-first", turn: { id: "child-turn-first" } },
    });
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "child-reused", turn: { id: "child-turn-prelink-reused" } },
    });
    const preLinkMaps = entry as PoolEntry & {
      turnExecutionIdsByNativeTurn: Map<string, string>;
    };
    expect(preLinkMaps.turnExecutionIdsByNativeTurn.get("child-turn-first")).toBeUndefined();
    expect(preLinkMaps.turnExecutionIdsByNativeTurn.get("child-turn-prelink-reused")).toBeUndefined();
    entry.server.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "sdk-thread-1",
        turnId: "turn-b",
        item: { type: "subAgentActivity", id: "call-child-new", kind: "started", agentThreadId: "child-new" },
      },
    });
    entry.server.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "sdk-thread-1",
        turnId: "turn-b",
        item: { type: "subAgentActivity", id: "call-reused-b", kind: "started", agentThreadId: "child-reused" },
      },
    });
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "child-new", turn: { id: "child-turn-b" } },
    });
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "child-reused", turn: { id: "child-turn-b-reused" } },
    });
    const maps = entry as PoolEntry & {
      turnExecutionIdsByNativeTurn: Map<string, string>;
      nativeThreadExecutionIds: Map<string, string>;
    };
    expect(maps.nativeThreadExecutionIds.get("child-new")).toBe("exec-b");
    expect(maps.turnExecutionIdsByNativeTurn.get("child-turn-b")).toBe("exec-b");
    expect(maps.turnExecutionIdsByNativeTurn.get("child-turn-a")).toBe("exec-mcode-child-generation");
    expect(maps.nativeThreadExecutionIds.get("child-reused")).toBe("exec-b");
    expect(maps.turnExecutionIdsByNativeTurn.get("child-turn-b-reused")).toBe("exec-b");
    void events;
  });

  it("does not let a late A parent activity replace the active B child generation", async () => {
    sendTurnMock.mockResolvedValueOnce("turn-a").mockResolvedValueOnce("turn-b");
    const provider = makeProvider();
    const events: AgentEvent[] = [];
    provider.on("event", (event: AgentEvent) => events.push(event));
    const entry = await startSession(provider, "mcode-late-parent", "late-parent");
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-a" } },
    });
    entry.server.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "sdk-thread-1",
        turnId: "turn-a",
        item: { type: "subAgentActivity", id: "call-reused-a", kind: "started", agentThreadId: "child-reused" },
      },
    });
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "child-reused", turn: { id: "child-turn-a" } },
    });
    await provider.sendTurn({
      turnExecutionId: "exec-b",
      sessionId: "mcode-late-parent",
      workspaceId: "workspace-test",
      threadId: "late-parent",
      message: "next",
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "auto",
    });
    for (let i = 0; i < 20 && sendTurnMock.mock.calls.length < 2; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    (entry as PoolEntry & { nextTurnExecutionId?: string }).nextTurnExecutionId = "exec-b";
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-b" } },
    });
    entry.server.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "sdk-thread-1",
        turnId: "turn-b",
        item: { type: "subAgentActivity", id: "call-reused-b", kind: "started", agentThreadId: "child-reused" },
      },
    });
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-a" } },
    });
    entry.server.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "sdk-thread-1",
        turnId: "turn-a",
        item: { type: "subAgentActivity", id: "call-reused-a-late", kind: "started", agentThreadId: "child-reused" },
      },
    });
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "child-reused", turn: { id: "child-turn-b" } },
    });
    entry.server.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "child-reused",
        turnId: "child-turn-b",
        item: { type: "imageGeneration", id: "child-b-image", savedPath: "C:/tmp/child-b.png" },
      },
    });
    const maps = entry as PoolEntry & {
      turnExecutionIdsByNativeTurn: Map<string, string>;
      nativeThreadExecutionIds: Map<string, string>;
    };
    expect(maps.nativeThreadExecutionIds.get("child-reused")).toBe("exec-b");
    expect(maps.turnExecutionIdsByNativeTurn.get("child-turn-b")).toBe("exec-b");
    expect(events.find((event) => event.type === AgentEventType.GeneratedAttachment)?.turnExecutionId).toBe("exec-b");
  });

  it("keeps B child attribution after a stale A main turn/started replay", async () => {
    sendTurnMock.mockResolvedValueOnce("turn-a").mockResolvedValueOnce("turn-b");
    const provider = makeProvider();
    const events: AgentEvent[] = [];
    provider.on("event", (event: AgentEvent) => events.push(event));
    const entry = await startSession(provider, "mcode-stale-main", "stale-main");
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-a" } },
    });
    await provider.sendTurn({
      turnExecutionId: "exec-b",
      sessionId: "mcode-stale-main",
      workspaceId: "workspace-test",
      threadId: "stale-main",
      message: "next",
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "auto",
    });
    for (let i = 0; i < 20 && sendTurnMock.mock.calls.length < 2; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    (entry as PoolEntry & { nextTurnExecutionId?: string }).nextTurnExecutionId = "exec-b";
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-b" } },
    });
    entry.server.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "sdk-thread-1",
        turnId: "turn-b",
        item: { type: "subAgentActivity", id: "call-stale-main", kind: "started", agentThreadId: "child-stale-main" },
      },
    });
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-a" } },
    });
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "child-stale-main", turn: { id: "child-turn-b" } },
    });
    entry.server.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "child-stale-main",
        turnId: "child-turn-b",
        item: { type: "imageGeneration", id: "stale-main-b-image", savedPath: "C:/tmp/stale-main-b.png" },
      },
    });
    expect(events.find((event) => event.type === AgentEventType.GeneratedAttachment)?.turnExecutionId).toBe("exec-b");
  });

  it("links a current B parent activity without a turn id to B", async () => {
    sendTurnMock.mockResolvedValueOnce("turn-a").mockResolvedValueOnce("turn-b");
    const provider = makeProvider();
    const entry = await startSession(provider, "mcode-parent-no-turn", "parent-no-turn");
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-a" } },
    });
    await provider.sendTurn({
      turnExecutionId: "exec-b",
      sessionId: "mcode-parent-no-turn",
      workspaceId: "workspace-test",
      threadId: "parent-no-turn",
      message: "next",
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "auto",
    });
    for (let i = 0; i < 20 && sendTurnMock.mock.calls.length < 2; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    (entry as PoolEntry & { nextTurnExecutionId?: string }).nextTurnExecutionId = "exec-b";
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-b" } },
    });
    entry.server.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "sdk-thread-1",
        item: { type: "subAgentActivity", id: "call-no-turn", kind: "started", agentThreadId: "child-no-turn" },
      },
    });
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "child-no-turn", turn: { id: "child-turn-b" } },
    });
    const maps = entry as PoolEntry & {
      turnExecutionIdsByNativeTurn: Map<string, string>;
    };
    expect(maps.turnExecutionIdsByNativeTurn.get("child-turn-b")).toBe("exec-b");
  });

  it("keeps old A child events A while new B child events stay B after late replay", async () => {
    sendTurnMock.mockResolvedValueOnce("turn-a").mockResolvedValueOnce("turn-b");
    const provider = makeProvider();
    const entry = await startSession(provider, "mcode-child-replay-events", "child-replay-events");
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-a" } },
    });
    entry.server.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "sdk-thread-1",
        turnId: "turn-a",
        item: { type: "subAgentActivity", id: "call-replay-a", kind: "started", agentThreadId: "child-replay" },
      },
    });
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "child-replay", turn: { id: "child-turn-a" } },
    });
    await provider.sendTurn({
      turnExecutionId: "exec-b",
      sessionId: "mcode-child-replay-events",
      workspaceId: "workspace-test",
      threadId: "child-replay-events",
      message: "next",
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "auto",
    });
    for (let i = 0; i < 20 && sendTurnMock.mock.calls.length < 2; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    (entry as PoolEntry & { nextTurnExecutionId?: string }).nextTurnExecutionId = "exec-b";
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "sdk-thread-1", turn: { id: "turn-b" } },
    });
    entry.server.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "sdk-thread-1",
        turnId: "turn-b",
        item: { type: "subAgentActivity", id: "call-replay-b", kind: "started", agentThreadId: "child-replay" },
      },
    });
    entry.server.emit("notification", {
      method: "item/completed",
      params: {
        threadId: "sdk-thread-1",
        turnId: "turn-a",
        item: { type: "subAgentActivity", id: "call-replay-a-late", kind: "started", agentThreadId: "child-replay" },
      },
    });
    entry.server.emit("notification", {
      method: "turn/started",
      params: { threadId: "child-replay", turn: { id: "child-turn-b" } },
    });
    const maps = entry as PoolEntry & {
      turnExecutionIdsByNativeTurn: Map<string, string>;
      nativeThreadExecutionIds: Map<string, string>;
    };
    expect(maps.turnExecutionIdsByNativeTurn.get("child-turn-a")).toBe("exec-mcode-child-replay-events");
    expect(maps.turnExecutionIdsByNativeTurn.get("child-turn-b")).toBe("exec-b");
    expect(maps.nativeThreadExecutionIds.get("child-replay")).toBe("exec-b");
  });

  it("interrupts one exact child through the existing runtime session", async () => {
    const provider = makeProvider();
    const entry = await startSession(provider, "mcode-child-stop", "child-stop");

    await provider.interruptChildTurn(
      "mcode-child-stop",
      "native-child-thread",
      "native-child-turn",
    );

    expect(interruptChildTurnMock).toHaveBeenCalledOnce();
    expect(interruptChildTurnMock).toHaveBeenCalledWith(
      "native-child-thread",
      "native-child-turn",
    );
    expect((provider as unknown as {
      runtime: { get: (sessionId: string) => PoolEntry | undefined };
    }).runtime.get("mcode-child-stop")).toBe(entry);
  });
});
