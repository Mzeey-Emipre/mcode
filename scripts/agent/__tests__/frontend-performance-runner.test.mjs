import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  summarizeDurationSamples,
  summarizeTrace,
} from "../../perf/frontend-performance-collectors.mjs";
import {
  FRONTEND_RENDERER_WORKLOADS,
  normalizeClipboardText,
  summarizeShikiStages,
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

  it("classifies Chromium style and layout trace events without overlap", () => {
    assert.deepEqual(summarizeTrace([
      { ph: "X", name: "RecalculateStyles", dur: 500 },
      { ph: "X", name: "UpdateLayoutTree", dur: 1_000 },
      { ph: "X", name: "Layout", dur: 2_000 },
    ]), {
      paintMs: null,
      styleMs: 1.5,
      layoutMs: 2,
      traceEventCount: 3,
    });
  });

  it("aggregates Shiki block stages before comparing workload samples", () => {
    const sample = ({ codeToHtml, responseBytes, workerDelivery, htmlInsertion, layout }) => ({
      durationMs: 200,
      attribution: {
        shiki: [
          ...codeToHtml.map((durationMs) => ({ stage: "codeToHtml", durationMs })),
          ...responseBytes.map((value) => ({ stage: "responseBytes", value })),
          ...workerDelivery.map((durationMs) => ({ stage: "workerDelivery", durationMs })),
          ...htmlInsertion.map((durationMs) => ({ stage: "htmlInsertion", durationMs })),
        ],
        chromium: { styleMs: 10, layoutMs: layout, longTasksMs: [] },
      },
    });
    const summary = summarizeShikiStages([
      sample({ codeToHtml: [20, 30], responseBytes: [100, 200], workerDelivery: [1, 2], htmlInsertion: [100, 100], layout: 40 }),
      sample({ codeToHtml: [10, 15], responseBytes: [50, 75], workerDelivery: [2, 3], htmlInsertion: [90, 90], layout: 30 }),
      sample({ codeToHtml: [30, 20], responseBytes: [125, 125], workerDelivery: [3, 4], htmlInsertion: [80, 80], layout: 45 }),
    ]);

    assert.equal(summary.stages.codeToHtml.medianMs, 50);
    assert.equal(summary.stages.responseBytes.medianBytes, 250);
    assert.equal(summary.stages.workerDelivery.medianMs, 5);
    assert.equal(summary.stages.htmlInsertion.medianMs, 180);
    assert.equal(summary.largestStage, "codeToHtml");
  });

  it("normalizes clipboard line endings without changing content", () => {
    assert.equal(
      normalizeClipboardText("const x = 1;\r\nconst y = 2;\rconst z = 3;"),
      "const x = 1;\nconst y = 2;\nconst z = 3;",
    );
    assert.notEqual(
      normalizeClipboardText("const x = 1;\r\nconst y = 2;"),
      "const x = 1;\nconst z = 3;",
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
    }), [
      "expected 10 highlighted code blocks",
      "plain fallback is missing",
      "plain fallback was not visible while highlighting was pending",
      "highlighted theme is missing",
      "copy controls are missing",
      "copy action failed",
      "horizontal scrolling is missing",
      "code selection failed",
      "code accessibility semantics are missing",
    ]);
    assert.deepEqual(validateWorkloadCheck("markdownShiki", {
      codeBlocks: 10,
      highlightedBlocks: 10,
      plainFallbackBlocks: 10,
      plainFallbackVisibleWhilePending: 10,
      themedBlocks: 10,
      copyButtons: 10,
      copyWorked: true,
      scrollableBlocks: 10,
      selectionWorks: true,
      accessibleBlocks: 10,
    }), []);
    assert.deepEqual(validateWorkloadCheck("markdownShiki", {
      codeBlocks: 10,
      highlightedBlocks: 10,
      plainFallbackBlocks: 10,
      plainFallbackVisibleWhilePending: 10,
      themedBlocks: 10,
      copyButtons: 10,
      copyWorked: false,
      scrollableBlocks: 10,
      selectionWorks: true,
      accessibleBlocks: 10,
    }), ["copy action failed"]);
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
