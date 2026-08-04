import { describe, expect, it } from "vitest";
import {
  evaluateTerminalWorkload,
  getTerminalWorkload,
  listTerminalWorkloads,
  normalizeTerminalWorkloadOutput,
  TERMINAL_WORKLOAD_IDS,
  TERMINAL_WORKLOAD_LIMITS,
  type TerminalWorkloadCapture,
} from "../terminal-workload-corpus.js";

describe("terminal workload corpus", () => {
  it("contains each named failure family in a stable order", () => {
    expect(listTerminalWorkloads().map((workload) => workload.id)).toEqual([...TERMINAL_WORKLOAD_IDS]);
    expect(new Set(listTerminalWorkloads().map((workload) => workload.id)).size).toBe(8);
  });

  it("keeps every fixture within the shared dimensions, resize, and wait bounds", () => {
    for (const workload of listTerminalWorkloads()) {
      expect(workload.initialDimensions.cols).toBeLessThanOrEqual(TERMINAL_WORKLOAD_LIMITS.maxCols);
      expect(workload.initialDimensions.rows).toBeLessThanOrEqual(TERMINAL_WORKLOAD_LIMITS.maxRows);
      const resizeSteps = workload.steps.filter((step) => step.kind === "resize");
      expect(resizeSteps.length).toBeLessThanOrEqual(TERMINAL_WORKLOAD_LIMITS.maxResizeCount);
      for (const step of resizeSteps) {
        if (step.kind !== "resize") continue;
        expect(step.dimensions.cols).toBeGreaterThan(0);
        expect(step.dimensions.cols).toBeLessThanOrEqual(TERMINAL_WORKLOAD_LIMITS.maxCols);
        expect(step.dimensions.rows).toBeGreaterThan(0);
        expect(step.dimensions.rows).toBeLessThanOrEqual(TERMINAL_WORKLOAD_LIMITS.maxRows);
      }
      for (const step of workload.steps) {
        if (step.kind === "wait") {
          expect(step.durationMs).toBeGreaterThanOrEqual(0);
          expect(step.durationMs).toBeLessThanOrEqual(TERMINAL_WORKLOAD_LIMITS.maxDurationMs);
        }
      }
    }
  });

  it("keeps declared resize counts and synchronization markers aligned with each plan", () => {
    for (const workload of listTerminalWorkloads()) {
      const resizeCount = workload.steps.filter((step) => step.kind === "resize").length;
      expect(workload.expectedResizeCount).toBe(resizeCount);
      expect(workload.synchronizationMarker.length).toBeGreaterThan(0);
      expect(workload.expectedMarkers).toContain(workload.synchronizationMarker);
    }
    expect(getTerminalWorkload("shaky-live-resizing").expectedResizeCount).toBe(6);
  });

  it("normalizes platform line endings and volatile child IDs for renderer comparison", () => {
    expect(normalizeTerminalWorkloadOutput("a\r\nb\rWF:cleanup:child:1234\n")).toBe(
      "a\nb\nWF:cleanup:child:<pid>\n",
    );
  });

  it("evaluates complete captures and reports the facts later tickets need", () => {
    const workload = getTerminalWorkload("reconnect-recovery");
    const capture: TerminalWorkloadCapture = {
      output: "WF:reconnect:before\nWF:reconnect:after\n",
      outputBytes: 40,
      outputTruncated: false,
      detachedOutputBytes: 21,
      resizeTrace: [{ kind: "initial", cols: 80, rows: 24, elapsedMs: 0 }],
      durationMs: 120,
      synchronizationObserved: true,
      exitObserved: true,
      exitCode: 0,
      childPids: [],
      childPidsAliveAfterKill: [],
      childPidsAliveAfterCleanup: [],
      cleanupDurationMs: 0,
    };

    const result = evaluateTerminalWorkload(workload, capture);

    expect(result.passed).toBe(true);
    expect(result.missingMarkers).toEqual([]);
    expect(result.detachedOutputBytes).toBe(21);
    expect(result.normalizedOutputSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.facts).toEqual(expect.arrayContaining([
      expect.stringContaining("post-gap marker"),
      expect.stringContaining("40 bytes"),
    ]));
  });

  it("fails a capture that exceeds the byte budget or leaves a child alive", () => {
    const workload = getTerminalWorkload("process-cleanup");
    const capture: TerminalWorkloadCapture = {
      output: "WF:cleanup:parent\nWF:cleanup:child:42\n",
      outputBytes: TERMINAL_WORKLOAD_LIMITS.maxOutputBytes + 1,
      outputTruncated: true,
      detachedOutputBytes: 0,
      resizeTrace: [{ kind: "initial", cols: 80, rows: 24, elapsedMs: 0 }],
      durationMs: 50,
      synchronizationObserved: true,
      exitObserved: true,
      exitCode: null,
      childPids: [42],
      childPidsAliveAfterKill: [42],
      childPidsAliveAfterCleanup: [],
      cleanupDurationMs: 0,
    };

    const result = evaluateTerminalWorkload(workload, capture);

    expect(result.passed).toBe(false);
    expect(result.failedChecks).toEqual(expect.arrayContaining([
      "output exceeded the bounded capture",
      "child processes remained alive after PTY termination",
    ]));
  });

  it("fails a capture when its synchronization marker was not observed", () => {
    const workload = getTerminalWorkload("high-output-pressure");
    const result = evaluateTerminalWorkload(workload, {
      output: "WF:high-output:begin\nWF:high-output:chunk:0\nWF:high-output:end\n",
      outputBytes: 64,
      outputTruncated: false,
      detachedOutputBytes: 0,
      resizeTrace: [{ kind: "initial", cols: 80, rows: 24, elapsedMs: 0 }],
      durationMs: 100,
      synchronizationObserved: false,
      exitObserved: true,
      exitCode: 0,
      childPids: [],
      childPidsAliveAfterKill: [],
      childPidsAliveAfterCleanup: [],
      cleanupDurationMs: 0,
    });

    expect(result.failedChecks).toContain(
      "synchronization marker was not observed before workload steps",
    );
  });
});
