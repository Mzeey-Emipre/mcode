import { describe, expect, it, vi } from "vitest";
import { createViewportCoordinator } from "./viewportCoordinatorFactory";

describe("viewport coordinator factory", () => {
  it("routes immediate Fit and Actual changes through the native presentation host", async () => {
    const setPresentation = vi.fn(async (payload: {
      readonly presentation: "fit" | "actual";
      readonly operationId: string;
      readonly source: "user" | "agent";
      readonly targetGeneration: number;
      readonly threadId: string;
      readonly tabId: string;
    }) => ({
      ok: true as const,
      presentation: payload.presentation,
      appliedViewport: { width: 1_280, height: 800 },
      operationId: payload.operationId,
      source: payload.source,
      targetGeneration: payload.targetGeneration,
    }));
    const coordinator = createViewportCoordinator({
      target: { threadId: "thread-1", tabId: "tab-1" },
      targetGeneration: 4,
      initial: { width: 1_280, height: 800 },
      nativeHost: () => ({
        setViewport: vi.fn(async (payload) => ({
          ok: true as const,
          data: { width: payload.widthOverride, height: payload.heightOverride },
          appliedViewport: { width: payload.widthOverride, height: payload.heightOverride },
          operationId: payload.operationId,
          source: payload.source,
          targetGeneration: payload.targetGeneration,
        })),
        setPresentation,
      }),
    });

    coordinator.setPresentation("actual");
    await Promise.resolve();
    expect(setPresentation).toHaveBeenCalledWith(expect.objectContaining({
      presentation: "actual",
      source: "user",
      targetGeneration: 4,
      threadId: "thread-1",
      tabId: "tab-1",
    }));

    coordinator.setPresentation("fit");
    await Promise.resolve();
    expect(setPresentation).toHaveBeenLastCalledWith(expect.objectContaining({
      presentation: "fit",
      source: "user",
      targetGeneration: 4,
    }));
  });
});
