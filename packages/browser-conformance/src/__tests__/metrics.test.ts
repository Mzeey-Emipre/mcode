import { describe, expect, it } from "vitest";
import {
  BROWSER_CONFORMANCE_MAX_TIMING_SAMPLES,
  BROWSER_CONFORMANCE_TIMING_PHASES,
  BrowserConformanceTimingMetrics,
} from "../metrics.js";

describe("Browser conformance timing metrics", () => {
  it("reports nearest-rank p50, p95, and p99 for each explicitly measured phase", () => {
    const metrics = new BrowserConformanceTimingMetrics();
    metrics.record({ phase: "mcode", durationMs: 30 });
    metrics.record({ phase: "mcode", durationMs: 10 });
    metrics.record({ phase: "mcode", durationMs: 20 });
    metrics.record({ phase: "network", durationMs: 7 });

    expect(metrics.report()).toEqual({
      mcode: { samples: 3, p50Ms: 20, p95Ms: 30, p99Ms: 30 },
      application: { samples: 0, p50Ms: null, p95Ms: null, p99Ms: null },
      network: { samples: 1, p50Ms: 7, p95Ms: 7, p99Ms: 7 },
      wait: { samples: 0, p50Ms: null, p95Ms: null, p99Ms: null },
      model: { samples: 0, p50Ms: null, p95Ms: null, p99Ms: null },
    });
  });

  it("retains a bounded recent window and rejects invalid samples", () => {
    const metrics = new BrowserConformanceTimingMetrics({ maxSamplesPerPhase: 2 });
    metrics.record({ phase: "mcode", durationMs: 1 });
    metrics.record({ phase: "mcode", durationMs: 2 });
    metrics.record({ phase: "mcode", durationMs: 3 });

    expect(metrics.report().mcode).toEqual({ samples: 2, p50Ms: 2, p95Ms: 3, p99Ms: 3 });
    expect(() => metrics.record({ phase: "mcode", durationMs: -1 })).toThrow(RangeError);
    expect(() => metrics.record({ phase: "mcode", durationMs: Number.POSITIVE_INFINITY })).toThrow(RangeError);
    expect(() => new BrowserConformanceTimingMetrics({ maxSamplesPerPhase: BROWSER_CONFORMANCE_MAX_TIMING_SAMPLES + 1 }))
      .toThrow(RangeError);
  });

  it("does not retain page or provider content", () => {
    const metrics = new BrowserConformanceTimingMetrics();
    for (const phase of BROWSER_CONFORMANCE_TIMING_PHASES) metrics.record({ phase, durationMs: 5 });
    expect(JSON.stringify(metrics.report())).not.toMatch(/url|token|secret|thread|credential/i);
  });
});
