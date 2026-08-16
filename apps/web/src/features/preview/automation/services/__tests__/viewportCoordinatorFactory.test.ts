import { describe, expect, it, vi } from "vitest";
import { createViewportCoordinator } from "../viewportCoordinatorFactory";

describe("viewport coordinator factory", () => {
  it("applies and resets user viewport changes through the Browser surface", async () => {
    let viewport = { width: 960, height: 640 } as { width: number; height: number } | null;
    const setViewport = vi.fn((size: { width: number; height: number }) => {
      viewport = size;
      return true;
    });
    const resetViewport = vi.fn(() => {
      viewport = null;
      return true;
    });
    const coordinator = createViewportCoordinator({
      target: { threadId: "thread-1", tabId: "tab-1" },
      targetGeneration: 5,
      initial: { width: 960, height: 640 },
      surface: {
        setViewport,
        readViewport: () => viewport,
        resetViewport,
      },
    });

    const responsive = await coordinator.requestUserMode("responsive");
    expect(responsive).toMatchObject({ status: "applied", requested: { width: 960, height: 640 } });
    expect(setViewport).toHaveBeenCalledWith(
      { width: 960, height: 640 },
      expect.objectContaining({ source: "user", targetGeneration: 5 }),
      coordinator,
    );

    const regular = await coordinator.requestUserMode("regular");
    expect(regular).toMatchObject({ status: "applied" });
    expect(resetViewport).toHaveBeenCalledWith(
      expect.objectContaining({ source: "user", targetGeneration: 5 }),
      coordinator,
    );
    expect(coordinator.snapshot().mode).toBe("regular");
  });

  it("rejects a viewport result when its Browser surface is no longer current", async () => {
    const coordinator = createViewportCoordinator({
      target: { threadId: "thread-1", tabId: "tab-1" },
      targetGeneration: 2,
      initial: { width: 960, height: 640 },
      surface: {
        setViewport: () => true,
        readViewport: () => ({ width: 800, height: 600 }),
        waitForLayout: async () => undefined,
        isCurrent: () => false,
      },
    });

    const result = await coordinator.requestUserResize({ width: 800, height: 600 });

    expect(result).toMatchObject({
      status: "stale",
      requested: { width: 800, height: 600 },
      applied: { width: 960, height: 640 },
      error: "Browser viewport target is no longer current",
    });
  });

  it("updates Fit and Actual presentation in the Browser surface state", async () => {
    const coordinator = createViewportCoordinator({
      target: { threadId: "thread-1", tabId: "tab-1" },
      targetGeneration: 4,
      initial: { width: 1_280, height: 800 },
    });

    const actualResult = await coordinator.setPresentation("actual");
    expect(actualResult).toMatchObject({ status: "applied", requested: "actual", applied: "actual" });
    expect(coordinator.snapshot().presentation).toBe("actual");

    const fitResult = await coordinator.setPresentation("fit");
    expect(fitResult).toMatchObject({ status: "applied", requested: "fit", applied: "fit" });
  });
});
