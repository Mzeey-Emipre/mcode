import { describe, expect, it } from "vitest";
import {
  MAX_VIEWPORT_CSS_PX,
  MIN_VIEWPORT_CSS_PX,
  ViewportCoordinator,
  type ViewportHostOperation,
  type ViewportHostResult,
} from "./viewportCoordinator";

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
      targetGeneration: 1,
    });

    await coordinator.requestUserResize({ width: 900, height: 650 });
    await coordinator.requestAgentResize({ width: 1_200, height: 800 });
    const restored = await coordinator.completeAgent();

    expect(restored?.applied).toEqual({ width: 900, height: 650 });
    expect(coordinator.snapshot().confirmed).toEqual({ width: 900, height: 650 });
  });

  it("preserves the confirmed state and rejects late agent acknowledgements after interruption", async () => {
    const pending = deferred<ViewportHostResult>();
    const coordinator = new ViewportCoordinator({
      apply: () => pending.promise,
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
  });
});
