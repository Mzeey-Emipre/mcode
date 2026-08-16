import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { AgentService } from "../agent-service.js";
import type { GoalLookupResult, GoalState, IAgentProvider, IGoalCapable } from "@mcode/contracts";

const openGoal: GoalState = {
  threadId: "thread-1",
  objective: "ship lookup",
  status: "active",
  tokenBudget: null,
  tokensUsed: 0,
  timeUsedSeconds: 0,
  createdAt: 1,
  updatedAt: 1,
  providerId: "codex",
  source: "codex",
  controls: { canInspect: true, canClear: true },
};

type AgentServiceGoalHarness = Pick<AgentService, "getThreadGoal" | "clearThreadGoal"> & {
  threadRepo: { findById: ReturnType<typeof vi.fn> };
  providerRegistry: { resolve: ReturnType<typeof vi.fn> };
};

function makeService(opts: {
  thread?: { id: string; provider: string | null };
  provider: Partial<IAgentProvider>;
}): AgentServiceGoalHarness {
  const service = Object.create(AgentService.prototype) as AgentServiceGoalHarness;
  service.threadRepo = {
    findById: vi.fn().mockReturnValue(opts.thread ?? null),
  };
  service.providerRegistry = {
    resolve: vi.fn().mockReturnValue(opts.provider),
  };
  return service;
}

function goalProvider(result: GoalLookupResult): IGoalCapable {
  return {
    id: "codex",
    supportsCompletion: false,
    sessionForkOnResume: "unsupported" as const,
    forker: {} as IGoalCapable["forker"],
    maxInputCharactersPerTurn: 16_000,
    sendTurn: vi.fn(),
    stopSession: vi.fn(),
    shutdown: vi.fn(),
    listModels: vi.fn().mockResolvedValue([]),
    on: vi.fn(),
    setGoal: vi.fn(),
    clearGoal: vi.fn(),
    getGoal: vi.fn(),
    getGoalLookup: vi.fn().mockResolvedValue(result),
  };
}

function clearableProvider(opts: {
  id?: "codex" | "claude";
  clearResult: boolean | Error;
  getResult?: GoalState | undefined;
  getLookupResult?: GoalLookupResult;
}): IGoalCapable {
  const provider = {
    id: opts.id ?? "codex",
    supportsCompletion: false,
    sessionForkOnResume: "unsupported" as const,
    forker: {} as IGoalCapable["forker"],
    maxInputCharactersPerTurn: 16_000,
    sendTurn: vi.fn(),
    stopSession: vi.fn(),
    shutdown: vi.fn(),
    listModels: vi.fn().mockResolvedValue([]),
    on: vi.fn(),
    setGoal: vi.fn(),
    clearGoal: opts.clearResult instanceof Error
      ? vi.fn().mockRejectedValue(opts.clearResult)
      : vi.fn().mockResolvedValue(opts.clearResult),
    getGoal: vi.fn().mockResolvedValue(opts.getResult),
  };
  if (opts.getLookupResult) {
    return {
      ...provider,
      getGoalLookup: vi.fn().mockResolvedValue(opts.getLookupResult),
    };
  }
  return provider;
}

describe("AgentService.getThreadGoal", () => {
  it("rejects unknown thread ids before provider access", async () => {
    const providerRegistry = { resolve: vi.fn() };
    const service = Object.create(AgentService.prototype) as AgentServiceGoalHarness;
    service.threadRepo = { findById: vi.fn().mockReturnValue(null) };
    service.providerRegistry = providerRegistry;

    await expect(service.getThreadGoal("missing")).rejects.toThrow("Thread not found: missing");
    expect(providerRegistry.resolve).not.toHaveBeenCalled();
  });

  it("returns unsupported result for non-goal-capable providers", async () => {
    const service = makeService({
      thread: { id: "thread-1", provider: "copilot" },
      provider: {
        id: "copilot",
        supportsCompletion: false,
        sessionForkOnResume: "unsupported",
        forker: {},
        maxInputCharactersPerTurn: 16_000,
        sendTurn: vi.fn(),
        stopSession: vi.fn(),
        shutdown: vi.fn(),
        listModels: vi.fn(),
        on: vi.fn(),
      } as unknown as IAgentProvider,
    });

    await expect(service.getThreadGoal("thread-1")).resolves.toEqual({
      goal: null,
      authoritative: true,
      source: "unsupported",
      reason: "unsupported-provider",
    });
  });

  it("returns provider lookup metadata for goal-capable providers", async () => {
    const result: GoalLookupResult = {
      goal: openGoal,
      authoritative: false,
      source: "codex-cache",
      reason: "not-materialized",
    };
    const provider = goalProvider(result);
    const service = makeService({
      thread: { id: "thread-1", provider: "codex" },
      provider,
    });

    await expect(service.getThreadGoal("thread-1")).resolves.toEqual(result);
    expect(provider.getGoalLookup).toHaveBeenCalledWith("mcode-thread-1");
  });

  it("normalizes non-open provider goals to null", async () => {
    const service = makeService({
      thread: { id: "thread-1", provider: "codex" },
      provider: goalProvider({
        goal: { ...openGoal, status: "complete" },
        authoritative: true,
        source: "codex-native",
        reason: "closed",
      }),
    });

    await expect(service.getThreadGoal("thread-1")).resolves.toEqual({
      goal: null,
      authoritative: true,
      source: "codex-native",
      reason: "closed",
    });
  });
});

describe("AgentService.clearThreadGoal", () => {
  it("returns unsupported result for non-goal-capable providers", async () => {
    const service = makeService({
      thread: { id: "thread-1", provider: "copilot" },
      provider: {
        id: "copilot",
        supportsCompletion: false,
        sessionForkOnResume: "unsupported",
        forker: {},
        maxInputCharactersPerTurn: 16_000,
        sendTurn: vi.fn(),
        stopSession: vi.fn(),
        shutdown: vi.fn(),
        listModels: vi.fn(),
        on: vi.fn(),
      } as unknown as IAgentProvider,
    });

    await expect(service.clearThreadGoal("thread-1")).resolves.toEqual({
      goal: null,
      authoritative: true,
      source: "unsupported",
      reason: "unsupported-provider",
    });
  });

  it("returns authoritative null when Codex native clear succeeds", async () => {
    const provider = clearableProvider({ id: "codex", clearResult: true });
    const service = makeService({
      thread: { id: "thread-1", provider: "codex" },
      provider,
    });

    await expect(service.clearThreadGoal("thread-1")).resolves.toEqual({
      goal: null,
      authoritative: true,
      source: "codex-native",
    });
    expect(provider.clearGoal).toHaveBeenCalledWith("mcode-thread-1");
    expect(provider.getGoal).not.toHaveBeenCalled();
  });

  it("preserves Codex cache provenance when clear succeeds without native authority", async () => {
    const provider = clearableProvider({
      id: "codex",
      clearResult: true,
      getLookupResult: {
        goal: null,
        authoritative: false,
        source: "codex-cache",
        reason: "not-materialized",
      },
    });
    const service = makeService({
      thread: { id: "thread-1", provider: "codex" },
      provider,
    });

    await expect(service.clearThreadGoal("thread-1")).resolves.toEqual({
      goal: null,
      authoritative: false,
      source: "codex-cache",
      reason: "not-materialized",
    });
    expect(provider.clearGoal).toHaveBeenCalledWith("mcode-thread-1");
    expect(provider.getGoalLookup).toHaveBeenCalledWith("mcode-thread-1");
  });

  it("uses the Claude wrapper source when Claude clear succeeds", async () => {
    const provider = clearableProvider({ id: "claude", clearResult: true });
    const service = makeService({
      thread: { id: "thread-1", provider: "claude" },
      provider,
    });

    await expect(service.clearThreadGoal("thread-1")).resolves.toEqual({
      goal: null,
      authoritative: true,
      source: "claude-wrapper",
    });
  });

  it("reads once after clear false and returns non-authoritative open goal", async () => {
    const provider = clearableProvider({ clearResult: false, getResult: openGoal });
    const service = makeService({
      thread: { id: "thread-1", provider: "codex" },
      provider,
    });

    await expect(service.clearThreadGoal("thread-1")).resolves.toEqual({
      goal: openGoal,
      authoritative: false,
      source: "codex-cache",
      reason: "missing",
    });
    expect(provider.getGoal).toHaveBeenCalledTimes(1);
  });

  it("reads once after clear false and returns non-authoritative cache missing when no goal is open", async () => {
    const provider = clearableProvider({ clearResult: false, getResult: { ...openGoal, status: "complete" } });
    const service = makeService({
      thread: { id: "thread-1", provider: "codex" },
      provider,
    });

    await expect(service.clearThreadGoal("thread-1")).resolves.toEqual({
      goal: null,
      authoritative: false,
      source: "codex-cache",
      reason: "missing",
    });
    expect(provider.getGoal).toHaveBeenCalledTimes(1);
  });

  it("uses lookup provenance after clear false when the provider reports it", async () => {
    const provider = clearableProvider({
      clearResult: false,
      getLookupResult: {
        goal: null,
        authoritative: true,
        source: "codex-native",
        reason: "missing",
      },
    });
    const service = makeService({
      thread: { id: "thread-1", provider: "codex" },
      provider,
    });

    await expect(service.clearThreadGoal("thread-1")).resolves.toEqual({
      goal: null,
      authoritative: true,
      source: "codex-native",
      reason: "missing",
    });
    expect(provider.getGoal).not.toHaveBeenCalled();
    expect(provider.getGoalLookup).toHaveBeenCalledWith("mcode-thread-1");
  });

  it("surfaces provider clear errors without follow-up reads", async () => {
    const provider = clearableProvider({ clearResult: new Error("native clear failed"), getResult: openGoal });
    const service = makeService({
      thread: { id: "thread-1", provider: "codex" },
      provider,
    });

    await expect(service.clearThreadGoal("thread-1")).rejects.toThrow("native clear failed");
    expect(provider.getGoal).not.toHaveBeenCalled();
  });
});
