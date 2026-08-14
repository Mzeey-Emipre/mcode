import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_CHROMIUM_TRACE_EVENTS,
  summarizeChromiumTrace,
  summarizeDurationSamples,
} from "../../perf/frontend-performance-collectors.mjs";
import {
  aggregateShikiStageAttribution,
  extractShikiLongTasks,
  FRONTEND_RENDERER_WORKLOADS,
  getShikiTraceOptions,
  validateRendererBudgetSample,
  SHIKI_STAGE_NAMES,
  validateNarrativeRowIsolation,
  validateWorkloadCheck,
} from "../../perf/frontend-renderer-fixture.mjs";
import {
  getWorkerEnvironment,
  getWorkerExecutable,
  parsePerformanceMode,
  parsePerformanceOptions,
  runFrontendPerformance,
} from "../../perf/run-frontend-performance.mjs";

const completeShikiObservations = [
  { phase: "cold", stage: "workerStartup", durationMs: 2 },
  { phase: "cold", stage: "highlighterCreation", durationMs: 4 },
  { phase: "cold", stage: "grammarLoad", durationMs: 6 },
  { phase: "cold", stage: "codeToHtml", durationMs: 18 },
  { phase: "cold", stage: "responseBytes", bytes: 512 },
  { phase: "cold", stage: "workerDelivery", durationMs: 3 },
  { phase: "cold", stage: "reactCommit", durationMs: 5 },
  { phase: "cold", stage: "htmlInsertion", durationMs: 7 },
  { phase: "workload", stage: "style", durationMs: 8 },
  { phase: "workload", stage: "layout", durationMs: 9 },
  { phase: "cold", stage: "totalCompletion", durationMs: 22 },
  { phase: "warm", stage: "highlighterCreation", durationMs: 4 },
  { phase: "warm", stage: "grammarLoad", durationMs: 6 },
  { phase: "warm", stage: "codeToHtml", durationMs: 51 },
  { phase: "warm", stage: "responseBytes", bytes: 512 },
  { phase: "warm", stage: "workerDelivery", durationMs: 3 },
  { phase: "warm", stage: "reactCommit", durationMs: 5 },
  { phase: "warm", stage: "htmlInsertion", durationMs: 7 },
  { phase: "warm", stage: "totalCompletion", durationMs: 61 },
];
const productionShikiObservations = completeShikiObservations.filter(
  ({ stage }) => !["reactCommit", "htmlInsertion", "totalCompletion"].includes(stage),
);

describe("frontend performance runner", () => {
  it("enforces renderer budgets at the per-sample correctness seam", () => {
    const validAttribution = {
      gpu: null,
      chromium: {
        longTaskObserverAvailable: true,
        longTasksMs: [50],
        layoutEvents: [
          { startTimeMs: 0, durationMs: 1.1 },
          { startTimeMs: 16.7, durationMs: 1.2 },
        ],
        traceEventCount: 2,
      },
    };

    assert.deepEqual(
      validateRendererBudgetSample(
        "message100",
        { viewportDescendants: 499 },
        validAttribution,
        "production",
      ),
      [],
    );
    assert.deepEqual(
      validateRendererBudgetSample(
        "message100",
        { viewportDescendants: 500 },
        validAttribution,
        "production",
      ),
      ["message100 viewport descendants: observed 500; budget <= 499"],
    );
    assert.deepEqual(
      validateRendererBudgetSample(
        "message100",
        {},
        { gpu: null, chromium: null },
        "profiling",
      ),
      ["message100 viewport descendants: observed unavailable; budget <= 499"],
    );
    assert.deepEqual(
      validateRendererBudgetSample(
        "message100",
        { viewportDescendants: 499 },
        {
          ...validAttribution,
          chromium: {
            ...validAttribution.chromium,
            longTasksMs: [50.1],
          },
        },
        "production",
      ),
      ["message100 main-thread task duration: observed 50.1 ms; budget <= 50 ms"],
    );
    assert.deepEqual(
      validateRendererBudgetSample(
        "message100",
        { viewportDescendants: 499 },
        { gpu: null, chromium: null },
        "production",
      ),
      ["message100 Chromium trace: observed unavailable; budget production trace data required"],
    );
    assert.deepEqual(
      validateRendererBudgetSample(
        "message100",
        { viewportDescendants: 499 },
        {
          gpu: null,
          chromium: {
            longTaskObserverAvailable: false,
            longTasksMs: [],
            layoutEvents: [],
            traceEventCount: 1,
            layoutEventCount: 0,
            traceEventsTruncated: false,
            malformedLayoutEventCount: 0,
          },
        },
        "production",
      ),
      ["message100 main-thread task trace: observed unavailable; budget finite task durations with a long-task observer"],
    );
    assert.deepEqual(
      validateRendererBudgetSample(
        "message100",
        { viewportDescendants: 499 },
        {
          ...validAttribution,
          chromium: {
            ...validAttribution.chromium,
            layoutEvents: [
              { startTimeMs: 0, durationMs: 1.1 },
              { startTimeMs: 5, durationMs: 1.2 },
              { startTimeMs: 20, durationMs: 1.3 },
            ],
          },
        },
        "production",
      ),
      [
        "message100 slow layout count: observed 3; budget <= 2",
        "message100 slow layout start gap: observed 5 ms; budget >= 16.7 ms",
        "message100 slow layout start gap: observed 15 ms; budget >= 16.7 ms",
      ],
    );
    assert.deepEqual(
      validateRendererBudgetSample(
        "message100",
        { viewportDescendants: 499 },
        { gpu: null, chromium: null },
        "profiling",
      ),
      [],
    );
    assert.deepEqual(
      validateRendererBudgetSample(
        "message100",
        { viewportDescendants: 500 },
        { gpu: null, chromium: null },
        "profiling",
      ),
      ["message100 viewport descendants: observed 500; budget <= 499"],
    );
  });

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

  it("converts bounded Layout trace events for the slow-layout gate", () => {
    const summary = summarizeChromiumTrace([
      { ph: "X", name: "Layout", ts: 100_000, dur: 1_000 },
      { ph: "X", name: "Layout", ts: 116_700, dur: 1_100 },
      { ph: "X", name: "Layout", ts: 121_700, dur: 1_200 },
    ]);
    assert.deepEqual(summary.layoutEvents, [
      { startTimeMs: 100, durationMs: 1 },
      { startTimeMs: 116.7, durationMs: 1.1 },
      { startTimeMs: 121.7, durationMs: 1.2 },
    ]);
    assert.equal(summary.malformedLayoutEventCount, 0);
    assert.deepEqual(
      validateRendererBudgetSample(
        "message100",
        { viewportDescendants: 499 },
        {
          gpu: null,
          chromium: {
            ...summary,
            longTaskObserverAvailable: true,
            longTasksMs: [],
          },
        },
        "production",
      ),
      ["message100 slow layout start gap: observed 5 ms; budget >= 16.7 ms"],
    );

    const malformed = summarizeChromiumTrace([
      null,
      { ph: "X", name: "Layout", ts: "missing", dur: 1_000 },
    ]);
    assert.equal(malformed.malformedTraceEventCount, 2);
    assert.equal(malformed.malformedLayoutEventCount, 1);
    assert.equal(summarizeChromiumTrace([
      { ph: "X", name: "Layout", ts: 100_000, dur: -1_000 },
    ]).layoutMs, null);
    assert.deepEqual(
      validateRendererBudgetSample(
        "message100",
        { viewportDescendants: 499 },
        {
          gpu: null,
          chromium: {
            ...malformed,
            longTaskObserverAvailable: true,
            longTasksMs: [],
          },
        },
        "production",
      ),
      ["message100 layout trace: observed 2 malformed events; budget individual layout start and duration data"],
    );
    const oversized = Array.from({ length: MAX_CHROMIUM_TRACE_EVENTS + 1 }, () => ({
      ph: "M",
      name: "Metadata",
    }));
    assert.throws(
      () => summarizeChromiumTrace(oversized),
      /cannot exceed 10000 retained events/,
    );
    assert.throws(
      () => summarizeChromiumTrace([], { totalEventCount: -1 }),
      /bounded non-negative count/,
    );
    assert.throws(
      () => summarizeChromiumTrace([], { malformedTraceEventCount: -1 }),
      /must be non-negative/,
    );
    const truncated = summarizeChromiumTrace(
      oversized.slice(0, MAX_CHROMIUM_TRACE_EVENTS),
      {
        totalEventCount: oversized.length,
        traceEventsTruncated: true,
      },
    );
    assert.equal(truncated.retainedTraceEventCount, MAX_CHROMIUM_TRACE_EVENTS);
    assert.equal(truncated.traceEventCount, MAX_CHROMIUM_TRACE_EVENTS + 1);
    assert.equal(
      truncated.traceEventsTruncated,
      true,
    );
    assert.deepEqual(
      validateRendererBudgetSample(
        "message100",
        { viewportDescendants: 499 },
        {
          gpu: null,
          chromium: {
            ...truncated,
            longTaskObserverAvailable: true,
            longTasksMs: [],
          },
        },
        "production",
      ),
      ["message100 layout trace: observed 10001 events (truncated); budget individual layout start and duration data"],
    );
  });

  it("covers valid and invalid visible state for every workload contract", () => {
    const markdownValid = {
      codeBlocks: 10,
      highlightedBlocks: 10,
      plainFallbackObserved: true,
      themeClassAndStyle: true,
      copyButtonsAccessible: true,
      semanticCodeBlocks: true,
      highlightedContent: true,
      horizontalOverflow: true,
      textSelection: true,
      shikiAttribution: completeShikiObservations,
    };
    const contracts = [
      {
        workload: "message100",
        valid: {
          activeThreadId: "thread-100",
          currentThreadId: "thread-100",
          visibleThreadId: "thread-100",
          mountedMessages: 1,
          totalMessages: 100,
        },
        invalid: { visibleThreadId: "other-thread" },
        failure: "selected and visible thread identities differ",
      },
      {
        workload: "message1000",
        valid: {
          activeThreadId: "thread-1000",
          currentThreadId: "thread-1000",
          visibleThreadId: "thread-1000",
          mountedMessages: 1,
          totalMessages: 1_000,
        },
        invalid: { totalMessages: 999 },
        failure: "expected 1000 messages",
      },
      {
        workload: "threadSwitch",
        valid: {
          activeThreadId: "thread-right",
          currentThreadId: "thread-right",
          visibleThreadId: "thread-right",
        },
        invalid: { visibleThreadId: "thread-left" },
        failure: "resident thread switch selected the wrong thread",
      },
      {
        workload: "streaming",
        valid: { expectedText: "complete response", streamingText: "complete response" },
        invalid: { streamingText: "partial response" },
        failure: "streamed response text differs",
      },
      {
        workload: "denseNarrative",
        valid: {
          sourceRows: 90,
          browsed: true,
          returnedToSummary: true,
          visible: true,
          assistantVisible: true,
          thoughtVisible: true,
          lastThoughtVisible: true,
          toolVisible: true,
          lastToolVisible: true,
          hookVisible: true,
        },
        invalid: { sourceRows: 89 },
        failure: "dense narrative fixture row count differs",
      },
      {
        workload: "markdownShiki",
        valid: markdownValid,
        invalid: { highlightedBlocks: 9 },
        failure: "expected 10 highlighted code blocks",
      },
      {
        workload: "panelTransitions",
        valid: {
          activeTab: "terminal",
          browserTabOpen: true,
          terminalTabOpen: true,
          terminalShell: true,
          visible: true,
        },
        invalid: { activeTab: "preview" },
        failure: "Terminal is not the active panel",
      },
    ];

    assert.deepEqual(
      contracts.map(({ workload }) => workload),
      FRONTEND_RENDERER_WORKLOADS,
    );
    for (const contract of contracts) {
      assert.deepEqual(
        validateWorkloadCheck(contract.workload, contract.valid),
        [],
        `${contract.workload} valid check`,
      );
      assert.ok(
        validateWorkloadCheck(contract.workload, {
          ...contract.valid,
          ...contract.invalid,
        }).includes(contract.failure),
        `${contract.workload} invalid boundary`,
      );
    }
    assert.deepEqual(validateWorkloadCheck("markdownShiki", {
      ...markdownValid,
      buildMode: "production",
      shikiAttribution: productionShikiObservations,
      shikiLongTasksOver50Ms: [],
    }, "production"), []);
  });

  it("aggregates known Shiki stages by cold and warm phase", () => {
    assert.deepEqual(SHIKI_STAGE_NAMES, [
      "workerStartup",
      "highlighterCreation",
      "grammarLoad",
      "codeToHtml",
      "responseBytes",
      "workerDelivery",
      "reactCommit",
      "htmlInsertion",
      "style",
      "layout",
      "totalCompletion",
    ]);
    const result = aggregateShikiStageAttribution(completeShikiObservations);
    assert.equal(result.stages.cold.codeToHtml.medianMs, 18);
    assert.equal(result.stages.warm.codeToHtml.medianMs, 51);
    assert.equal(result.workload.style.medianMs, 8);
    assert.deepEqual(result.responseBytes, {
      cold: { sampleCount: 1, minBytes: 512, medianBytes: 512, p95Bytes: 512, maxBytes: 512 },
      warm: { sampleCount: 1, minBytes: 512, medianBytes: 512, p95Bytes: 512, maxBytes: 512 },
    });
    assert.equal(result.largestStage, "codeToHtml");
    assert.deepEqual(result.largestStageObservation, {
      stage: "codeToHtml",
      medianMs: 69,
      sampleTotals: [69],
    });
    assert.deepEqual(result.stageObservationsOver50Ms, [{
      phase: "warm",
      stage: "codeToHtml",
      durationMs: 51,
    }, {
      phase: "warm",
      stage: "totalCompletion",
      durationMs: 61,
    }]);
  });

  it("chooses the largest stage from per-sample totals", () => {
    const secondSample = completeShikiObservations.map((observation) =>
      observation.stage === "codeToHtml"
        ? { ...observation, durationMs: observation.durationMs + 20 }
        : observation,
    );
    const thirdSample = secondSample.map((observation) =>
      observation.stage === "codeToHtml"
        ? { ...observation, durationMs: observation.durationMs + 40 }
        : observation,
    );
    const result = aggregateShikiStageAttribution([
      completeShikiObservations,
      secondSample,
      thirdSample,
    ]);
    assert.deepEqual(result.largestStageObservation, {
      stage: "codeToHtml",
      medianMs: 109,
      sampleTotals: [69, 109, 189],
    });
  });

  it("keeps unavailable production React stages null", () => {
    const result = aggregateShikiStageAttribution(productionShikiObservations, "production");
    assert.equal(result.stages.cold.reactCommit, null);
    assert.equal(result.stages.warm.htmlInsertion, null);
    assert.equal(result.stages.cold.totalCompletion, null);
    assert.equal(result.workload.style?.sampleCount, 1);
    assert.notEqual(result.largestStage, "totalCompletion");
  });

  it("requires mode-specific Shiki stages", () => {
    assert.throws(
      () => aggregateShikiStageAttribution(productionShikiObservations, "profiling"),
      /reactCommit/,
    );
    assert.throws(
      () => aggregateShikiStageAttribution(
        completeShikiObservations.filter(({ stage }) => stage !== "style"),
        "production",
      ),
      /workload style/,
    );
  });

  it("extracts every Chromium long task without mixing stage observations", () => {
    assert.deepEqual(extractShikiLongTasks([49, 50, 50.5, 75, Number.NaN], 3), [
      { sampleIndex: 3, durationMs: 50.5 },
      { sampleIndex: 3, durationMs: 75 },
    ]);
    assert.deepEqual(extractShikiLongTasks([], 0), []);
  });

  it("collects Shiki tracing only in production mode", () => {
    assert.equal(getShikiTraceOptions(true, "profiling"), undefined);
    assert.deepEqual(getShikiTraceOptions(true, "production"), { trace: true });
    assert.equal(getShikiTraceOptions(false, "production"), undefined);
  });

  it("rejects unknown, invalid, and unbounded Shiki observations", () => {
    for (const invalid of [
      [{ phase: "cold", stage: "unknown", durationMs: 1 }],
      [{ phase: "cold", stage: "codeToHtml", durationMs: -1 }],
      [{ phase: "cold", stage: "codeToHtml", durationMs: Infinity }],
      [{ phase: "cold", stage: "codeToHtml", durationMs: 60_001 }],
      [{ phase: "cold", stage: "responseBytes", bytes: 1.5 }],
      [{ phase: "cold", stage: "responseBytes", bytes: 64 * 1024 * 1024 + 1 }],
      [{ phase: "workload", stage: "codeToHtml", durationMs: 1 }],
      completeShikiObservations.map((observation, index) =>
        index === 5 ? { ...observation, phase: "workload" } : observation,
      ),
      completeShikiObservations.map((observation, index) =>
        index === 0 ? { ...observation, extra: true } : observation,
      ),
    ]) {
      assert.throws(() => aggregateShikiStageAttribution(invalid));
    }
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
    assert.deepEqual(
      validateRendererBudgetSample(
        "denseNarrative",
        {
          viewportDescendants: 500,
          browsingViewportDescendants: 500,
        },
        { gpu: null, chromium: null },
        "profiling",
      ),
      [
        "denseNarrative viewport descendants: observed 500; budget <= 499",
        "denseNarrative browsing viewport descendants: observed 500; budget <= 499",
      ],
    );
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

  it("allows one sample for the standalone-web production trace route", () => {
    const originalArguments = [...process.argv];
    try {
      process.argv.push(
        "--runtime",
        "standalone-web",
        "--mode",
        "production",
        "--sample-count",
        "1",
      );
      assert.deepEqual(parsePerformanceOptions(), {
        runtime: "standalone-web",
        mode: "production",
        sampleCount: 1,
      });

      process.argv.splice(
        0,
        process.argv.length,
        ...originalArguments,
        "--runtime",
        "paired",
        "--mode",
        "profiling",
        "--sample-count",
        "1",
      );
      assert.throws(parsePerformanceOptions, /integer from 3 through 20/);

      process.argv.splice(
        0,
        process.argv.length,
        ...originalArguments,
        "--runtime",
        "unknown",
      );
      assert.throws(parsePerformanceOptions, /paired or standalone-web/);
    } finally {
      process.argv.splice(0, process.argv.length, ...originalArguments);
    }
  });

  it("keeps Electron-only worker environment state out of standalone web", () => {
    const baseEnvironment = { PATH: "test-path", ELECTRON_RUN_AS_NODE: "1" };
    const standaloneEnvironment = getWorkerEnvironment("standalone-web", baseEnvironment);
    assert.equal(Object.hasOwn(standaloneEnvironment, "ELECTRON_RUN_AS_NODE"), false);
    assert.equal(standaloneEnvironment.PATH, "test-path");
    assert.equal(baseEnvironment.ELECTRON_RUN_AS_NODE, "1");
    assert.equal(getWorkerEnvironment("paired", baseEnvironment).ELECTRON_RUN_AS_NODE, "1");
  });

  it("uses Node for standalone web and Electron for paired workers", () => {
    assert.equal(getWorkerExecutable("standalone-web", "electron.exe", "win32"), "node.exe");
    assert.equal(getWorkerExecutable("standalone-web", "electron", "linux"), "node");
    assert.equal(getWorkerExecutable("paired", "electron.exe", "win32"), "electron.exe");
  });
});
