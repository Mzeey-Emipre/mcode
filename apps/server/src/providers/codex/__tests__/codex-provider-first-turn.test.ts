import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { homedir } from "os";
import { join } from "path";

vi.mock("@mcode/shared", () => ({
  getMcodeDir: () => process.env.MCODE_DATA_DIR ?? ".",
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock("../codex-version.js", () => ({
  checkCodexVersion: () => ({ ok: true, version: "0.40.0" }),
  meetsMinVersion: () => true,
}));

const { sendTurnMock, listSkillsMock, appServers } = vi.hoisted(() => ({
  sendTurnMock: vi.fn().mockResolvedValue("turn-test-id"),
  listSkillsMock: vi.fn().mockResolvedValue({ data: [] }),
  appServers: [] as Array<import("events").EventEmitter & { isAlive: boolean }>,
}));

vi.mock("../codex-app-server.js", async () => {
  const { EventEmitter } = await import("events");
  class MockCodexAppServer extends EventEmitter {
    isAlive = true;
    threadId = "sdk-thread-1";
    resumeFailed = false;
    constructor() {
      super();
      appServers.push(this);
    }
    async start(): Promise<void> {}
    async sendTurn(input: unknown, turnOptions: unknown): Promise<string> {
      return sendTurnMock(input, turnOptions);
    }
    async listSkills(cwds: string[] | undefined): Promise<unknown> {
      return listSkillsMock(cwds);
    }
    async interruptTurn(): Promise<void> {}
    async kill(): Promise<void> {
      this.isAlive = false;
    }
  }
  return { CodexAppServer: MockCodexAppServer };
});

import { CodexProvider } from "../codex-provider.js";
import { AgentEventType } from "@mcode/contracts";
import type { AgentEvent } from "@mcode/contracts";
import { stubEnvService } from "../../../__tests__/stub-env-service.js";

function makeProvider(skillList: (...args: unknown[]) => unknown[] = vi.fn(() => [])): CodexProvider {
  return new CodexProvider(
    { get: async () => ({ provider: { cli: { codex: "codex" } } }) } as never,
    { assign: vi.fn(), isWindowsJob: false } as never,
    stubEnvService() as never,
    { list: skillList } as never,
    { persistGeneratedImageFromPath: vi.fn() } as never,
  );
}

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
    listSkillsMock.mockReset();
    listSkillsMock.mockResolvedValue({ data: [] });
    appServers.length = 0;
  });

  it("sent turn/start after spawn when the runtime pool registers on the next tick", async () => {
    const provider = makeProvider();

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

    const provider = makeProvider();

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

  it("sends Codex native skill input for slash skill invocations", async () => {
    const skillPath = "C:\\Users\\Test\\.codex\\plugins\\cache\\openai-bundled\\browser\\1.0.0\\skills\\control-in-app-browser\\SKILL.md";
    const provider = makeProvider(vi.fn(() => [{
      name: "browser:control-in-app-browser",
      nativeName: "control-in-app-browser",
      description: "Control browser",
      kind: "skill",
      source: "plugin",
      providers: ["codex"],
      path: skillPath,
    }]));

    await provider.sendTurn({
      sessionId: "mcode-skill-turn",
      threadId: "skill-turn",
      message: "/browser:control-in-app-browser inspect localhost",
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "auto",
    });

    for (let i = 0; i < 20 && sendTurnMock.mock.calls.length === 0; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    expect(sendTurnMock).toHaveBeenCalledWith([
      { type: "skill", name: "control-in-app-browser", path: skillPath },
      { type: "text", text: "$control-in-app-browser inspect localhost" },
    ], expect.anything());
  });

  it("leaves unknown slash commands unchanged", async () => {
    const provider = makeProvider();

    await provider.sendTurn({
      sessionId: "mcode-unknown-slash",
      threadId: "unknown-slash",
      message: "/goal clear",
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "auto",
    });

    for (let i = 0; i < 20 && sendTurnMock.mock.calls.length === 0; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    expect(sendTurnMock.mock.calls[0][0]).toEqual([{ type: "text", text: "/goal clear" }]);
  });

  it("lists enabled native Codex skills from a live app-server session", async () => {
    const cwd = process.cwd();
    const skillPath = join(
      homedir(),
      ".codex",
      "plugins",
      "cache",
      "openai-bundled",
      "browser",
      "1.0.0",
      "skills",
      "control-in-app-browser",
      "SKILL.md",
    );
    listSkillsMock.mockResolvedValueOnce({
      data: [{
        cwd,
        errors: [],
        skills: [
          {
            name: "control-in-app-browser",
            description: "Long browser description",
            shortDescription: "Short browser description",
            enabled: true,
            path: skillPath,
            scope: "system",
            interface: null,
          },
          {
            name: "disabled",
            description: "Hidden",
            enabled: false,
            path: join(cwd, ".codex", "skills", "disabled", "SKILL.md"),
            scope: "repo",
          },
        ],
      }],
    });
    const provider = makeProvider();

    await provider.sendTurn({
      sessionId: "mcode-native-skills",
      threadId: "native-skills",
      message: "hello",
      cwd,
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "auto",
    });

    const skills = await provider.listSkills(cwd);

    expect(listSkillsMock).toHaveBeenCalledWith([cwd]);
    expect(skills).toEqual([{
      name: "control-in-app-browser",
      description: "Short browser description",
      kind: "skill",
      source: "plugin",
      providers: ["codex"],
      nativeName: "control-in-app-browser",
      path: skillPath,
    }]);
  });

  it("runs side-channel handoff turns at low effort", async () => {
    const provider = makeProvider();

    const result = provider.runSideChannelQuery({
      parentThreadId: "parent-thread",
      parentSdkSessionId: "sdk-thread-1",
      prompt: "Generate the handoff.",
      cwd: process.cwd(),
    });

    for (let i = 0; i < 20 && sendTurnMock.mock.calls.length === 0; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    expect(sendTurnMock).toHaveBeenCalledWith(
      [{ type: "text", text: "Generate the handoff." }],
      { effort: "low" },
    );

    expect(appServers[0]).toBeDefined();
    const sideChannelServer = appServers[0]!;
    sideChannelServer.emit("notification", {
      method: "item/agentMessage/delta",
      params: { delta: "# Handoff" },
    });
    sideChannelServer.emit("notification", {
      method: "turn/completed",
      params: { turn: { status: "completed" } },
    });

    await expect(result).resolves.toBe("# Handoff");
  });
});
