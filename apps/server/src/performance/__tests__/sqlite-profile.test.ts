import { describe, expect, it } from "vitest";
import {
  SQLITE_PROFILE_WORKLOADS,
  compareSQLiteProfileReports,
  parseSQLiteProfileBaseline,
  parseSQLiteProfileCliOptions,
  summarizeSQLiteProfileSamples,
  type SQLiteProfileAggregate,
  type SQLiteProfileReport,
} from "../sqlite-profile";

const distribution = (median: number) => ({
  min: median,
  max: median,
  mean: median,
  median,
  p95: median,
  standardDeviation: 0,
});

function aggregates(value: number): SQLiteProfileAggregate[] {
  return SQLITE_PROFILE_WORKLOADS.map((workload) => ({
    workload,
    samples: 20,
    durationMs: distribution(value),
    returnedBytes: distribution(value),
    rssPeakBytes: distribution(value),
    heapUsedPeakBytes: distribution(value),
    externalPeakBytes: distribution(value),
  }));
}

const runtime: SQLiteProfileReport["runtime"] = {
  platform: "win32",
  architecture: "x64",
  nodeVersion: "v22.0.0",
  electronVersion: "35.0.0",
  sqliteVersion: "3.49.0",
  cpu: "Profile CPU",
};

describe("parseSQLiteProfileCliOptions", () => {
  it("uses enough default samples to expose variance", () => {
    expect(parseSQLiteProfileCliOptions([])).toEqual({
      samples: 20,
      thresholdPercent: 5,
      help: false,
    });
  });

  it("parses explicit comparison options", () => {
    expect(parseSQLiteProfileCliOptions([
      "--samples=9",
      "--baseline",
      "baseline.json",
      "--output=result.json",
      "--threshold-percent",
      "6.5",
    ])).toEqual({
      samples: 9,
      baselinePath: "baseline.json",
      outputPath: "result.json",
      thresholdPercent: 6.5,
      help: false,
    });
  });

  it("rejects a single sample and unknown options", () => {
    expect(() => parseSQLiteProfileCliOptions(["--samples", "1"])).toThrow(
      "--samples must be from 3 to 50",
    );
    expect(() => parseSQLiteProfileCliOptions(["--quick"])).toThrow("Unknown option");
  });
});

describe("compareSQLiteProfileReports", () => {
  it("flags medians above five percent but accepts the boundary", () => {
    const baseline = parseSQLiteProfileBaseline({
      schemaVersion: 1,
      runtime,
      aggregates: aggregates(100),
    });
    const candidateAggregates = aggregates(105);
    candidateAggregates[0]!.durationMs = distribution(105.01);

    const comparison = compareSQLiteProfileReports(
      { runtime, aggregates: candidateAggregates },
      baseline,
      "baseline.json",
    );

    expect(comparison.regressions).toEqual([
      expect.objectContaining({
        workload: "startup-and-migrations",
        metric: "durationMs",
        status: "regression",
      }),
    ]);
    expect(comparison.metrics.find((metric) =>
      metric.workload === "active-turn-writes" && metric.metric === "durationMs"
    )?.status).toBe("pass");
  });

  it("reports runtime mismatches without hiding the comparison", () => {
    const baseline = parseSQLiteProfileBaseline({
      schemaVersion: 1,
      runtime: { ...runtime, nodeVersion: "v20.0.0" },
      aggregates: aggregates(100),
    });

    const comparison = compareSQLiteProfileReports(
      { runtime, aggregates: aggregates(100) },
      baseline,
      "baseline.json",
    );

    expect(comparison.regressions).toHaveLength(0);
    expect(comparison.warnings).toEqual([
      "Runtime mismatch for nodeVersion: baseline=v20.0.0, candidate=v22.0.0.",
    ]);
  });
});

describe("parseSQLiteProfileBaseline", () => {
  it("rejects an incomplete baseline report", () => {
    expect(() => parseSQLiteProfileBaseline({ schemaVersion: 1 })).toThrow();
  });

  it("rejects duplicate workload aggregates", () => {
    const duplicateAggregates = aggregates(100);
    duplicateAggregates[4] = { ...duplicateAggregates[0]! };
    expect(() => parseSQLiteProfileBaseline({
      schemaVersion: 1,
      runtime,
      aggregates: duplicateAggregates,
    })).toThrow("each workload exactly once");
  });
});

describe("summarizeSQLiteProfileSamples", () => {
  it("reports the median, p95, and population standard deviation", () => {
    expect(summarizeSQLiteProfileSamples([1, 2, 3, 4, 100])).toEqual({
      min: 1,
      max: 100,
      mean: 22,
      median: 3,
      p95: 100,
      standardDeviation: Math.sqrt(1522),
    });
  });
});
