import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@mcode/shared", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock("../codex-version.js", () => ({
  checkCodexVersion: () => ({ ok: true, version: "0.40.0" }),
  meetsMinVersion: () => true,
}));

const { sendTurnMock } = vi.hoisted(() => ({
  sendTurnMock: vi.fn().mockResolvedValue("turn-main"),
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
    { list: vi.fn(() => []) } as never,
    { persistGeneratedImageFromPath: vi.fn() } as never,
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
