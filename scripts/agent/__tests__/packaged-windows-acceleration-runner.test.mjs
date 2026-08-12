import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildFrameComparison,
  buildProcessSummary,
  parsePackagedWindowsArguments,
  validateAccelerationPair,
} from "../../perf/run-packaged-windows-acceleration.mjs";
import {
  resolveWindowsGpuClassification,
  summarizeWindowsGpuEngineSamples,
} from "../../perf/windows-gpu-engine-collector.mjs";

describe("packaged Windows acceleration runner", () => {
  it("requires an explicit GPU type and bounded equal sample counts", () => {
    assert.deepEqual(
      parsePackagedWindowsArguments([
        "--gpu-type",
        "integrated",
        "--adapter-name",
        "Intel Test GPU",
        "--sample-count",
        "5",
        "--gpu-sample-count",
        "30",
      ]),
      {
        adapterName: "Intel Test GPU",
        gpuSampleCount: 30,
        gpuType: "integrated",
        sampleCount: 5,
      },
    );
    assert.throws(
      () => parsePackagedWindowsArguments([]),
      /--gpu-type must be integrated or discrete/,
    );
    assert.throws(
      () => parsePackagedWindowsArguments(["--gpu-type", "virtual"]),
      /--gpu-type must be integrated or discrete/,
    );
    assert.throws(
      () => parsePackagedWindowsArguments(["--gpu-type", "integrated"]),
      /--adapter-name must identify one Windows video adapter/,
    );
  });

  it("fails closed unless both packaged modes pass with their requested state", () => {
    const makeResult = (mode, overrides = {}) => ({
      accelerationMode: mode,
      buildMode: "production",
      comparisonContract: { sampleCount: 5 },
      correctness: { passed: true },
      devToolsOpen: false,
      deviceIdentity: { hostname: "test-device" },
      frameResults: {
        denseNarrative: {
          frameIntervals: { medianMs: 16, p95Ms: 20 },
        },
      },
      gpuType: "integrated",
      gpuFeatureStatus: {
        gpu_compositing: mode === "default" ? "enabled" : "disabled_software",
      },
      packaged: true,
      sourceRevision: "abc123",
      ...overrides,
    });
    const result = validateAccelerationPair({
      disabled: makeResult("disabled"),
      default: makeResult("default"),
    });
    assert.deepEqual(result, { passed: true, failures: [] });
    assert.deepEqual(
      validateAccelerationPair({
        disabled: makeResult("disabled"),
      }),
      { passed: false, failures: ["default packaged result is missing"] },
    );
    assert.match(
      validateAccelerationPair({
        disabled: makeResult("disabled"),
        default: makeResult("disabled"),
      }).failures.join(" | "),
      /default packaged result has the wrong acceleration mode/,
    );
    assert.match(
      validateAccelerationPair({
        disabled: makeResult("disabled"),
        default: makeResult("default", { packaged: false }),
      }).failures.join(" | "),
      /default result is not a packaged production run/,
    );
  });

  it("keeps frame cadence as the primary paired comparison", () => {
    const results = {
      disabled: {
        frameResults: {
          denseNarrative: { frameIntervals: { medianMs: 16, p95Ms: 22 } },
        },
      },
      default: {
        frameResults: {
          denseNarrative: { frameIntervals: { medianMs: 15, p95Ms: 18 } },
        },
      },
    };
    assert.deepEqual(buildFrameComparison(results), {
      denseNarrative: {
        primaryStatistic: "p95FrameIntervalMs",
        disabled: { medianMs: 16, p95Ms: 22 },
        default: { medianMs: 15, p95Ms: 18 },
      },
    });
  });

  it("reports absent and zero GPU signals as inconclusive", () => {
    assert.deepEqual(summarizeWindowsGpuEngineSamples([], [42]), {
      status: "inconclusive",
      reason: "No attributable GPU Engine counter samples were returned",
      processes: [],
    });
    assert.equal(
      summarizeWindowsGpuEngineSamples([
        { pid: 42, timestamp: "2026-08-12T12:00:00.000Z", valuePercent: 0 },
      ], [42]).status,
      "inconclusive",
    );
    assert.equal(
      summarizeWindowsGpuEngineSamples([
        { pid: 42, timestamp: "2026-08-12T12:00:00.000Z", valuePercent: 7.5 },
      ], [42]).status,
      "active",
    );
  });

  it("binds the operator GPU classification to a Windows adapter", () => {
    assert.deepEqual(
      resolveWindowsGpuClassification(
        [{ name: "Intel Test GPU" }],
        "intel test gpu",
        "integrated",
      ),
      {
        type: "integrated",
        source: "operator-declared-for-matched-windows-adapter",
        adapterName: "Intel Test GPU",
      },
    );
    assert.throws(
      () => resolveWindowsGpuClassification(
        [{ name: "Intel Test GPU" }],
        "Discrete Test GPU",
        "discrete",
      ),
      /Requested adapter was not reported by Windows/,
    );
  });

  it("summarizes CPU and memory independently by Electron process type", () => {
    const sample = (cpuPercent, workingSetSizeKiB, privateBytesKiB) => ({
      correctness: { passed: true },
      attribution: {
        electronProcess: {
          after: {
            processes: [{
              type: "GPU",
              cpuPercent,
              memory: { workingSetSizeKiB, privateBytesKiB },
            }],
          },
        },
      },
    });
    assert.deepEqual(buildProcessSummary({
      metrics: { workload: { rawSamples: [sample(2, 100, 80), sample(4, 120, 90)] } },
    }), {
      GPU: {
        cpuPercent: { sampleCount: 2, min: 2, median: 2, p95: 4, max: 4 },
        workingSetSizeKiB: { sampleCount: 2, min: 100, median: 100, p95: 120, max: 120 },
        privateBytesKiB: { sampleCount: 2, min: 80, median: 80, p95: 90, max: 90 },
      },
    });
  });
});
