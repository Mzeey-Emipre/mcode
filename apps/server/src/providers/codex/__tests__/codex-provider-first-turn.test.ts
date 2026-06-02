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
  sendTurnMock: vi.fn().mockResolvedValue("turn-test-id"),
}));

vi.mock("../codex-app-server.js", async () => {
  const { EventEmitter } = await import("events");
  class MockCodexAppServer extends EventEmitter {
    isAlive = true;
    threadId = "sdk-thread-1";
    resumeFailed = false;
    async start(): Promise<void> {}
    async sendTurn(): Promise<string> {
      return sendTurnMock();
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

/**
 * Regression: the first turn on a new Codex session must reach `turn/start`.
 * SessionRuntime registers pool state after `spawn` resolves; scheduling the
 * first turn on queueMicrotask ran before that and skipped runTurn entirely.
 */
describe("CodexProvider first turn on new session", () => {
  const threadId = "first-turn-thread";
  const sessionId = `mcode-${threadId}`;

  beforeEach(() => {
    sendTurnMock.mockClear();
  });

  it("sent turn/start after spawn when the runtime pool registers on the next tick", async () => {
    const provider = new CodexProvider(
      { get: async () => ({ provider: { cli: { codex: "codex" } } }) } as never,
      { assign: vi.fn(), isWindowsJob: false } as never,
      stubEnvService() as never,
    );

    const ended = new Promise<void>((resolve) => {
      provider.on("event", (e: AgentEvent) => {
        if (e.type === AgentEventType.Ended && e.threadId === threadId) resolve();
      });
    });

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

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(sendTurnMock).toHaveBeenCalledTimes(1);

    const pool = (
      provider as unknown as {
        runtime: { get: (id: string) => { server: { emit: (e: string, n: unknown) => void } } | undefined };
      }
    ).runtime;
    const state = pool.get(sessionId);
    expect(state).toBeDefined();
    state!.server.emit("notification", {
      method: "turn/completed",
      params: { turn: { id: "turn-test-id", status: "completed" } },
    });

    await ended;
  });

  it("did not overwrite pendingTurnId when a superseding runTurn finished sendTurn first", async () => {
    const supersedeThreadId = "supersede-turn-thread";
    const supersedeSessionId = `mcode-${supersedeThreadId}`;

    let resolveSend!: (id: string) => void;
    const sendTurnDeferred = new Promise<string>((resolve) => {
      resolveSend = resolve;
    });
    sendTurnMock.mockImplementationOnce(() => sendTurnDeferred);

    const provider = new CodexProvider(
      { get: async () => ({ provider: { cli: { codex: "codex" } } }) } as never,
      { assign: vi.fn(), isWindowsJob: false } as never,
      stubEnvService() as never,
    );

    void provider.sendTurn({
      sessionId: supersedeSessionId,
      threadId: supersedeThreadId,
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
        runtime: {
          get: (id: string) => { runTurnSeq: number; pendingTurnId: string | null } | undefined;
        };
      }
    ).runtime;
    const entry = pool.get(supersedeSessionId);
    expect(entry).toBeDefined();
    const staleSeq = entry!.runTurnSeq;
    entry!.runTurnSeq += 1;
    entry!.pendingTurnId = "superseding-turn";

    resolveSend("stale-turn-id");
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(staleSeq).toBeLessThan(entry!.runTurnSeq);
    expect(entry!.pendingTurnId).toBe("superseding-turn");
  });
});
