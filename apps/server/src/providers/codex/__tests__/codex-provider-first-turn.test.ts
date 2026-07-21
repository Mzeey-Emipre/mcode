import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { mkdtempSync, rmSync, writeFileSync } from "fs";

vi.mock("@mcode/shared", () => ({
  getMcodeDir: () => process.env.MCODE_DATA_DIR ?? ".",
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock("../codex-version.js", () => ({
  checkCodexVersion: () => ({ ok: true, version: "0.40.0" }),
  meetsMinVersion: () => true,
}));

const { sendTurnMock, appServers } = vi.hoisted(() => ({
  sendTurnMock: vi.fn().mockResolvedValue("turn-test-id"),
  appServers: [] as Array<import("events").EventEmitter & { isAlive: boolean; options: unknown }>,
}));

vi.mock("../codex-app-server.js", async () => {
  const { EventEmitter } = await import("events");
  class MockCodexAppServer extends EventEmitter {
    isAlive = true;
    threadId = "sdk-thread-1";
    resumeFailed = false;
    options: unknown;
    constructor(options: unknown) {
      super();
      this.options = options;
      appServers.push(this);
    }
    async start(): Promise<void> {}
    async sendTurn(input: unknown, turnOptions: unknown): Promise<string> {
      return sendTurnMock(input, turnOptions);
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

function makeProvider(
  catalogService: {
    currentSkills: (cwd?: string) => unknown[];
    currentPrompts: () => unknown[];
    refreshCustomPrompts: () => Promise<{ prompts: unknown[] }>;
    refresh: (cwd?: string) => Promise<{ skills: unknown[] }>;
    onSkillsChanged: (handler: () => void) => () => void;
    shutdown: () => Promise<void>;
  } = {
    currentSkills: vi.fn(() => []),
    currentPrompts: vi.fn(() => []),
    refreshCustomPrompts: vi.fn(async () => ({ prompts: [] })),
    refresh: vi.fn(async () => ({ skills: [] })),
    onSkillsChanged: vi.fn(() => () => undefined),
    shutdown: vi.fn(async () => undefined),
  },
): CodexProvider {
  return new CodexProvider(
    { get: async () => ({ provider: { cli: { codex: "codex" } } }) } as never,
    { assign: vi.fn(), isWindowsJob: false } as never,
    stubEnvService() as never,
    { persistGeneratedImageFromPath: vi.fn() } as never,
    catalogService as never,
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

  it("starts the first turn from cached Skills without waiting for catalog I/O", async () => {
    const nativeSkill = {
      name: "review",
      description: "Review changes",
      kind: "skill" as const,
      source: "project" as const,
      providers: ["codex"],
      nativeName: "review",
      path: "C:/repo/.codex/skills/review/SKILL.md",
    };
    const currentSkills = vi.fn(() => [nativeSkill]);
    const refresh = vi.fn(() => new Promise<{ skills: unknown[] }>(() => undefined));
    const provider = makeProvider({
      currentSkills,
      currentPrompts: vi.fn(() => []),
      refreshCustomPrompts: vi.fn(async () => ({ prompts: [] })),
      refresh,
      onSkillsChanged: vi.fn(() => () => undefined),
      shutdown: vi.fn(async () => undefined),
    });

    await provider.sendTurn({
      sessionId: "mcode-catalog-independent",
      threadId: "catalog-independent",
      message: "hello",
      cwd: "C:/repo",
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "auto",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(sendTurnMock).toHaveBeenCalledTimes(1);
    expect(currentSkills).toHaveBeenCalledWith("C:/repo");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("maps proactive orchestration to Ultra only on supported Codex models", async () => {
    const provider = makeProvider();

    await provider.sendTurn({
      sessionId: "mcode-ultra-sol",
      threadId: "ultra-sol",
      message: "delegate this work",
      cwd: process.cwd(),
      model: "gpt-5.6-sol",
      reasoningLevel: "high",
      interactionMode: "build",
      orchestrationMode: "proactive",
      providerOptions: {},
      permissionMode: "auto",
    });

    for (let i = 0; i < 20 && sendTurnMock.mock.calls.length === 0; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(sendTurnMock.mock.calls[0]?.[1]).toMatchObject({ effort: "ultra" });

    sendTurnMock.mockClear();
    await provider.sendTurn({
      sessionId: "mcode-ultra-luna",
      threadId: "ultra-luna",
      message: "delegate this work",
      cwd: process.cwd(),
      model: "gpt-5.6-luna",
      reasoningLevel: "high",
      interactionMode: "build",
      orchestrationMode: "proactive",
      providerOptions: {},
      permissionMode: "auto",
    });

    for (let i = 0; i < 20 && sendTurnMock.mock.calls.length === 0; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(sendTurnMock.mock.calls[0]?.[1]).toMatchObject({ effort: "high" });
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
    const nativeSkill = {
      name: "browser:control-in-app-browser",
      nativeName: "control-in-app-browser",
      description: "Control browser",
      kind: "skill",
      source: "plugin",
      providers: ["codex"],
      path: skillPath,
    };
    const provider = makeProvider({
      currentSkills: vi.fn(() => [nativeSkill]),
      currentPrompts: vi.fn(() => []),
      refreshCustomPrompts: vi.fn(async () => ({ prompts: [] })),
      refresh: vi.fn(async () => ({ skills: [nativeSkill] })),
      onSkillsChanged: vi.fn(() => () => undefined),
      shutdown: vi.fn(async () => undefined),
    });

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

  it("sends selected file mentions as native Codex mention input", async () => {
    const provider = makeProvider();

    await provider.sendTurn({
      sessionId: "mcode-mentioned-file",
      threadId: "mentioned-file",
      message: "check @src/app.ts",
      mentions: [{
        id: "mention-1",
        kind: "file",
        label: "src/app.ts",
        path: "src/app.ts",
        range: { start: 6, end: 17 },
      }],
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "auto",
    });

    for (let i = 0; i < 20 && sendTurnMock.mock.calls.length === 0; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    expect(sendTurnMock.mock.calls[0][0]).toEqual([
      { type: "mention", name: "src/app.ts", path: "src/app.ts" },
      { type: "text", text: "check @src/app.ts" },
    ]);
  });

  it("sends selected plugin mentions as native Codex mention input", async () => {
    const provider = makeProvider();

    await provider.sendTurn({
      sessionId: "mcode-mentioned-plugin",
      threadId: "mentioned-plugin",
      message: "@Browser inspect the page",
      mentions: [{
        id: "mention-plugin-1",
        kind: "plugin",
        label: "Browser",
        name: "Browser",
        path: "plugin://browser@openai-bundled",
        range: { start: 0, end: 8 },
      }],
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      permissionMode: "auto",
      providerOptions: {},
    });

    for (let i = 0; i < 20 && sendTurnMock.mock.calls.length === 0; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    expect(sendTurnMock.mock.calls[0][0]).toEqual([
      { type: "mention", name: "Browser", path: "plugin://browser@openai-bundled" },
      { type: "text", text: "@Browser inspect the page" },
    ]);
  });

  it("sends selected agent mentions as Codex subagent URI input", async () => {
    const provider = makeProvider();

    await provider.sendTurn({
      sessionId: "mcode-mentioned-agent",
      threadId: "mentioned-agent",
      message: "ask @planner",
      mentions: [{
        id: "mention-agent-1",
        kind: "agent",
        label: "planner",
        name: "planner",
        path: "C:\\Users\\Test\\.codex\\agents\\planner.toml",
        provider: "codex",
        range: { start: 4, end: 12 },
      }],
      cwd: process.cwd(),
      model: "gpt-5.4",
      interactionMode: "build",
      providerOptions: {},
      permissionMode: "auto",
    });

    for (let i = 0; i < 20 && sendTurnMock.mock.calls.length === 0; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    expect(sendTurnMock.mock.calls[0][0]).toEqual([
      { type: "text", text: "ask subagent://planner" },
    ]);
  });

  it("expands Codex prompt commands before turn/start", async () => {
    const promptDir = mkdtempSync(join(tmpdir(), "codex-provider-prompt-"));
    try {
      const promptPath = join(promptDir, "draftpr.md");
      writeFileSync(
        promptPath,
        "---\ndescription: Draft a PR\n---\nDraft a PR for $FILES titled $PR_TITLE. Args: $ARGUMENTS",
      );
      const prompt = {
        name: "prompts:draftpr",
        nativeName: "draftpr",
        description: "Draft a PR",
        kind: "command",
        source: "user",
        providers: ["codex"],
        path: promptPath,
      };
      const refreshCustomPrompts = vi.fn(async () => ({ prompts: [prompt] }));
      const provider = makeProvider({
          currentSkills: vi.fn(() => []),
          currentPrompts: vi.fn(() => []),
          refreshCustomPrompts,
          refresh: vi.fn(async () => ({ skills: [] })),
          onSkillsChanged: vi.fn(() => () => undefined),
          shutdown: vi.fn(async () => undefined),
      });

      await provider.sendTurn({
        sessionId: "mcode-prompt-turn",
        threadId: "prompt-turn",
        message: '/prompts:draftpr FILES="src/a.ts src/b.ts" PR_TITLE="Add files"',
        cwd: process.cwd(),
        model: "gpt-5.4",
        interactionMode: "build",
        providerOptions: {},
        permissionMode: "auto",
      });

      for (let i = 0; i < 20 && sendTurnMock.mock.calls.length === 0; i++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }

      expect(sendTurnMock.mock.calls[0][0]).toEqual([{
        type: "text",
        text: 'Draft a PR for src/a.ts src/b.ts titled Add files. Args: FILES="src/a.ts src/b.ts" PR_TITLE="Add files"',
      }]);
      expect(refreshCustomPrompts).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(promptDir, { recursive: true, force: true });
    }
  });

  it("uses selected catalog identity when a Skill and custom prompt share a name", async () => {
    const promptDir = mkdtempSync(join(tmpdir(), "codex-provider-collision-"));
    try {
      const promptPath = join(promptDir, "release.md");
      const skillPath = join(promptDir, "release-skill", "SKILL.md");
      writeFileSync(promptPath, "Prompt release $ARGUMENTS");
      const prompt = {
        name: "prompts:release",
        nativeName: "release",
        description: "Prompt release",
        kind: "command",
        source: "user",
        providers: ["codex"],
        path: promptPath,
      };
      const skill = {
        name: "prompts:release",
        nativeName: "prompts:release",
        description: "Skill release",
        kind: "skill",
        source: "user",
        providers: ["codex"],
        path: skillPath,
      };
      const provider = makeProvider({
          currentSkills: vi.fn(() => [skill]),
          currentPrompts: vi.fn(() => [prompt]),
          refreshCustomPrompts: vi.fn(async () => ({ prompts: [prompt] })),
          refresh: vi.fn(async () => ({ skills: [skill] })),
          onSkillsChanged: vi.fn(() => () => undefined),
          shutdown: vi.fn(async () => undefined),
      });

      await provider.sendTurn({
        sessionId: "mcode-prompt-collision",
        threadId: "prompt-collision",
        message: "/prompts:release alpha",
        mentions: [{
          id: "command:command:prompts:release",
          kind: "command",
          label: "prompts:release",
          namespace: "command",
          capabilityIdentity: {
            providerId: "codex",
            kind: "customPrompt",
            nativeId: "release",
          },
          range: { start: 0, end: 16 },
        }],
        cwd: process.cwd(),
        model: "gpt-5.4",
        interactionMode: "build",
        providerOptions: {},
        permissionMode: "auto",
      });
      await provider.sendTurn({
        sessionId: "mcode-skill-collision",
        threadId: "skill-collision",
        message: "/prompts:release beta",
        mentions: [{
          id: "command:skill:prompts:release",
          kind: "command",
          label: "prompts:release",
          namespace: "skill",
          capabilityIdentity: {
            providerId: "codex",
            kind: "skill",
            nativeId: skillPath,
          },
          range: { start: 0, end: 16 },
        }],
        cwd: process.cwd(),
        model: "gpt-5.4",
        interactionMode: "build",
        providerOptions: {},
        permissionMode: "auto",
      });

      for (let i = 0; i < 20 && sendTurnMock.mock.calls.length < 2; i++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }

      expect(sendTurnMock.mock.calls[0][0]).toEqual([
        { type: "text", text: "Prompt release alpha" },
      ]);
      expect(sendTurnMock.mock.calls[1][0]).toEqual([
        { type: "skill", name: "prompts:release", path: skillPath },
        { type: "text", text: "$prompts:release beta" },
      ]);
    } finally {
      rmSync(promptDir, { recursive: true, force: true });
    }
  });

  it("emits a controlled error when a listed Codex prompt cannot be read", async () => {
    const promptDir = mkdtempSync(join(tmpdir(), "missing-codex-prompt-"));
    try {
      const prompt = {
        name: "prompts:draftpr",
        nativeName: "draftpr",
        description: "Draft a PR",
        kind: "command",
        source: "user",
        providers: ["codex"],
        path: join(promptDir, "draftpr.md"),
      };
      const provider = makeProvider({
          currentSkills: vi.fn(() => []),
          currentPrompts: vi.fn(() => []),
          refreshCustomPrompts: vi.fn(async () => ({ prompts: [prompt] })),
          refresh: vi.fn(async () => ({ skills: [] })),
          onSkillsChanged: vi.fn(() => () => undefined),
          shutdown: vi.fn(async () => undefined),
      });
      const events: AgentEvent[] = [];
      provider.on("event", (event: AgentEvent) => events.push(event));

      await provider.sendTurn({
        sessionId: "mcode-missing-prompt",
        threadId: "missing-prompt",
        message: "/prompts:draftpr src/a.ts",
        cwd: process.cwd(),
        model: "gpt-5.4",
        interactionMode: "build",
        providerOptions: {},
        permissionMode: "auto",
      });

      expect(sendTurnMock).not.toHaveBeenCalled();
      expect(events).toEqual([
        {
          type: AgentEventType.Error,
          threadId: "missing-prompt",
          error: "Could not load Codex prompt /prompts:draftpr. Refresh commands and try again.",
        },
        { type: AgentEventType.Ended, threadId: "missing-prompt" },
      ]);
    } finally {
      rmSync(promptDir, { recursive: true, force: true });
    }
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
    expect(sideChannelServer.options).toMatchObject({
      sandbox: "read-only",
      approvalPolicy: "on-request",
    });
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
