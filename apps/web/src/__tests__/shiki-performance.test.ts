import { afterEach, describe, expect, it, vi } from "vitest";
import { calculateWorkerDeliveryDuration } from "../performance/shiki-performance";

describe("Shiki performance timing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses absolute worker and renderer clocks for delivery", () => {
    expect(calculateWorkerDeliveryDuration(2_000, 113, 1_000, 112)).toBe(1_001);
  });

  it("rejects a negative absolute-clock interval", () => {
    expect(calculateWorkerDeliveryDuration(1_000, 111, 2_000, 112)).toBeNull();
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
      workerPostTimeMs: 10,
      workerTimeOriginMs: performance.timeOrigin,
    }, 11);

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
});
