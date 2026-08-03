import { describe, expect, it, vi } from "vitest";
import { createViewportCoordinator } from "./viewportCoordinatorFactory";

describe("viewport coordinator factory", () => {
  it("routes Fit and Actual changes through the native presentation host", async () => {
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

    const actualResult = await coordinator.setPresentation("actual");
    expect(setPresentation).toHaveBeenCalledWith(expect.objectContaining({
      presentation: "actual",
      source: "user",
      targetGeneration: 4,
      threadId: "thread-1",
      tabId: "tab-1",
    }));
    expect(actualResult).toMatchObject({ status: "applied", requested: "actual", applied: "actual" });
    expect(coordinator.snapshot().presentation).toBe("actual");

    const fitResult = await coordinator.setPresentation("fit");
    expect(setPresentation).toHaveBeenLastCalledWith(expect.objectContaining({
      presentation: "fit",
      source: "user",
      targetGeneration: 4,
    }));
    expect(fitResult).toMatchObject({ status: "applied", requested: "fit", applied: "fit" });
  });

  it("reconciles a rejected native presentation without an unhandled rejection", async () => {
    const setPresentation = vi.fn(async () => {
      throw new Error("presentation IPC unavailable");
    });
    const coordinator = createViewportCoordinator({
      target: { threadId: "thread-1", tabId: "tab-1" },
      targetGeneration: 4,
      initial: { width: 1_280, height: 800 },
      nativeHost: () => ({
        setViewport: vi.fn(),
        setPresentation,
      }),
    });

    const result = await coordinator.setPresentation("actual");

    expect(result).toMatchObject({
      status: "failed",
      requested: "actual",
      applied: "fit",
      error: "presentation IPC unavailable",
    });
    expect(coordinator.snapshot()).toMatchObject({
      presentation: "fit",
      pendingPresentation: null,
      presentationError: "presentation IPC unavailable",
    });
  });

  it("rejects a stale or mismatched native acknowledgement without confirming it", async () => {
    const setPresentation = vi.fn(async (payload: {
      readonly operationId: string;
      readonly source: "user" | "agent";
      readonly targetGeneration: number;
    }) => ({
      ok: true as const,
      presentation: "fit" as const,
      appliedViewport: { width: 1_280, height: 800 },
      operationId: `${payload.operationId}-stale`,
      source: payload.source,
      targetGeneration: payload.targetGeneration,
    }));
    const coordinator = createViewportCoordinator({
      target: { threadId: "thread-1", tabId: "tab-1" },
      targetGeneration: 4,
      initial: { width: 1_280, height: 800 },
      nativeHost: () => ({
        setViewport: vi.fn(),
        setPresentation,
      }),
    });

    const result = await coordinator.setPresentation("actual");

    expect(result).toMatchObject({
      status: "stale",
      requested: "actual",
      applied: "fit",
      error: "Browser presentation host acknowledgement is stale",
    });
    expect(coordinator.snapshot()).toMatchObject({
      presentation: "fit",
      pendingPresentation: null,
      presentationError: "Browser presentation host acknowledgement is stale",
    });
  });

  it("routes user-owned Responsive and Regular transitions through the native host", async () => {
    const setViewport = vi.fn(async (payload: {
      readonly widthOverride: number;
      readonly heightOverride: number;
      readonly operationId: string;
      readonly source: "user" | "agent";
      readonly targetGeneration: number;
    }) => ({
      ok: true as const,
      data: { width: payload.widthOverride, height: payload.heightOverride },
      appliedViewport: { width: payload.widthOverride, height: payload.heightOverride },
      operationId: payload.operationId,
      source: payload.source,
      targetGeneration: payload.targetGeneration,
    }));
    const resetViewport = vi.fn(async (payload: {
      readonly operationId: string;
      readonly source: "user" | "agent";
      readonly targetGeneration: number;
    }) => ({
      ok: true as const,
      appliedViewport: null,
      operationId: payload.operationId,
      source: payload.source,
      targetGeneration: payload.targetGeneration,
    }));
    const coordinator = createViewportCoordinator({
      target: { threadId: "thread-1", tabId: "tab-1" },
      targetGeneration: 5,
      initial: { width: 960, height: 640 },
      nativeHost: () => ({
        setViewport,
        setPresentation: vi.fn(),
        resetViewport,
      }),
    });

    const responsive = await coordinator.requestUserMode("responsive");
    expect(responsive).toMatchObject({ status: "applied", requested: { width: 960, height: 640 } });
    expect(setViewport).toHaveBeenCalledWith(expect.objectContaining({
      widthOverride: 960,
      heightOverride: 640,
      source: "user",
      targetGeneration: 5,
      threadId: "thread-1",
      tabId: "tab-1",
    }));

    const regular = await coordinator.requestUserMode("regular");
    expect(regular).toMatchObject({ status: "applied" });
    expect(resetViewport).toHaveBeenCalledWith(expect.objectContaining({
      source: "user",
      targetGeneration: 5,
      threadId: "thread-1",
      tabId: "tab-1",
    }));
    expect(coordinator.snapshot().mode).toBe("regular");
  });
});
