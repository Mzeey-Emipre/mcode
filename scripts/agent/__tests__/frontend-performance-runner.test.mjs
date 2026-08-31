import * as NodeAssertStrict from "node:assert/strict";
import * as NodeTest from "node:test";
import {
  summarizeDurationSamples,
  summarizeTrace,
} from "../../perf/frontend-performance-collectors.mjs";
import {
  aggregateMessageListPerformanceAttribution,
  aggregateShikiStageAttribution,
  extractShikiLongTasks,
  FRONTEND_RENDERER_EXPLICIT_WORKLOADS,
  FRONTEND_RENDERER_WORKLOADS,
  deriveVListLifecycleGate,
  getShikiTraceOptions,
  MESSAGE_LIST_PERFORMANCE_STAGE_NAMES,
  normalizeFrontendRendererWorkloads,
  SHIKI_STAGE_NAMES,
  validateMessageListPerformanceAttribution,
  validateNarrativeRowIsolation,
  validateVListLifecycleFacts,
  validateWorkloadCheck,
} from "../../perf/frontend-renderer-fixture.mjs";
import {
  getFrontendPerformanceExitCode,
  parseFrontendPerformanceRuntimes,
  parseFrontendPerformanceWorkloads,
  parsePerformanceMode,
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

const VLIST_A_ROW_ID = "message:thread-vlist-probe:A";
const VLIST_B_ROW_ID = "narrative-flow:turn-vlist-probe:B";
const VLIST_STATIC_ROWS = [
  ["narrative-indicator:turn-vlist-probe", "narrative-indicator"],
  ["permission-request:permission-vlist-probe", "permission-request"],
  ["turn-changes:message-vlist-probe", "turn-changes"],
];
const VLIST_SCROLL_ROWS = Array.from({ length: 12 }, (_, index) => [
  `message:scroll-vlist-probe:${index}`,
  "message",
]);
const VLIST_ROW_IDS = [
  VLIST_A_ROW_ID,
  VLIST_B_ROW_ID,
  ...VLIST_STATIC_ROWS.map(([rowId]) => rowId),
  ...VLIST_SCROLL_ROWS.map(([rowId]) => rowId),
];

function createExpectedVListLifecycleFacts() {
  const renderedRows = (primaryRowId, primaryKind) => [
    { rowId: primaryRowId, kind: primaryKind },
    ...VLIST_STATIC_ROWS.map(([rowId, kind]) => ({ rowId, kind })),
  ];
  const bodyPortals = (...presentRowIds) => Object.fromEntries(
    VLIST_ROW_IDS.map((rowId) => [rowId, presentRowIds.includes(rowId)]),
  );
  const rowEvents = (rowId, mounts, controls = 0) => [
    ...Array.from({ length: mounts }, () => ({ type: "ref-attach", rowId, poolItemId: rowId })),
    ...Array.from({ length: mounts }, () => ({ type: "effect-mount", rowId })),
    ...Array.from({ length: controls }, () => ({ type: "control", rowId })),
    ...Array.from({ length: mounts }, () => ({ type: "ref-detach", rowId })),
    ...Array.from({ length: mounts }, () => ({ type: "effect-cleanup", rowId })),
    ...Array.from({ length: mounts }, () => ({ type: "body-cleanup", rowId })),
  ];
  const scrollRows = (start) => VLIST_SCROLL_ROWS
    .slice(start, start + 4)
    .map(([rowId, kind]) => ({ rowId, kind }));
  const phaseRows = (rowIds, poolHostTokens, cleanupCounts, connected) => rowIds.map((rowId, index) => ({
    rowId,
    poolHostToken: poolHostTokens[index],
    portalHostConnected: connected,
    effectCleanupCount: cleanupCounts[index],
    refDetachCount: cleanupCounts[index],
  }));
  const transition = ({
    cause,
    visibleRowIdsBefore,
    visibleRowIdsAfter,
    outgoingPoolHostTokens,
    incomingPoolHostTokens,
    cleanupCounts,
  }) => {
    const outgoingRowIds = visibleRowIdsBefore.filter((rowId) => !visibleRowIdsAfter.includes(rowId));
    const incomingRowIds = visibleRowIdsAfter.filter((rowId) => !visibleRowIdsBefore.includes(rowId));
    const cleanupCountsAfterPreUnmount = cleanupCounts.map((count) => count + 1);
    return {
      cause,
      visibleRowIdsBefore,
      visibleRowIdsAfter,
      beforeReactPreUnmount: phaseRows(outgoingRowIds, outgoingPoolHostTokens, cleanupCounts, true),
      afterReactPreUnmountBeforeVListPhase2: phaseRows(
        outgoingRowIds,
        outgoingPoolHostTokens,
        cleanupCountsAfterPreUnmount,
        true,
      ),
      afterVListPhase2: phaseRows(
        outgoingRowIds,
        outgoingPoolHostTokens,
        cleanupCountsAfterPreUnmount,
        false,
      ),
      incomingRowsAfterVListPhase2: incomingRowIds.map((rowId, index) => ({
        rowId,
        poolHostToken: incomingPoolHostTokens[index],
      })),
    };
  };
  const afterAIds = [VLIST_A_ROW_ID, ...VLIST_STATIC_ROWS.map(([rowId]) => rowId)];
  const afterBIds = [VLIST_B_ROW_ID, ...VLIST_STATIC_ROWS.map(([rowId]) => rowId)];
  const scrollIds = (start) => VLIST_SCROLL_ROWS.slice(start, start + 4).map(([rowId]) => rowId);
  return {
    renderedRows: {
      afterA: renderedRows(VLIST_A_ROW_ID, "message"),
      afterAToB: renderedRows(VLIST_B_ROW_ID, "narrative-flow"),
      afterBToA: renderedRows(VLIST_A_ROW_ID, "message"),
      beforeNativeScroll: scrollRows(0),
      afterFirstNativeScroll: scrollRows(4),
      afterNativeScrollRecycle: scrollRows(8),
    },
    values: {
      a: {
        draftAfterEdit: "edited-A",
        buttonAfterClick: "Assistant message A action 1",
        draftAfterReturn: "draft-A",
        buttonAfterReturn: "Assistant message A action 0",
      },
      b: {
        draftBeforeFocus: "draft-B",
        buttonBeforeClick: "Narrative flow B action 0",
        buttonAfterClick: "Narrative flow B action 1",
      },
    },
    focus: {
      afterAFocus: { activeProbeInputRowId: VLIST_A_ROW_ID },
      afterAToB: {
        activeProbeInputRowId: null,
        previousInputConnected: false,
        previousInputActive: false,
      },
      afterBFocus: { activeProbeInputRowId: VLIST_B_ROW_ID },
      afterBToA: {
        activeProbeInputRowId: null,
        previousInputConnected: false,
        previousInputActive: false,
      },
    },
    bodyPortals: {
      afterA: bodyPortals(VLIST_A_ROW_ID, ...VLIST_STATIC_ROWS.map(([rowId]) => rowId)),
      afterAToB: bodyPortals(VLIST_B_ROW_ID, ...VLIST_STATIC_ROWS.map(([rowId]) => rowId)),
      afterBToA: bodyPortals(VLIST_A_ROW_ID, ...VLIST_STATIC_ROWS.map(([rowId]) => rowId)),
      afterDispose: bodyPortals(),
    },
    transitions: [
      transition({
        cause: "set-items",
        visibleRowIdsBefore: afterAIds,
        visibleRowIdsAfter: afterBIds,
        outgoingPoolHostTokens: ["pool-host-0"],
        incomingPoolHostTokens: ["pool-host-0"],
        cleanupCounts: [0],
      }),
      transition({
        cause: "set-items",
        visibleRowIdsBefore: afterBIds,
        visibleRowIdsAfter: afterAIds,
        outgoingPoolHostTokens: ["pool-host-0"],
        incomingPoolHostTokens: ["pool-host-0"],
        cleanupCounts: [0],
      }),
      transition({
        cause: "set-items",
        visibleRowIdsBefore: afterAIds,
        visibleRowIdsAfter: scrollIds(0),
        outgoingPoolHostTokens: ["pool-host-0", "pool-host-1", "pool-host-2", "pool-host-3"],
        incomingPoolHostTokens: ["pool-host-0", "pool-host-1", "pool-host-2", "pool-host-3"],
        cleanupCounts: [1, 0, 0, 0],
      }),
      transition({
        cause: "native-scroll",
        visibleRowIdsBefore: scrollIds(0),
        visibleRowIdsAfter: scrollIds(4),
        outgoingPoolHostTokens: ["pool-host-0", "pool-host-1", "pool-host-2", "pool-host-3"],
        incomingPoolHostTokens: ["pool-host-4", "pool-host-5", "pool-host-6", "pool-host-7"],
        cleanupCounts: [0, 0, 0, 0],
      }),
      transition({
        cause: "native-scroll",
        visibleRowIdsBefore: scrollIds(4),
        visibleRowIdsAfter: scrollIds(8),
        outgoingPoolHostTokens: ["pool-host-4", "pool-host-5", "pool-host-6", "pool-host-7"],
        incomingPoolHostTokens: ["pool-host-3", "pool-host-2", "pool-host-1", "pool-host-0"],
        cleanupCounts: [0, 0, 0, 0],
      }),
    ],
    prepend: {
      anchorRowId: VLIST_SCROLL_ROWS[4][0],
      anchorTopBefore: 24,
      anchorTopAfter: 24,
      draftBefore: "edited-before-prepend",
      draftAfter: "edited-before-prepend",
      effectMountCountBefore: 1,
      effectMountCountAfter: 1,
      refAttachCountBefore: 1,
      refAttachCountAfter: 1,
      portalHostTokenBefore: "portal-host-4",
      portalHostTokenAfter: "portal-host-4",
      visibleRowIdsAfter: VLIST_SCROLL_ROWS.slice(4, 8).map(([rowId]) => rowId),
    },
    events: [
      ...rowEvents(VLIST_A_ROW_ID, 2, 1),
      ...rowEvents(VLIST_B_ROW_ID, 1, 1),
      ...VLIST_STATIC_ROWS.flatMap(([rowId]) => rowEvents(rowId, 1)),
      ...VLIST_SCROLL_ROWS.flatMap(([rowId]) => rowEvents(rowId, 1)),
    ],
  };
}

NodeTest.describe("frontend performance runner", () => {
  NodeTest.it("uses the approved workload order", () => {
    NodeAssertStrict.default.deepEqual(FRONTEND_RENDERER_WORKLOADS, [
      "message100",
      "message1000",
      "threadSwitch",
      "streaming",
      "messageListBehavior",
      "denseNarrative",
      "markdownShiki",
      "panelTransitions",
    ]);
  });

  NodeTest.it("requires explicit selection and accepts only the vlist lifecycle phase ordering", () => {
    NodeAssertStrict.default.deepEqual(FRONTEND_RENDERER_EXPLICIT_WORKLOADS, ["vlistLifecycle"]);
    NodeAssertStrict.default.deepEqual(normalizeFrontendRendererWorkloads(null), FRONTEND_RENDERER_WORKLOADS);
    NodeAssertStrict.default.deepEqual(normalizeFrontendRendererWorkloads("vlistLifecycle"), ["vlistLifecycle"]);
    NodeAssertStrict.default.throws(
      () => normalizeFrontendRendererWorkloads("message100,vlistLifecycle"),
      /must be selected without another frontend renderer workload/,
    );

    const expectedFacts = createExpectedVListLifecycleFacts();
    const derived = deriveVListLifecycleGate(expectedFacts);
    NodeAssertStrict.default.deepEqual(derived.lifecycleGate, { passed: true, failure: null });
    NodeAssertStrict.default.deepEqual(derived.gateDecision, {
      status: "accepted",
      candidateEligible: true,
      reason: null,
    });
    NodeAssertStrict.default.deepEqual(validateVListLifecycleFacts(expectedFacts), []);
    NodeAssertStrict.default.deepEqual(validateWorkloadCheck("vlistLifecycle", expectedFacts), []);
    NodeAssertStrict.default.equal(getFrontendPerformanceExitCode({
      correctness: { passed: true },
      runtimes: {
        electron: { metrics: { vlistLifecycle: { gateDecision: derived.gateDecision } } },
      },
    }), 0);

    const lateCleanup = {
      ...expectedFacts,
      transitions: expectedFacts.transitions.map((transition, index) => index === 0
        ? {
            ...transition,
            afterReactPreUnmountBeforeVListPhase2: transition.beforeReactPreUnmount,
          }
        : transition),
    };
    const lateCleanupDerived = deriveVListLifecycleGate(lateCleanup);
    NodeAssertStrict.default.equal(lateCleanupDerived.checks.reactCleanupPrecedesVListPhase2, false);
    NodeAssertStrict.default.ok(validateVListLifecycleFacts(lateCleanup).includes(
      "vlist lifecycle assertion failed: reactCleanupPrecedesVListPhase2",
    ));

    const disconnectedBeforePreUnmount = {
      ...expectedFacts,
      transitions: expectedFacts.transitions.map((transition, index) => index === 0
        ? {
            ...transition,
            beforeReactPreUnmount: transition.beforeReactPreUnmount.map((row) => ({
              ...row,
              portalHostConnected: false,
            })),
          }
        : transition),
    };
    NodeAssertStrict.default.equal(
      deriveVListLifecycleGate(disconnectedBeforePreUnmount).checks.reactCleanupPrecedesVListPhase2,
      false,
    );
    NodeAssertStrict.default.ok(validateVListLifecycleFacts(disconnectedBeforePreUnmount).includes(
      "vlist lifecycle assertion failed: reactCleanupPrecedesVListPhase2",
    ));

    const duplicateCleanup = {
      ...expectedFacts,
      events: [
        ...expectedFacts.events,
        { type: "effect-cleanup", rowId: VLIST_A_ROW_ID },
      ],
    };
    NodeAssertStrict.default.equal(deriveVListLifecycleGate(duplicateCleanup).checks.effectsCleanUpExactlyOnce, false);
    NodeAssertStrict.default.ok(validateVListLifecycleFacts(duplicateCleanup).includes(
      "vlist lifecycle assertion failed: effectsCleanUpExactlyOnce",
    ));

    const mutatedRawState = {
      ...expectedFacts,
      values: {
        ...expectedFacts.values,
        a: { ...expectedFacts.values.a, draftAfterReturn: "edited-A" },
      },
    };
    NodeAssertStrict.default.equal(deriveVListLifecycleGate(mutatedRawState).checks.stateDoesNotTransfer, false);
    NodeAssertStrict.default.ok(validateVListLifecycleFacts(mutatedRawState).includes(
      "vlist lifecycle assertion failed: stateDoesNotTransfer",
    ));

    const mutatedRawFocus = {
      ...expectedFacts,
      focus: {
        ...expectedFacts.focus,
        afterAToB: { ...expectedFacts.focus.afterAToB, activeProbeInputRowId: VLIST_B_ROW_ID },
      },
    };
    NodeAssertStrict.default.equal(deriveVListLifecycleGate(mutatedRawFocus).checks.focusAndControlsRemainCorrect, false);
    NodeAssertStrict.default.ok(validateVListLifecycleFacts(mutatedRawFocus).includes(
      "vlist lifecycle assertion failed: focusAndControlsRemainCorrect",
    ));

    const remountedDuringPrepend = {
      ...expectedFacts,
      prepend: {
        ...expectedFacts.prepend,
        effectMountCountAfter: 2,
        refAttachCountAfter: 2,
      },
    };
    NodeAssertStrict.default.equal(
      deriveVListLifecycleGate(remountedDuringPrepend).checks.prependPreservesAnchorAndIdentity,
      false,
    );
    NodeAssertStrict.default.ok(validateVListLifecycleFacts(remountedDuringPrepend).includes(
      "vlist lifecycle assertion failed: prependPreservesAnchorAndIdentity",
    ));

    NodeAssertStrict.default.equal(getFrontendPerformanceExitCode({
      correctness: { passed: true },
      runtimes: {
        electron: { metrics: { vlistLifecycle: { gateDecision: lateCleanupDerived.gateDecision } } },
      },
    }), 1);
  });

  NodeTest.it("reports deterministic duration statistics", () => {
    NodeAssertStrict.default.deepEqual(summarizeDurationSamples([4, 1, 3, 2]), {
      sampleCount: 4,
      minMs: 1,
      medianMs: 2,
      p95Ms: 4,
      maxMs: 4,
    });
    NodeAssertStrict.default.equal(summarizeDurationSamples([]), null);
    NodeAssertStrict.default.throws(
      () => summarizeDurationSamples([1, Number.NaN]),
      /finite non-negative numbers/,
    );
  });

  NodeTest.it("rejects wrong visible state for every workload contract", () => {
    NodeAssertStrict.default.deepEqual(validateWorkloadCheck("message100", {
      activeThreadId: "left",
      currentThreadId: "right",
      visibleThreadId: "right",
      mountedMessages: 9,
      totalMessages: 100,
    }), ["selected and visible thread identities differ"]);
    NodeAssertStrict.default.deepEqual(validateWorkloadCheck("streaming", {
      expectedText: "complete response",
      streamingText: "partial response",
      storeUpdateCommits: 200,
      visibleStreamingUpdates: 200,
      visualStreamingCommitted: true,
      tailFollowed: true,
      userAwayPreserved: true,
    }), ["streamed response text differs"]);
    NodeAssertStrict.default.deepEqual(validateWorkloadCheck("markdownShiki", {
      codeBlocks: 10,
      highlightedBlocks: 9,
    }), [
      "expected 10 highlighted code blocks",
      "expected plain fallback before highlight completion",
      "expected Shiki theme class and style",
      "expected accessible copy buttons",
      "expected semantic pre/code elements",
      "expected highlighted code content",
      "expected horizontal code overflow to remain scrollable",
      "expected highlighted code text selection",
      "expected Shiki stage attribution",
    ]);
    NodeAssertStrict.default.deepEqual(validateWorkloadCheck("markdownShiki", {
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
    }), []);
    NodeAssertStrict.default.deepEqual(validateWorkloadCheck("markdownShiki", {
      buildMode: "production",
      codeBlocks: 10,
      highlightedBlocks: 10,
      plainFallbackObserved: true,
      themeClassAndStyle: true,
      copyButtonsAccessible: true,
      semanticCodeBlocks: true,
      highlightedContent: true,
      horizontalOverflow: true,
      textSelection: true,
      shikiAttribution: productionShikiObservations,
      shikiLongTasksOver50Ms: [],
    }, "production"), []);
    NodeAssertStrict.default.deepEqual(validateWorkloadCheck("panelTransitions", {
      activeTab: "preview",
      browserTabOpen: true,
      terminalTabOpen: true,
      terminalShell: true,
      visible: true,
    }), ["Terminal is not the active panel"]);
  });

  NodeTest.it("rejects a message-list behavior sample when a cache-miss does not render the restored record", () => {
    const accepted = {
      longThreadScroll: true,
      dynamicHeightSettled: true,
      olderHistoryAnchor: true,
      newerHistoryAnchor: true,
      olderHistoryLoaded: true,
      newerHistoryLoaded: true,
      cacheHitThreadIdentity: true,
      cacheHitRestored: true,
      cacheMissThreadIdentity: true,
      cacheMissLoadingObserved: true,
      cacheMissRestored: true,
      cacheMissTailPositioned: true,
      stickyAbsentWhenUserVisible: true,
      stickyVisible: true,
      stickyTargetWasUnmountedBeforeJump: true,
      stickyUserJumped: true,
      focusPreserved: true,
      interactiveControl: true,
      liveToPersistedIdentity: true,
    };
    NodeAssertStrict.default.deepEqual(validateWorkloadCheck("messageListBehavior", accepted), []);
    NodeAssertStrict.default.deepEqual(validateWorkloadCheck("messageListBehavior", {
      ...accepted,
      cacheMissRestored: false,
    }), ["cache-miss did not render the restored client record"]);
    NodeAssertStrict.default.deepEqual(validateWorkloadCheck("messageListBehavior", {
      ...accepted,
      olderHistoryLoaded: false,
    }), ["older history did not load a page"]);
    NodeAssertStrict.default.deepEqual(validateWorkloadCheck("messageListBehavior", {
      ...accepted,
      cacheMissLoadingObserved: false,
    }), ["cache-miss did not hold the outgoing transcript while empty"]);
    NodeAssertStrict.default.deepEqual(validateWorkloadCheck("messageListBehavior", {
      ...accepted,
      cacheMissTailPositioned: false,
    }), ["cache-miss did not position the restored transcript at the tail"]);
    NodeAssertStrict.default.deepEqual(validateWorkloadCheck("messageListBehavior", {
      ...accepted,
      stickyTargetWasUnmountedBeforeJump: false,
    }), ["sticky user target stayed mounted before jump"]);
    NodeAssertStrict.default.deepEqual(validateWorkloadCheck("messageListBehavior", {
      ...accepted,
      stickyUserJumped: false,
    }), ["sticky user message did not jump to its transcript row"]);
  });

  NodeTest.it("rejects a streaming sample when one update never reaches the live response", () => {
    NodeAssertStrict.default.deepEqual(validateWorkloadCheck("streaming", {
      expectedText: "complete response",
      streamingText: "complete response",
      storeUpdateCommits: 200,
      visibleStreamingUpdates: 199,
      visualStreamingCommitted: true,
      tailFollowed: true,
      userAwayPreserved: true,
    }), ["streaming did not visibly commit 200 updates"]);
  });

  NodeTest.it("rejects an unvirtualized long-thread mount", () => {
    NodeAssertStrict.default.deepEqual(validateWorkloadCheck("message100", {
      activeThreadId: "thread-100",
      currentThreadId: "thread-100",
      visibleThreadId: "thread-100",
      mountedMessages: 65,
      totalMessages: 100,
    }), ["virtualized message rows exceeded 64"]);
  });

  NodeTest.it("rejects missing MessageList timing stages before a virtualizer attribution becomes incomplete", () => {
    NodeAssertStrict.default.deepEqual(MESSAGE_LIST_PERFORMANCE_STAGE_NAMES, [
      "narrativeItemProjection",
      "tanstackVirtualItems",
    ]);
    NodeAssertStrict.default.deepEqual(validateMessageListPerformanceAttribution([
      { stage: "narrativeItemProjection", durationMs: 0.5 },
      { stage: "tanstackVirtualItems", durationMs: 0.25 },
    ]), []);
    NodeAssertStrict.default.deepEqual(validateMessageListPerformanceAttribution([
      { stage: "narrativeItemProjection", durationMs: 0.5 },
    ]), ["missing MessageList performance stage: tanstackVirtualItems"]);
    NodeAssertStrict.default.deepEqual(aggregateMessageListPerformanceAttribution([
      [
        { stage: "narrativeItemProjection", durationMs: 4 },
        { stage: "tanstackVirtualItems", durationMs: 1 },
      ],
      [
        { stage: "narrativeItemProjection", durationMs: 2 },
        { stage: "tanstackVirtualItems", durationMs: 3 },
      ],
    ]), {
      narrativeItemProjection: {
        sampleCount: 2,
        minMs: 2,
        medianMs: 2,
        p95Ms: 4,
        maxMs: 4,
      },
      tanstackVirtualItems: {
        sampleCount: 2,
        minMs: 1,
        medianMs: 1,
        p95Ms: 3,
        maxMs: 3,
      },
    });
  });

  NodeTest.it("recognizes MinorGC and MajorGC trace events", () => {
    NodeAssertStrict.default.equal(summarizeTrace([
      { ph: "X", name: "MinorGC", dur: 1_000 },
      { ph: "X", name: "MajorGC", dur: 2_000 },
      { ph: "X", name: "Logic", dur: 5_000 },
    ]).gcTraceMs, 3);
  });

  NodeTest.it("aggregates known Shiki stages by cold and warm phase", () => {
    NodeAssertStrict.default.deepEqual(SHIKI_STAGE_NAMES, [
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
    NodeAssertStrict.default.equal(result.stages.cold.codeToHtml.medianMs, 18);
    NodeAssertStrict.default.equal(result.stages.warm.codeToHtml.medianMs, 51);
    NodeAssertStrict.default.equal(result.workload.style.medianMs, 8);
    NodeAssertStrict.default.deepEqual(result.responseBytes, {
      cold: { sampleCount: 1, minBytes: 512, medianBytes: 512, p95Bytes: 512, maxBytes: 512 },
      warm: { sampleCount: 1, minBytes: 512, medianBytes: 512, p95Bytes: 512, maxBytes: 512 },
    });
    NodeAssertStrict.default.equal(result.largestStage, "codeToHtml");
    NodeAssertStrict.default.deepEqual(result.largestStageObservation, {
      stage: "codeToHtml",
      medianMs: 69,
      sampleTotals: [69],
    });
    NodeAssertStrict.default.deepEqual(result.stageObservationsOver50Ms, [{
      phase: "warm",
      stage: "codeToHtml",
      durationMs: 51,
    }, {
      phase: "warm",
      stage: "totalCompletion",
      durationMs: 61,
    }]);
  });

  NodeTest.it("chooses the largest stage from per-sample totals", () => {
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
    NodeAssertStrict.default.deepEqual(result.largestStageObservation, {
      stage: "codeToHtml",
      medianMs: 109,
      sampleTotals: [69, 109, 189],
    });
  });

  NodeTest.it("keeps unavailable production React stages null", () => {
    const result = aggregateShikiStageAttribution(productionShikiObservations, "production");
    NodeAssertStrict.default.equal(result.stages.cold.reactCommit, null);
    NodeAssertStrict.default.equal(result.stages.warm.htmlInsertion, null);
    NodeAssertStrict.default.equal(result.stages.cold.totalCompletion, null);
    NodeAssertStrict.default.equal(result.workload.style?.sampleCount, 1);
    NodeAssertStrict.default.notEqual(result.largestStage, "totalCompletion");
  });

  NodeTest.it("requires mode-specific Shiki stages", () => {
    NodeAssertStrict.default.throws(
      () => aggregateShikiStageAttribution(productionShikiObservations, "profiling"),
      /reactCommit/,
    );
    NodeAssertStrict.default.throws(
      () => aggregateShikiStageAttribution(
        completeShikiObservations.filter(({ stage }) => stage !== "style"),
        "production",
      ),
      /workload style/,
    );
  });

  NodeTest.it("rejects a Shiki sample that lacks the measured worker delivery boundary", () => {
    NodeAssertStrict.default.throws(
      () => aggregateShikiStageAttribution(
        completeShikiObservations.filter(({ stage }) => stage !== "workerDelivery"),
      ),
      /workerDelivery/,
    );
  });

  NodeTest.it("extracts every Chromium long task without mixing stage observations", () => {
    NodeAssertStrict.default.deepEqual(extractShikiLongTasks([49, 50, 50.5, 75, Number.NaN], 3), [
      { sampleIndex: 3, durationMs: 50.5 },
      { sampleIndex: 3, durationMs: 75 },
    ]);
    NodeAssertStrict.default.deepEqual(extractShikiLongTasks([], 0), []);
  });

  NodeTest.it("collects Shiki tracing only in production mode", () => {
    NodeAssertStrict.default.equal(getShikiTraceOptions(true, "profiling"), undefined);
    NodeAssertStrict.default.deepEqual(getShikiTraceOptions(true, "production"), { trace: true });
    NodeAssertStrict.default.equal(getShikiTraceOptions(false, "production"), undefined);
  });

  NodeTest.it("rejects unknown, invalid, and unbounded Shiki observations", () => {
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
      NodeAssertStrict.default.throws(() => aggregateShikiStageAttribution(invalid));
    }
  });

  NodeTest.it("requires at least three samples", async () => {
    const originalArguments = [...process.argv];
    process.argv.push("--sample-count", "2");
    try {
      await NodeAssertStrict.default.rejects(
        runFrontendPerformance(process.cwd()),
        /integer from 3 through 20/,
      );
    } finally {
      process.argv.splice(0, process.argv.length, ...originalArguments);
    }
  });

  NodeTest.it("rejects stable narrative sibling renders", () => {
    NodeAssertStrict.default.deepEqual(validateNarrativeRowIsolation({
      affectedRow: { rowId: "thought-1", renderCount: 1 },
      stableSiblingRows: [{ rowId: "hook-1", renderCount: 1 }],
    }), ["stable narrative row rendered: hook-1"]);
    NodeAssertStrict.default.deepEqual(validateNarrativeRowIsolation({
      affectedRow: { rowId: "thought-1", renderCount: 1 },
      stableSiblingRows: [{ rowId: "hook-1", renderCount: 0 }],
    }), []);
  });

  NodeTest.it("enforces the dense narrative DOM and disclosure contract", () => {
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

    NodeAssertStrict.default.deepEqual(validateWorkloadCheck("denseNarrative", accepted), []);
    NodeAssertStrict.default.deepEqual(validateWorkloadCheck("denseNarrative", {
      ...accepted,
      descendants: 500,
    }), ["dense narrative viewport exceeded 499 descendants"]);
  });

  NodeTest.it("accepts only profiling and production modes", () => {
    const originalArguments = [...process.argv];
    try {
      process.argv.push("--mode", "profiling");
      NodeAssertStrict.default.equal(parsePerformanceMode(), "profiling");
      process.argv.splice(0, process.argv.length, ...originalArguments, "--mode", "development");
      NodeAssertStrict.default.throws(parsePerformanceMode, /profiling or production/);
    } finally {
      process.argv.splice(0, process.argv.length, ...originalArguments);
    }
  });

  NodeTest.it("filters runtime probes without changing their fixed workload order", () => {
    const originalArguments = [...process.argv];
    try {
      process.argv.push("--workload", "markdownShiki,messageListBehavior", "--runtime", "electron");
      NodeAssertStrict.default.deepEqual(parseFrontendPerformanceWorkloads(), ["messageListBehavior", "markdownShiki"]);
      NodeAssertStrict.default.deepEqual(parseFrontendPerformanceRuntimes(), ["electron"]);
      process.argv.splice(
        0,
        process.argv.length,
        ...originalArguments,
        "--workload",
        "unknown",
      );
      NodeAssertStrict.default.throws(parseFrontendPerformanceWorkloads, /known workloads/);
      process.argv.splice(
        0,
        process.argv.length,
        ...originalArguments,
        "--runtime",
        "browser",
      );
      NodeAssertStrict.default.throws(parseFrontendPerformanceRuntimes, /known runtimes/);
    } finally {
      process.argv.splice(0, process.argv.length, ...originalArguments);
    }
  });
});
