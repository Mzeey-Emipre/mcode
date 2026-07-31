import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";

const { loggerWarnMock } = vi.hoisted(() => ({ loggerWarnMock: vi.fn() }));

vi.mock("@mcode/shared", () => ({
  logger: { warn: loggerWarnMock, info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock("../codex-version.js", () => ({
  checkCodexVersion: () => ({ ok: true, version: "0.40.0" }),
  meetsMinVersion: () => true,
}));

const { sendTurnMock, getChildThreadMetadataMock } = vi.hoisted(() => ({
  sendTurnMock: vi.fn().mockResolvedValue(null),
  getChildThreadMetadataMock: vi.fn().mockResolvedValue({ model: "gpt-5.6-sol", reasoningEffort: "medium" }),
}));

vi.mock("../codex-app-server.js", async () => {
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
    loggerWarnMock.mockClear();
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
});
