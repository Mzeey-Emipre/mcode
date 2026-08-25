import { afterEach, describe, expect, it, vi } from "vitest";
import {
  calculateWorkerDeliveryDuration,
} from "../performance/shiki-performance";
import { MAX_SHIKI_PERFORMANCE_EPOCH_MS } from "../performance/shiki-performance-contract";

describe("Shiki performance timing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the worker post and renderer receipt wall-clock boundary for delivery", () => {
    expect(calculateWorkerDeliveryDuration(1_800_000_000_005, 1_800_000_000_000)).toBe(5);
  });

  it("rejects malformed, future-bounded, and negative delivery timestamps", () => {
    expect(calculateWorkerDeliveryDuration(Number.NaN, 1_800_000_000_000)).toBeNull();
    expect(calculateWorkerDeliveryDuration(MAX_SHIKI_PERFORMANCE_EPOCH_MS + 1, 1_800_000_000_000)).toBeNull();
    expect(calculateWorkerDeliveryDuration(1_800_000_000_000, 1_800_000_000_001)).toBeNull();
  });

  it("records zero insertion when Profiler duration exceeds wall-clock commit time", async () => {
    vi.stubEnv("VITE_MCODE_PERFORMANCE_MODE", "profiling");
    vi.resetModules();
    const performanceModule = await import("../performance/shiki-performance");
    performanceModule.setShikiPerformanceCapture(true);
    performanceModule.startShikiMeasurement("request-1", 10);
    performanceModule.recordShikiWorkerTiming("request-1", {
      phase: "cold",
      workerStartupMs: 1,
      highlighterCreationMs: 2,
      grammarLoadMs: 3,
      codeToHtmlMs: 4,
      responseBytes: 42,
      workerPostedAtEpochMs: Date.now(),
    }, 11, Date.now() + 1);

    performanceModule.recordShikiRendererCompletion("request-1", 20, 10, 15);

    const rendererObservations = performanceModule
      .drainShikiPerformanceObservations()
      .filter(({ stage }) => ["reactCommit", "htmlInsertion", "totalCompletion"].includes(stage));
    expect(rendererObservations).toEqual([
      { phase: "cold", stage: "reactCommit", durationMs: 20 },
      { phase: "cold", stage: "htmlInsertion", durationMs: 0 },
      { phase: "cold", stage: "totalCompletion", durationMs: 5 },
    ]);
  });

  it("rejects malformed worker delivery timestamps at the worker boundary", async () => {
    vi.stubEnv("VITE_MCODE_PERFORMANCE_MODE", "profiling");
    vi.resetModules();
    const performanceModule = await import("../performance/shiki-performance");
    performanceModule.setShikiPerformanceCapture(true);
    performanceModule.startShikiMeasurement("request-1", 10);

    expect(performanceModule.recordShikiWorkerTiming("request-1", {
      phase: "cold",
      workerStartupMs: 1,
      highlighterCreationMs: 2,
      grammarLoadMs: 3,
      codeToHtmlMs: 4,
      responseBytes: 42,
      workerPostedAtEpochMs: Number.NaN,
    }, 11, Date.now())).toBe(false);
  });
});
