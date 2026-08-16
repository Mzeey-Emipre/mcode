import { describe, expect, it } from "vitest";
import {
  MAX_VIEWPORT_CSS_PX,
  MIN_VIEWPORT_CSS_PX,
  ViewportCoordinator,
  type ViewportHostOperation,
  type ViewportHostResetOperation,
  type ViewportHostResult,
} from "../viewportCoordinator";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

describe("ViewportCoordinator", () => {
  it("clamps user requests at the CSS viewport boundary", async () => {
    const operations: ViewportHostOperation[] = [];
    const coordinator = new ViewportCoordinator({
      apply: async (operation) => {
        operations.push(operation);
        return { status: "applied", applied: operation.requested };
      },
      initial: { width: 800, height: 600 },
      targetGeneration: 4,
    });

    const result = await coordinator.requestUserResize({ width: 1, height: 9_000 });

    expect(operations[0]?.requested).toEqual({
      width: MIN_VIEWPORT_CSS_PX,
      height: MAX_VIEWPORT_CSS_PX,
    });
    expect(result.status).toBe("clamped");
    expect(result.applied).toEqual({
      width: MIN_VIEWPORT_CSS_PX,
      height: MAX_VIEWPORT_CSS_PX,
    });
    expect(coordinator.snapshot().confirmed).toEqual(result.applied);
  });

  it("returns the confirmed viewport when an older operation resolves late", async () => {
    const first = deferred<ViewportHostResult>();
    const operations: ViewportHostOperation[] = [];
    const coordinator = new ViewportCoordinator({
      apply: (operation) => {
        operations.push(operation);
        return operations.length === 1
          ? first.promise
          : Promise.resolve({ status: "applied", applied: operation.requested });
      },
      initial: { width: 800, height: 600 },
      targetGeneration: 7,
    });

    const older = coordinator.requestAgentResize({ width: 1_000, height: 700 });
    const newer = coordinator.requestAgentResize({ width: 1_200, height: 800 });
    const newerResult = await newer;
    first.resolve({ status: "applied", applied: operations[0]!.requested });
    const olderResult = await older;

    expect(newerResult.status).toBe("applied");
    expect(olderResult.status).toBe("superseded");
    expect(olderResult.applied).toEqual(newerResult.applied);
    expect(coordinator.snapshot().confirmed).toEqual({ width: 1_200, height: 800 });
  });

  it("restores the latest confirmed user viewport after agent completion", async () => {
    const coordinator = new ViewportCoordinator({
      apply: async (operation) => ({ status: "applied", applied: operation.requested }),
      initial: { width: 800, height: 600 },
      mode: "responsive",
      targetGeneration: 1,
    });

    await coordinator.requestUserResize({ width: 900, height: 650 });
    await coordinator.requestAgentResize({ width: 1_200, height: 800 });
    const restored = await coordinator.completeAgent();

    expect(restored?.applied).toEqual({ width: 900, height: 650 });
    expect(coordinator.snapshot().confirmed).toEqual({ width: 900, height: 650 });
  });

  it("keeps agent control active while a user resize updates the restore point", async () => {
    const coordinator = new ViewportCoordinator({
      apply: async (operation) => ({ status: "applied", applied: operation.requested }),
      initial: { width: 800, height: 600 },
      targetGeneration: 1,
    });

    await coordinator.requestUserResize({ width: 900, height: 650 });
    await coordinator.requestAgentResize({ width: 1_200, height: 800 });
    await coordinator.requestUserResize({ width: 1_000, height: 700 });

    expect(coordinator.snapshot().agentActive).toBe(true);
    expect(coordinator.snapshot().userConfirmed).toEqual({ width: 1_000, height: 700 });
    await coordinator.requestAgentResize({ width: 1_400, height: 900 });
    const restored = await coordinator.completeAgent();

    expect(restored?.applied).toEqual({ width: 1_000, height: 700 });
    expect(coordinator.snapshot().agentActive).toBe(false);
    expect(coordinator.snapshot().confirmed).toEqual({ width: 1_000, height: 700 });
  });

  it("restores the latest user-selected mode after agent completion", async () => {
    const coordinator = new ViewportCoordinator({
      apply: async (operation) => ({ status: "applied", applied: operation.requested }),
      reset: async () => ({ status: "applied", applied: null }),
      initial: { width: 800, height: 600 },
      targetGeneration: 1,
    });

    await coordinator.requestAgentResize({ width: 1_200, height: 800 });
    coordinator.setUserMode("regular");

    expect(coordinator.snapshot().agentActive).toBe(true);
    expect(coordinator.snapshot().mode).toBe("responsive");
    await coordinator.completeAgent();
    expect(coordinator.snapshot().mode).toBe("regular");
  });

  it("resets the host when an agent completes without a user-owned responsive mode", async () => {
    const resets: ViewportHostResetOperation[] = [];
    const coordinator = new ViewportCoordinator({
      apply: async (operation) => ({ status: "applied", applied: operation.requested }),
      reset: async (operation) => {
        resets.push(operation);
        return { status: "applied", applied: null };
      },
      initial: { width: 960, height: 640 },
      targetGeneration: 1,
    });

    await coordinator.requestAgentResize({ width: 1_200, height: 800 });
    const result = await coordinator.completeAgent();

    expect(resets).toHaveLength(1);
    expect(resets[0]?.requested).toEqual({ width: 960, height: 640 });
    expect(result).toMatchObject({ status: "applied", applied: { width: 1_200, height: 800 } });
    expect(coordinator.snapshot()).toMatchObject({
      mode: "regular",
      confirmed: { width: 1_200, height: 800 },
      agentActive: false,
    });
  });

  it("does not supersede an active agent resize when Responsive is already active", async () => {
    const operations: ViewportHostOperation[] = [];
    const resets: ViewportHostResetOperation[] = [];
    const coordinator = new ViewportCoordinator({
      apply: async (operation) => {
        operations.push(operation);
        return { status: "applied", applied: operation.requested };
      },
      reset: async (operation) => {
        resets.push(operation);
        return { status: "applied", applied: null };
      },
      initial: { width: 960, height: 640 },
      targetGeneration: 1,
    });

    await coordinator.requestAgentResize({ width: 1_200, height: 800 });
    const result = await coordinator.requestUserMode("responsive");

    expect(result).toBeNull();
    expect(operations).toHaveLength(1);
    expect(coordinator.snapshot().agentActive).toBe(true);
    await coordinator.completeAgent();
    expect(resets).toHaveLength(1);
  });

  it("reports an unavailable reset host instead of claiming Regular mode was applied", async () => {
    const coordinator = new ViewportCoordinator({
      apply: async (operation) => ({ status: "applied", applied: operation.requested }),
      initial: { width: 960, height: 640 },
      targetGeneration: 1,
    });

    const result = await coordinator.requestUserMode("regular");

    expect(result).toMatchObject({
      status: "failed",
      error: "Viewport reset host is unavailable",
    });
  });

  it("keeps Responsive mode when the host rejects a Regular reset", async () => {
    const coordinator = new ViewportCoordinator({
      apply: async (operation) => ({ status: "applied", applied: operation.requested }),
      reset: async () => ({ status: "failed", applied: { width: 960, height: 640 } }),
      initial: { width: 960, height: 640 },
      mode: "responsive",
      targetGeneration: 1,
    });

    const result = await coordinator.requestUserMode("regular");

    expect(result).toMatchObject({ status: "failed", applied: { width: 960, height: 640 } });
    expect(coordinator.snapshot().mode).toBe("responsive");
  });

  it("preserves the confirmed state and rejects late agent acknowledgements after interruption", async () => {
    const pending = deferred<ViewportHostResult>();
    const operations: ViewportHostOperation[] = [];
    const coordinator = new ViewportCoordinator({
      apply: (hostOperation) => {
        operations.push(hostOperation);
        return operations.length === 1
          ? pending.promise
          : Promise.resolve({ status: "applied", applied: hostOperation.requested });
      },
      initial: { width: 800, height: 600 },
      targetGeneration: 2,
    });

    const operation = coordinator.requestAgentResize({ width: 1_200, height: 800 });
    coordinator.interrupt();
    pending.resolve({ status: "applied", applied: { width: 1_200, height: 800 } });

    const result = await operation;
    expect(result.status).toBe("stale");
    expect(result.applied).toEqual({ width: 800, height: 600 });
    expect(coordinator.snapshot().confirmed).toEqual({ width: 800, height: 600 });
    expect(operations).toHaveLength(2);
    expect(operations[1]).toMatchObject({
      source: "user",
      targetGeneration: 2,
      requested: { width: 800, height: 600 },
    });
    expect(operations[1]!.operationGeneration).toBeGreaterThan(operations[0]!.operationGeneration);
  });

  it("keeps presentation scale separate from CSS viewport dimensions", () => {
    const coordinator = new ViewportCoordinator({
      apply: async (operation) => ({ status: "applied", applied: operation.requested }),
      initial: { width: 1_200, height: 800 },
      targetGeneration: 1,
    });

    coordinator.setPresentation("actual");
    expect(coordinator.snapshot().presentation).toBe("actual");
    expect(coordinator.getPresentationScale({ width: 600, height: 400 })).toBe(1);
    coordinator.setPresentation("fit");
    expect(coordinator.getPresentationScale({ width: 600, height: 400 })).toBe(0.5);
    coordinator.setPresentation("150%");
    expect(coordinator.snapshot().presentation).toBe("150%");
    expect(coordinator.getPresentationScale({ width: 600, height: 400 })).toBe(1.5);
  });
});
