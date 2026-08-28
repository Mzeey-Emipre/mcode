import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import type { IAgentProvider } from "@mcode/contracts";
import { logger } from "@mcode/shared";
import { SubagentLifecycleService } from "../../collaboration/subagent-lifecycle-service.js";

type StopTarget = {
  childThread: { providerId: string };
  latestTurn: { status: string } | null;
  nativeThreadId: string | null;
  nativeTurnId: string | null;
};

type ServiceHarness = {
  stop: SubagentLifecycleService["stop"];
  durability: {
    loadSubagentStopTarget: ReturnType<typeof vi.fn>;
    finishSubagentTurn: ReturnType<typeof vi.fn>;
  };
  providers: { resolve: ReturnType<typeof vi.fn> };
  activeStops: Map<string, Promise<unknown>>;
};

function makeTarget(overrides: Partial<StopTarget> = {}): StopTarget {
  return {
    childThread: { providerId: "codex" },
    latestTurn: { status: "Running" },
    nativeThreadId: "native-child-thread",
    nativeTurnId: "native-child-turn",
    ...overrides,
  };
}

function makeHarness(options: {
  target?: StopTarget | null;
  provider?: Partial<IAgentProvider> & {
    descriptor?: { capabilities: Array<{ name: string; support: "supported" | "unsupported" }> };
    interruptChildTurn?: ReturnType<typeof vi.fn>;
    stopSession?: ReturnType<typeof vi.fn>;
  };
} = {}): {
  service: ServiceHarness;
  target: StopTarget | null;
  provider: IAgentProvider & {
    interruptChildTurn: ReturnType<typeof vi.fn>;
    stopSession: ReturnType<typeof vi.fn>;
  };
  finishSubagentTurn: ReturnType<typeof vi.fn>;
} {
  const target = options.target === undefined ? makeTarget() : options.target;
  const provider = {
    id: "codex",
    descriptor: {
      capabilities: [{ name: "child-cancellation", support: "supported" as const }],
    },
    interruptChildTurn: vi.fn().mockResolvedValue(undefined),
    stopSession: vi.fn(),
    ...options.provider,
  } as unknown as IAgentProvider & {
    interruptChildTurn: ReturnType<typeof vi.fn>;
    stopSession: ReturnType<typeof vi.fn>;
  };
  const finishSubagentTurn = vi.fn().mockReturnValue({ status: "Interrupted" });
  const service = Object.create(SubagentLifecycleService.prototype) as ServiceHarness;
  service.durability = {
    loadSubagentStopTarget: vi.fn(() => target),
    finishSubagentTurn,
  };
  service.providers = { resolve: vi.fn(() => provider) };
  service.activeStops = new Map();
  return { service, target, provider, finishSubagentTurn };
}

const request = {
  owningParentThreadId: "parent-thread",
  childThreadId: "child-thread",
};

describe("SubagentLifecycleService.stop", () => {
  it("interrupts the exact native child turn without stopping the provider session", async () => {
    const { service, provider, finishSubagentTurn } = makeHarness();

    await expect(service.stop(request)).resolves.toEqual({
      childThreadId: request.childThreadId,
      status: "interrupted",
    });

    expect(provider.interruptChildTurn).toHaveBeenCalledOnce();
    expect(provider.interruptChildTurn).toHaveBeenCalledWith(
      "mcode-parent-thread",
      "native-child-thread",
      "native-child-turn",
    );
    expect(provider.stopSession).not.toHaveBeenCalled();
    expect(finishSubagentTurn).toHaveBeenCalledWith({
      childThreadId: request.childThreadId,
      nativeTurnId: "native-child-turn",
      outcome: "interrupted",
      error: "Interrupted by user",
    });
  });

  it("rejects an unowned child before provider access", async () => {
    const { service, provider } = makeHarness({ target: null });

    await expect(service.stop(request)).resolves.toMatchObject({
      status: "failed",
    });
    expect(provider.interruptChildTurn).not.toHaveBeenCalled();
    expect(service.providers.resolve).not.toHaveBeenCalled();
  });

  it.each([
    ["not-running", makeTarget({ latestTurn: { status: "Completed" } }), "already-terminal"],
    ["missing native thread identity", makeTarget({ nativeThreadId: null }), "unsupported"],
    ["missing native turn identity", makeTarget({ nativeTurnId: null }), "unsupported"],
  ] as const)("rejects %s without interrupting", async (_case, target, status) => {
    const { service, provider, finishSubagentTurn } = makeHarness({ target });

    await expect(service.stop(request)).resolves.toMatchObject({
      status,
    });
    expect(provider.interruptChildTurn).not.toHaveBeenCalled();
    expect(finishSubagentTurn).not.toHaveBeenCalled();
  });

  it("rejects a provider that lacks declared child cancellation support", async () => {
    const { service, provider } = makeHarness({
      provider: {
        descriptor: { capabilities: [] },
      },
    });

    await expect(service.stop(request)).resolves.toMatchObject({
      status: "unsupported",
    });
    expect(provider.interruptChildTurn).not.toHaveBeenCalled();
  });

  it("leaves a running child untouched when provider interruption fails", async () => {
    const target = makeTarget();
    const providerError = "token=sk-provider-secret path=C:\\private\\provider.log";
    const { service, provider, finishSubagentTurn } = makeHarness({
      target,
      provider: { interruptChildTurn: vi.fn().mockRejectedValue(new Error(providerError)) },
    });

    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    try {
      const result = await service.stop(request);
      expect(result).toEqual({
        childThreadId: request.childThreadId,
        status: "failed",
        message: "Sub-agent interruption failed.",
      });
      expect(JSON.stringify(result)).not.toContain(providerError);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(providerError);
      expect(warn).toHaveBeenCalledWith("Sub-agent interruption failed", {
        category: "provider-interrupt-failed",
        owningParentThreadId: request.owningParentThreadId,
        childThreadId: request.childThreadId,
        providerId: "codex",
      });
      expect(target.latestTurn?.status).toBe("Running");
      expect(finishSubagentTurn).not.toHaveBeenCalled();
      expect(provider.stopSession).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("leaves a running child untouched when interruption completion times out", async () => {
    const target = makeTarget();
    const { service, provider, finishSubagentTurn } = makeHarness({
      target,
      provider: {
        interruptChildTurn: vi.fn().mockRejectedValue(
          new Error("Child interruption timed out waiting for terminal completion."),
        ),
      },
    });

    await expect(service.stop(request)).resolves.toEqual({
      childThreadId: request.childThreadId,
      status: "failed",
      message: "Sub-agent interruption failed.",
    });
    expect(target.latestTurn?.status).toBe("Running");
    expect(finishSubagentTurn).not.toHaveBeenCalled();
    expect(provider.stopSession).not.toHaveBeenCalled();
  });

  it("does not let an unowned first request block an owned stop", async () => {
    const target = makeTarget();
    let acknowledge!: () => void;
    const { service, provider } = makeHarness({
      target,
      provider: {
        interruptChildTurn: vi.fn().mockReturnValue(new Promise<void>((resolve) => {
          acknowledge = resolve;
        })),
      },
    });
    service.durability.loadSubagentStopTarget.mockImplementation((candidate: { owningParentThreadId: string }) => (
      candidate.owningParentThreadId === request.owningParentThreadId ? target : null
    ));

    const unowned = service.stop({ ...request, owningParentThreadId: "wrong-parent" });
    const owned = service.stop(request);

    await expect(unowned).resolves.toMatchObject({ status: "failed" });
    expect(provider.interruptChildTurn).toHaveBeenCalledOnce();
    acknowledge();
    await expect(owned).resolves.toMatchObject({ status: "interrupted" });
  });

  it("does not let a legitimate in-flight stop answer a wrong-parent request", async () => {
    const target = makeTarget();
    let acknowledge!: () => void;
    const { service, provider } = makeHarness({
      target,
      provider: {
        interruptChildTurn: vi.fn().mockReturnValue(new Promise<void>((resolve) => {
          acknowledge = resolve;
        })),
      },
    });
    service.durability.loadSubagentStopTarget.mockImplementation((candidate: { owningParentThreadId: string }) => (
      candidate.owningParentThreadId === request.owningParentThreadId ? target : null
    ));

    const owned = service.stop(request);
    const wrongParent = service.stop({ ...request, owningParentThreadId: "wrong-parent" });

    await expect(wrongParent).resolves.toMatchObject({ status: "failed" });
    expect(provider.interruptChildTurn).toHaveBeenCalledOnce();
    acknowledge();
    await expect(owned).resolves.toMatchObject({ status: "interrupted" });
  });

  it("coalesces duplicate stop requests into one provider interrupt and one terminal write", async () => {
    let acknowledge!: () => void;
    const interruptChildTurn = vi.fn().mockReturnValue(new Promise<void>((resolve) => {
      acknowledge = resolve;
    }));
    const { service, provider, finishSubagentTurn } = makeHarness({
      provider: { interruptChildTurn },
    });

    const first = service.stop(request);
    const duplicate = service.stop(request);
    expect(provider.interruptChildTurn).toHaveBeenCalledOnce();
    acknowledge();

    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      { childThreadId: request.childThreadId, status: "interrupted" },
      { childThreadId: request.childThreadId, status: "interrupted" },
    ]);
    expect(finishSubagentTurn).toHaveBeenCalledOnce();
  });

  it("does not overwrite a completion acknowledged before terminalization", async () => {
    const target = makeTarget();
    const { service, provider, finishSubagentTurn } = makeHarness({ target });
    finishSubagentTurn.mockImplementation(() => {
      target.latestTurn = { status: "Completed" };
      return { status: "Completed" };
    });

    await expect(service.stop(request)).resolves.toEqual({
      childThreadId: request.childThreadId,
      status: "already-terminal",
    });
    await expect(service.stop(request)).resolves.toEqual({
      childThreadId: request.childThreadId,
      status: "already-terminal",
    });
    expect(provider.interruptChildTurn).toHaveBeenCalledOnce();
    expect(finishSubagentTurn).toHaveBeenCalledOnce();
    expect(provider.stopSession).not.toHaveBeenCalled();
  });
});
