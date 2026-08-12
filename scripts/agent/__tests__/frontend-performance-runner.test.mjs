import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { summarizeDurationSamples } from "../../perf/frontend-performance-collectors.mjs";
import {
  FRONTEND_RENDERER_WORKLOADS,
  validateNarrativeRowIsolation,
  validateWorkloadCheck,
} from "../../perf/frontend-renderer-fixture.mjs";
import {
  parsePerformanceMode,
  runFrontendPerformance,
} from "../../perf/run-frontend-performance.mjs";

describe("frontend performance runner", () => {
  it("uses the approved workload order", () => {
    assert.deepEqual(FRONTEND_RENDERER_WORKLOADS, [
      "message100",
      "message1000",
      "threadSwitch",
      "streaming",
      "denseNarrative",
      "markdownShiki",
      "panelTransitions",
    ]);
  });

  it("reports deterministic duration statistics", () => {
    assert.deepEqual(summarizeDurationSamples([4, 1, 3, 2]), {
      sampleCount: 4,
      minMs: 1,
      medianMs: 2,
      p95Ms: 4,
      maxMs: 4,
    });
    assert.equal(summarizeDurationSamples([]), null);
    assert.throws(
      () => summarizeDurationSamples([1, Number.NaN]),
      /finite non-negative numbers/,
    );
  });

  it("rejects wrong visible state for every workload contract", () => {
    assert.deepEqual(validateWorkloadCheck("message100", {
      activeThreadId: "left",
      currentThreadId: "right",
      visibleThreadId: "right",
      mountedMessages: 9,
      totalMessages: 100,
    }), ["selected and visible thread identities differ"]);
    assert.deepEqual(validateWorkloadCheck("streaming", {
      expectedText: "complete response",
      streamingText: "partial response",
    }), ["streamed response text differs"]);
    assert.deepEqual(validateWorkloadCheck("markdownShiki", {
      codeBlocks: 10,
      highlightedBlocks: 9,
    }), ["expected 10 highlighted code blocks"]);
    assert.deepEqual(validateWorkloadCheck("panelTransitions", {
      activeTab: "preview",
      browserTabOpen: true,
      terminalTabOpen: true,
      terminalShell: true,
      visible: true,
    }), ["Terminal is not the active panel"]);
  });

  it("requires at least three samples", async () => {
    const originalArguments = [...process.argv];
    process.argv.push("--sample-count", "2");
    try {
      await assert.rejects(
        runFrontendPerformance(process.cwd()),
        /integer from 3 through 20/,
      );
    } finally {
      process.argv.splice(0, process.argv.length, ...originalArguments);
    }
  });

  it("rejects stable narrative sibling renders", () => {
    assert.deepEqual(validateNarrativeRowIsolation({
      affectedRow: { rowId: "thought-1", renderCount: 1 },
      stableSiblingRows: [{ rowId: "hook-1", renderCount: 1 }],
    }), ["stable narrative row rendered: hook-1"]);
    assert.deepEqual(validateNarrativeRowIsolation({
      affectedRow: { rowId: "thought-1", renderCount: 1 },
      stableSiblingRows: [{ rowId: "hook-1", renderCount: 0 }],
    }), []);
  });

  it("enforces the dense narrative DOM and disclosure contract", () => {
    const accepted = {
      sourceRows: 90,
      descendants: 499,
      browseDescendants: 499,
      browsed: true,
      returnedToSummary: true,
      visible: true,
      assistantVisible: true,
      thoughtVisible: true,
      lastThoughtVisible: true,
      toolVisible: true,
      lastToolVisible: true,
      hookVisible: true,
    };

    assert.deepEqual(validateWorkloadCheck("denseNarrative", accepted), []);
    assert.deepEqual(validateWorkloadCheck("denseNarrative", {
      ...accepted,
      descendants: 500,
    }), ["dense narrative viewport exceeded 499 descendants"]);
  });

  it("accepts only profiling and production modes", () => {
    const originalArguments = [...process.argv];
    try {
      process.argv.push("--mode", "profiling");
      assert.equal(parsePerformanceMode(), "profiling");
      process.argv.splice(0, process.argv.length, ...originalArguments, "--mode", "development");
      assert.throws(parsePerformanceMode, /profiling or production/);
    } finally {
      process.argv.splice(0, process.argv.length, ...originalArguments);
    }
  });
});
