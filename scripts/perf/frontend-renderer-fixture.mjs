import {
  createModeSignalCollector,
  createPageSignalCollector,
  summarizeDurationSamples,
} from "./frontend-performance-collectors.mjs";

/** Ordered workload names in the shared web and Electron matrix. */
export const FRONTEND_RENDERER_WORKLOADS = Object.freeze([
  "message100",
  "message1000",
  "threadSwitch",
  "streaming",
  "messageListBehavior",
  "denseNarrative",
  "markdownShiki",
  "panelTransitions",
]);

/** Explicit-only probes excluded from the default frontend comparison matrix. */
export const FRONTEND_RENDERER_EXPLICIT_WORKLOADS = Object.freeze([
  "vlistLifecycle",
]);

const ALL_FRONTEND_RENDERER_WORKLOADS = Object.freeze([
  ...FRONTEND_RENDERER_WORKLOADS,
  ...FRONTEND_RENDERER_EXPLICIT_WORKLOADS,
]);

/** Paired runtime names supported by the frontend performance worker. */
export const FRONTEND_RENDERER_RUNTIMES = Object.freeze([
  "standalone-web",
  "electron",
]);

/** Normalizes the optional comma-separated workload filter for the paired runner. */
export function normalizeFrontendRendererWorkloads(value) {
  if (value == null) return [...FRONTEND_RENDERER_WORKLOADS];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("--workload must name one or more frontend renderer workloads");
  }
  const requested = value.split(",");
  if (requested.some((workload) => !ALL_FRONTEND_RENDERER_WORKLOADS.includes(workload))) {
    throw new Error(`--workload must use known workloads: ${ALL_FRONTEND_RENDERER_WORKLOADS.join(", ")}`);
  }
  if (requested.includes("vlistLifecycle") && requested.length !== 1) {
    throw new Error("vlistLifecycle must be selected without another frontend renderer workload");
  }
  return ALL_FRONTEND_RENDERER_WORKLOADS.filter((workload) => requested.includes(workload));
}

/** Normalizes the optional comma-separated runtime filter for the paired runner. */
export function normalizeFrontendRendererRuntimes(value) {
  if (value == null) return [...FRONTEND_RENDERER_RUNTIMES];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("--runtime must name one or more frontend renderer runtimes");
  }
  const requested = value.split(",");
  if (requested.some((runtime) => !FRONTEND_RENDERER_RUNTIMES.includes(runtime))) {
    throw new Error(`--runtime must use known runtimes: ${FRONTEND_RENDERER_RUNTIMES.join(", ")}`);
  }
  return FRONTEND_RENDERER_RUNTIMES.filter((runtime) => requested.includes(runtime));
}

/** Performance-build MessageList timing stages that are intentionally narrower than whole React commits. */
export const MESSAGE_LIST_PERFORMANCE_STAGE_NAMES = Object.freeze([
  "narrativeItemProjection",
  "tanstackVirtualItems",
]);

/** The worker contract is the producer; runner validation mirrors this serialized boundary. */
export const SHIKI_STAGE_NAMES = Object.freeze([
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

const SHIKI_DURATION_STAGE_NAMES = Object.freeze(
  SHIKI_STAGE_NAMES.filter((name) => name !== "responseBytes"),
);
const SHIKI_PHASES = Object.freeze(["cold", "warm"]);
const SHIKI_WORKLOAD_PHASE = "workload";
const SHIKI_BUILD_MODES = Object.freeze(["profiling", "production"]);
const SHIKI_WORKER_STAGES = Object.freeze([
  "workerStartup",
  "highlighterCreation",
  "grammarLoad",
  "codeToHtml",
  "responseBytes",
  "workerDelivery",
]);
const SHIKI_RENDERER_STAGES = Object.freeze([
  "reactCommit",
  "htmlInsertion",
  "totalCompletion",
]);
const MAX_SHIKI_STAGE_OBSERVATIONS = 1_000;
const MAX_SHIKI_DURATION_MS = 60_000;
const MAX_SHIKI_RESPONSE_BYTES = 64 * 1024 * 1024;
const PERFORMANCE_VIEWPORT_HEIGHT_PX = 1_000;
const MIN_MESSAGE_ROW_HEIGHT_PX = 21;
const MESSAGE_LIST_OVERSCAN = 8;
const MAX_MOUNTED_MESSAGE_ROWS = Math.ceil(
  PERFORMANCE_VIEWPORT_HEIGHT_PX / MIN_MESSAGE_ROW_HEIGHT_PX,
) + MESSAGE_LIST_OVERSCAN * 2;
const VLIST_LIFECYCLE_CHECK_NAMES = Object.freeze([
  "heterogeneousRows",
  "stableLogicalIdentity",
  "stateDoesNotTransfer",
  "effectsCleanUpExactlyOnce",
  "refsMatchLogicalRows",
  "documentBodyPortalsCleanUp",
  "focusAndControlsRemainCorrect",
  "controlsDispatchToDisplayedRow",
  "poolHostIdentity",
  "reactCleanupPrecedesVListPhase2",
  "staticRowsStableAcrossTransitions",
  "nativeScrollRecyclesHosts",
  "prependPreservesAnchorAndIdentity",
]);
const VLIST_LIFECYCLE_ROWS = Object.freeze([
  { rowId: "message:thread-vlist-probe:A", kind: "message" },
  { rowId: "narrative-flow:turn-vlist-probe:B", kind: "narrative-flow" },
  { rowId: "narrative-indicator:turn-vlist-probe", kind: "narrative-indicator" },
  { rowId: "permission-request:permission-vlist-probe", kind: "permission-request" },
  { rowId: "turn-changes:message-vlist-probe", kind: "turn-changes" },
]);
const VLIST_LIFECYCLE_ROW_IDS = Object.freeze(VLIST_LIFECYCLE_ROWS.map(({ rowId }) => rowId));
const VLIST_LIFECYCLE_STATIC_ROW_IDS = Object.freeze(VLIST_LIFECYCLE_ROW_IDS.slice(2));
const VLIST_LIFECYCLE_SCROLL_ROWS = Object.freeze(Array.from({ length: 12 }, (_, index) => Object.freeze({
  rowId: `message:scroll-vlist-probe:${index}`,
  kind: "message",
})));
const VLIST_LIFECYCLE_SCROLL_ROW_IDS = Object.freeze(
  VLIST_LIFECYCLE_SCROLL_ROWS.map(({ rowId }) => rowId),
);
const VLIST_LIFECYCLE_ALL_ROW_IDS = Object.freeze([
  ...VLIST_LIFECYCLE_ROW_IDS,
  ...VLIST_LIFECYCLE_SCROLL_ROW_IDS,
]);
const VLIST_LIFECYCLE_RENDERED_ROWS = Object.freeze({
  afterA: Object.freeze([
    VLIST_LIFECYCLE_ROWS[0],
    ...VLIST_LIFECYCLE_ROWS.slice(2),
  ]),
  afterAToB: Object.freeze([
    VLIST_LIFECYCLE_ROWS[1],
    ...VLIST_LIFECYCLE_ROWS.slice(2),
  ]),
  afterBToA: Object.freeze([
    VLIST_LIFECYCLE_ROWS[0],
    ...VLIST_LIFECYCLE_ROWS.slice(2),
  ]),
  beforeNativeScroll: Object.freeze(VLIST_LIFECYCLE_SCROLL_ROWS.slice(0, 4)),
  afterFirstNativeScroll: Object.freeze(VLIST_LIFECYCLE_SCROLL_ROWS.slice(4, 8)),
  afterNativeScrollRecycle: Object.freeze(VLIST_LIFECYCLE_SCROLL_ROWS.slice(8, 12)),
});
const VLIST_LIFECYCLE_TRANSITIONS = Object.freeze([
  {
    cause: "set-items",
    visibleRowIdsBefore: VLIST_LIFECYCLE_RENDERED_ROWS.afterA.map(({ rowId }) => rowId),
    visibleRowIdsAfter: VLIST_LIFECYCLE_RENDERED_ROWS.afterAToB.map(({ rowId }) => rowId),
  },
  {
    cause: "set-items",
    visibleRowIdsBefore: VLIST_LIFECYCLE_RENDERED_ROWS.afterAToB.map(({ rowId }) => rowId),
    visibleRowIdsAfter: VLIST_LIFECYCLE_RENDERED_ROWS.afterBToA.map(({ rowId }) => rowId),
  },
  {
    cause: "set-items",
    visibleRowIdsBefore: VLIST_LIFECYCLE_RENDERED_ROWS.afterBToA.map(({ rowId }) => rowId),
    visibleRowIdsAfter: VLIST_LIFECYCLE_RENDERED_ROWS.beforeNativeScroll.map(({ rowId }) => rowId),
  },
  {
    cause: "native-scroll",
    visibleRowIdsBefore: VLIST_LIFECYCLE_RENDERED_ROWS.beforeNativeScroll.map(({ rowId }) => rowId),
    visibleRowIdsAfter: VLIST_LIFECYCLE_RENDERED_ROWS.afterFirstNativeScroll.map(({ rowId }) => rowId),
  },
  {
    cause: "native-scroll",
    visibleRowIdsBefore: VLIST_LIFECYCLE_RENDERED_ROWS.afterFirstNativeScroll.map(({ rowId }) => rowId),
    visibleRowIdsAfter: VLIST_LIFECYCLE_RENDERED_ROWS.afterNativeScrollRecycle.map(({ rowId }) => rowId),
  },
]);
const VLIST_LIFECYCLE_TRANSITION_KEYS = Object.freeze([
  "cause",
  "visibleRowIdsBefore",
  "visibleRowIdsAfter",
  "beforeReactPreUnmount",
  "afterReactPreUnmountBeforeVListPhase2",
  "afterVListPhase2",
  "incomingRowsAfterVListPhase2",
]);
const VLIST_LIFECYCLE_TRANSITION_ROW_KEYS = Object.freeze([
  "rowId",
  "poolHostToken",
  "portalHostConnected",
  "effectCleanupCount",
  "refDetachCount",
]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, keys) {
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...keys].sort();
  return actualKeys.length === expectedKeys.length
    && expectedKeys.every((key, index) => actualKeys[index] === key);
}

function hasExpectedRenderedRows(rows, expectedRows) {
  return Array.isArray(rows)
    && rows.length === expectedRows.length
    && rows.every((row, index) => isPlainObject(row)
      && hasExactKeys(row, ["kind", "rowId"])
      && row.rowId === expectedRows[index]?.rowId
      && row.kind === expectedRows[index]?.kind);
}

function hasExpectedBodyPortals(snapshot, presentRowIds) {
  return isPlainObject(snapshot)
    && hasExactKeys(snapshot, VLIST_LIFECYCLE_ALL_ROW_IDS)
    && VLIST_LIFECYCLE_ALL_ROW_IDS.every((rowId) => snapshot[rowId] === presentRowIds.includes(rowId));
}

function countVListEvents(events, type, rowId) {
  return events.filter((event) => event.type === type && event.rowId === rowId).length;
}

function hasVListEventTrace(events) {
  const eventTypes = new Set([
    "effect-mount",
    "effect-cleanup",
    "ref-attach",
    "ref-detach",
    "body-cleanup",
    "control",
  ]);
  return Array.isArray(events) && events.every((event) => isPlainObject(event)
    && typeof event.type === "string"
    && eventTypes.has(event.type)
    && typeof event.rowId === "string"
    && VLIST_LIFECYCLE_ALL_ROW_IDS.includes(event.rowId)
    && (event.type !== "ref-attach" || typeof event.poolItemId === "string"));
}

function hasExpectedEffectCounts(events) {
  return countVListEvents(events, "effect-mount", VLIST_LIFECYCLE_ROW_IDS[0]) === 2
    && countVListEvents(events, "effect-cleanup", VLIST_LIFECYCLE_ROW_IDS[0]) === 2
    && countVListEvents(events, "effect-mount", VLIST_LIFECYCLE_ROW_IDS[1]) === 1
    && countVListEvents(events, "effect-cleanup", VLIST_LIFECYCLE_ROW_IDS[1]) === 1
    && [...VLIST_LIFECYCLE_STATIC_ROW_IDS, ...VLIST_LIFECYCLE_SCROLL_ROW_IDS].every((rowId) =>
      countVListEvents(events, "effect-mount", rowId) === 1
      && countVListEvents(events, "effect-cleanup", rowId) === 1);
}

function hasExpectedRefIdentity(events) {
  return VLIST_LIFECYCLE_ALL_ROW_IDS.every((rowId) => {
    const mountCount = countVListEvents(events, "effect-mount", rowId);
    return countVListEvents(events, "ref-attach", rowId) === mountCount
      && countVListEvents(events, "ref-detach", rowId) === mountCount;
  })
    && events
      .filter((event) => event.type === "ref-attach")
      .every((event) => event.poolItemId === event.rowId);
}

function hasExpectedStaticRowLifetimes(events) {
  return VLIST_LIFECYCLE_STATIC_ROW_IDS.every((rowId) => countVListEvents(events, "effect-mount", rowId) === 1
    && countVListEvents(events, "effect-cleanup", rowId) === 1
    && countVListEvents(events, "ref-attach", rowId) === 1
    && countVListEvents(events, "ref-detach", rowId) === 1
    && countVListEvents(events, "body-cleanup", rowId) === 1);
}

function hasExpectedTransitions(transitions) {
  return Array.isArray(transitions)
    && transitions.length === VLIST_LIFECYCLE_TRANSITIONS.length
    && transitions.every((transition, index) => isPlainObject(transition)
      && hasExactKeys(transition, VLIST_LIFECYCLE_TRANSITION_KEYS)
      && transition.cause === VLIST_LIFECYCLE_TRANSITIONS[index]?.cause
      && JSON.stringify(transition.visibleRowIdsBefore)
        === JSON.stringify(VLIST_LIFECYCLE_TRANSITIONS[index]?.visibleRowIdsBefore)
      && JSON.stringify(transition.visibleRowIdsAfter)
        === JSON.stringify(VLIST_LIFECYCLE_TRANSITIONS[index]?.visibleRowIdsAfter)
      && hasExpectedTransitionPhases(transition));
}

function hasExpectedTransitionPhases(transition) {
  const outgoingRowIds = transition.visibleRowIdsBefore.filter(
    (rowId) => !transition.visibleRowIdsAfter.includes(rowId),
  );
  const incomingRowIds = transition.visibleRowIdsAfter.filter(
    (rowId) => !transition.visibleRowIdsBefore.includes(rowId),
  );
  const phaseNames = [
    "beforeReactPreUnmount",
    "afterReactPreUnmountBeforeVListPhase2",
    "afterVListPhase2",
  ];
  if (!phaseNames.every((phaseName) => Array.isArray(transition[phaseName])
    && transition[phaseName].length === outgoingRowIds.length
    && transition[phaseName].every((row, index) => isPlainObject(row)
      && hasExactKeys(row, VLIST_LIFECYCLE_TRANSITION_ROW_KEYS)
      && row.rowId === outgoingRowIds[index]
      && typeof row.poolHostToken === "string"
      && Number.isSafeInteger(row.effectCleanupCount)
      && Number.isSafeInteger(row.refDetachCount)))) return false;

  if (!Array.isArray(transition.incomingRowsAfterVListPhase2)
    || transition.incomingRowsAfterVListPhase2.length !== incomingRowIds.length
    || !transition.incomingRowsAfterVListPhase2.every((row, index) => isPlainObject(row)
      && hasExactKeys(row, ["rowId", "poolHostToken"])
      && row.rowId === incomingRowIds[index]
      && typeof row.poolHostToken === "string")) return false;

  return outgoingRowIds.every((_, index) => {
    const before = transition.beforeReactPreUnmount[index];
    const afterPreUnmount = transition.afterReactPreUnmountBeforeVListPhase2[index];
    const afterPhase2 = transition.afterVListPhase2[index];
    return before.portalHostConnected === true
      && afterPreUnmount.portalHostConnected === true
      && afterPhase2.portalHostConnected === false
      && afterPreUnmount.poolHostToken === before.poolHostToken
      && afterPhase2.poolHostToken === before.poolHostToken
      && afterPreUnmount.effectCleanupCount === before.effectCleanupCount + 1
      && afterPreUnmount.refDetachCount === before.refDetachCount + 1
      && afterPhase2.effectCleanupCount === afterPreUnmount.effectCleanupCount
      && afterPhase2.refDetachCount === afterPreUnmount.refDetachCount;
  });
}

function hasExpectedPoolHostIdentity(transitions) {
  if (!hasExpectedTransitions(transitions)) return false;
  const setItemTransitions = transitions.filter(({ cause }) => cause === "set-items");
  if (!setItemTransitions.every((transition) => transition.beforeReactPreUnmount.every((row, index) =>
    row.poolHostToken === transition.incomingRowsAfterVListPhase2[index]?.poolHostToken))) return false;

  const nativeScrollTransitions = transitions.filter(({ cause }) => cause === "native-scroll");
  const firstOutgoingTokens = nativeScrollTransitions[0].beforeReactPreUnmount
    .map(({ poolHostToken }) => poolHostToken)
    .sort();
  const recycledIncomingTokens = nativeScrollTransitions[1].incomingRowsAfterVListPhase2
    .map(({ poolHostToken }) => poolHostToken)
    .sort();
  return JSON.stringify(firstOutgoingTokens) === JSON.stringify(recycledIncomingTokens);
}

function hasExpectedPrependBehavior(prepend) {
  const expectedVisibleRowIds = VLIST_LIFECYCLE_SCROLL_ROW_IDS.slice(4, 8);
  return isPlainObject(prepend)
    && hasExactKeys(prepend, [
      "anchorRowId",
      "anchorTopBefore",
      "anchorTopAfter",
      "draftBefore",
      "draftAfter",
      "effectMountCountBefore",
      "effectMountCountAfter",
      "refAttachCountBefore",
      "refAttachCountAfter",
      "portalHostTokenBefore",
      "portalHostTokenAfter",
      "visibleRowIdsAfter",
    ])
    && prepend.anchorRowId === VLIST_LIFECYCLE_SCROLL_ROW_IDS[4]
    && Number.isFinite(prepend.anchorTopBefore)
    && Number.isFinite(prepend.anchorTopAfter)
    && Math.abs(prepend.anchorTopAfter - prepend.anchorTopBefore) <= 1
    && prepend.draftBefore === "edited-before-prepend"
    && prepend.draftAfter === "edited-before-prepend"
    && prepend.effectMountCountBefore === 1
    && prepend.effectMountCountAfter === 1
    && prepend.refAttachCountBefore === 1
    && prepend.refAttachCountAfter === 1
    && typeof prepend.portalHostTokenBefore === "string"
    && prepend.portalHostTokenAfter === prepend.portalHostTokenBefore
    && JSON.stringify(prepend.visibleRowIdsAfter) === JSON.stringify(expectedVisibleRowIds);
}

/** Derives the lifecycle gate from raw browser facts returned by the vlist probe. */
export function deriveVListLifecycleGate(facts) {
  const rawFactsPresent = isPlainObject(facts)
    && isPlainObject(facts.renderedRows)
    && isPlainObject(facts.values)
    && isPlainObject(facts.values.a)
    && isPlainObject(facts.values.b)
    && isPlainObject(facts.focus)
    && isPlainObject(facts.bodyPortals)
    && isPlainObject(facts.prepend)
    && Array.isArray(facts.transitions)
    && hasVListEventTrace(facts.events);
  const events = rawFactsPresent ? facts.events : [];
  const renderedRows = rawFactsPresent ? facts.renderedRows : {};
  const values = rawFactsPresent ? facts.values : {};
  const focus = rawFactsPresent ? facts.focus : {};
  const bodyPortals = rawFactsPresent ? facts.bodyPortals : {};
  const transitions = rawFactsPresent ? facts.transitions : [];
  const checks = {
    heterogeneousRows: rawFactsPresent
      && hasExpectedRenderedRows(renderedRows.afterA, VLIST_LIFECYCLE_RENDERED_ROWS.afterA)
      && hasExpectedRenderedRows(renderedRows.afterAToB, VLIST_LIFECYCLE_RENDERED_ROWS.afterAToB)
      && hasExpectedRenderedRows(renderedRows.afterBToA, VLIST_LIFECYCLE_RENDERED_ROWS.afterBToA)
      && hasExpectedRenderedRows(renderedRows.beforeNativeScroll, VLIST_LIFECYCLE_RENDERED_ROWS.beforeNativeScroll)
      && hasExpectedRenderedRows(renderedRows.afterFirstNativeScroll, VLIST_LIFECYCLE_RENDERED_ROWS.afterFirstNativeScroll)
      && hasExpectedRenderedRows(renderedRows.afterNativeScrollRecycle, VLIST_LIFECYCLE_RENDERED_ROWS.afterNativeScrollRecycle),
    stableLogicalIdentity: rawFactsPresent && hasExpectedTransitions(transitions),
    stateDoesNotTransfer: rawFactsPresent
      && values.a.draftAfterEdit === "edited-A"
      && values.a.buttonAfterClick === "Assistant message A action 1"
      && values.b.draftBeforeFocus === "draft-B"
      && values.b.buttonBeforeClick === "Narrative flow B action 0"
      && values.b.buttonAfterClick === "Narrative flow B action 1"
      && values.a.draftAfterReturn === "draft-A"
      && values.a.buttonAfterReturn === "Assistant message A action 0",
    effectsCleanUpExactlyOnce: rawFactsPresent && hasExpectedEffectCounts(events),
    refsMatchLogicalRows: rawFactsPresent && hasExpectedRefIdentity(events),
    documentBodyPortalsCleanUp: rawFactsPresent
      && hasExpectedBodyPortals(bodyPortals.afterA, VLIST_LIFECYCLE_RENDERED_ROWS.afterA.map(({ rowId }) => rowId))
      && hasExpectedBodyPortals(bodyPortals.afterAToB, VLIST_LIFECYCLE_RENDERED_ROWS.afterAToB.map(({ rowId }) => rowId))
      && hasExpectedBodyPortals(bodyPortals.afterBToA, VLIST_LIFECYCLE_RENDERED_ROWS.afterBToA.map(({ rowId }) => rowId))
      && hasExpectedBodyPortals(bodyPortals.afterDispose, []),
    focusAndControlsRemainCorrect: rawFactsPresent
      && focus.afterAFocus?.activeProbeInputRowId === VLIST_LIFECYCLE_ROW_IDS[0]
      && focus.afterAToB?.previousInputConnected === false
      && focus.afterAToB?.previousInputActive === false
      && focus.afterAToB?.activeProbeInputRowId !== VLIST_LIFECYCLE_ROW_IDS[1]
      && focus.afterBFocus?.activeProbeInputRowId === VLIST_LIFECYCLE_ROW_IDS[1]
      && focus.afterBToA?.previousInputConnected === false
      && focus.afterBToA?.previousInputActive === false
      && focus.afterBToA?.activeProbeInputRowId !== VLIST_LIFECYCLE_ROW_IDS[0],
    controlsDispatchToDisplayedRow: rawFactsPresent
      && countVListEvents(events, "control", VLIST_LIFECYCLE_ROW_IDS[0]) === 1
      && countVListEvents(events, "control", VLIST_LIFECYCLE_ROW_IDS[1]) === 1,
    poolHostIdentity: rawFactsPresent && hasExpectedPoolHostIdentity(transitions),
    reactCleanupPrecedesVListPhase2: rawFactsPresent && hasExpectedTransitions(transitions),
    staticRowsStableAcrossTransitions: rawFactsPresent && hasExpectedStaticRowLifetimes(events),
    nativeScrollRecyclesHosts: rawFactsPresent
      && hasExpectedTransitions(transitions)
      && transitions.filter(({ cause }) => cause === "native-scroll").length === 2,
    prependPreservesAnchorAndIdentity: rawFactsPresent && hasExpectedPrependBehavior(facts.prepend),
  };
  const failures = rawFactsPresent ? [] : ["expected raw vlist lifecycle facts and event trace"];
  for (const [name, passed] of Object.entries(checks)) {
    if (!passed) failures.push(`vlist lifecycle assertion failed: ${name}`);
  }
  const lifecyclePassed = VLIST_LIFECYCLE_CHECK_NAMES.every((name) => checks[name] === true);
  return {
    checks,
    lifecycleGate: {
      passed: lifecyclePassed,
      failure: lifecyclePassed ? null : failures[0] ?? "vlist lifecycle assertions did not pass.",
    },
    gateDecision: lifecyclePassed
      ? {
          status: "accepted",
          candidateEligible: true,
          reason: null,
        }
      : {
          status: "invalid",
          candidateEligible: false,
          reason: failures[0] ?? "vlist lifecycle assertions did not pass.",
        },
    failures,
  };
}

/** Returns failures when raw vlist lifecycle facts do not satisfy the lifecycle contract. */
export function validateVListLifecycleFacts(facts) {
  return deriveVListLifecycleGate(facts).failures;
}

function assertBoundedDuration(value) {
  if (!Number.isFinite(value) || value < 0 || value > MAX_SHIKI_DURATION_MS) {
    throw new TypeError(
      `Shiki durations must be finite non-negative numbers at most ${MAX_SHIKI_DURATION_MS}ms`,
    );
  }
}

function assertBoundedResponseBytes(value) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_SHIKI_RESPONSE_BYTES
  ) {
    throw new TypeError(
      `Shiki response bytes must be finite non-negative safe integers at most ${MAX_SHIKI_RESPONSE_BYTES}`,
    );
  }
}

/** Returns failures for bounded, performance-only MessageList timing observations. */
export function validateMessageListPerformanceAttribution(observations) {
  if (!Array.isArray(observations)) return ["expected MessageList performance observations"];
  const stages = new Set();
  for (const observation of observations) {
    if (!isPlainObject(observation)) return ["MessageList performance observation is not an object"];
    if (!MESSAGE_LIST_PERFORMANCE_STAGE_NAMES.includes(observation.stage)) {
      return ["MessageList performance observation has an unknown stage"];
    }
    if (!Number.isFinite(observation.durationMs) || observation.durationMs < 0 || observation.durationMs > 60_000) {
      return ["MessageList performance observation has an invalid duration"];
    }
    stages.add(observation.stage);
  }
  return MESSAGE_LIST_PERFORMANCE_STAGE_NAMES
    .filter((stage) => !stages.has(stage))
    .map((stage) => `missing MessageList performance stage: ${stage}`);
}

/** Aggregates accepted MessageList timings by narrow, named stage. */
export function aggregateMessageListPerformanceAttribution(observationSamples) {
  if (!Array.isArray(observationSamples)) {
    throw new TypeError("MessageList performance samples must be an array");
  }
  const durationsByStage = Object.fromEntries(
    MESSAGE_LIST_PERFORMANCE_STAGE_NAMES.map((stage) => [stage, []]),
  );
  for (const observations of observationSamples) {
    if (!Array.isArray(observations)) {
      throw new TypeError("Each MessageList performance sample must be an array");
    }
    for (const observation of observations) {
      if (!isPlainObject(observation)
        || !MESSAGE_LIST_PERFORMANCE_STAGE_NAMES.includes(observation.stage)
        || !Number.isFinite(observation.durationMs)
        || observation.durationMs < 0
        || observation.durationMs > MAX_SHIKI_DURATION_MS) {
        throw new TypeError("MessageList performance observation is invalid");
      }
      durationsByStage[observation.stage].push(observation.durationMs);
    }
  }
  return Object.fromEntries(
    MESSAGE_LIST_PERFORMANCE_STAGE_NAMES.map((stage) => [
      stage,
      summarizeDurationSamples(durationsByStage[stage]),
    ]),
  );
}

/** Returns every finite Chromium long task over 50ms with its captured sample index. */
export function extractShikiLongTasks(longTasksMs, sampleIndex) {
  if (!Array.isArray(longTasksMs) || !Number.isSafeInteger(sampleIndex) || sampleIndex < 0) {
    throw new TypeError("Shiki long tasks require an array and a non-negative sample index");
  }
  return longTasksMs
    .filter((durationMs) => Number.isFinite(durationMs) && durationMs > 50)
    .map((durationMs) => ({ sampleIndex, durationMs }));
}

function summarizeValues(values, unit) {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (quantile) => sorted[Math.ceil(sorted.length * quantile) - 1];
  const suffix = unit === "bytes" ? "Bytes" : "Ms";
  return {
    sampleCount: sorted.length,
    [`min${suffix}`]: sorted[0],
    [`median${suffix}`]: percentile(0.5),
    [`p95${suffix}`]: percentile(0.95),
    [`max${suffix}`]: sorted.at(-1),
  };
}

/**
 * Aggregates bounded, phase-labelled Shiki stage observations for one build mode.
 * Production leaves React-derived stages null because the fixture duration is a whole workload, not a request boundary.
 */
export function aggregateShikiStageAttribution(observations, buildMode = "profiling") {
  if (!Array.isArray(observations) || observations.length === 0) {
    throw new TypeError("Shiki stage observations must be a non-empty array");
  }
  if (!SHIKI_BUILD_MODES.includes(buildMode)) {
    throw new TypeError("Shiki build mode must be profiling or production");
  }
  const samples = Array.isArray(observations[0]) ? observations : [observations];
  const observationCount = samples.reduce((count, sample) => count + sample.length, 0);
  if (observationCount > MAX_SHIKI_STAGE_OBSERVATIONS) {
    throw new RangeError(
      `Shiki stage observations are limited to ${MAX_SHIKI_STAGE_OBSERVATIONS} entries`,
    );
  }

  const stagesByPhase = Object.fromEntries(
    SHIKI_PHASES.map((phase) => [
      phase,
      Object.fromEntries(SHIKI_DURATION_STAGE_NAMES.map((name) => [name, []])),
    ]),
  );
  const workloadStages = Object.fromEntries(["style", "layout"].map((stage) => [stage, []]));
  const responseBytesByPhase = Object.fromEntries(SHIKI_PHASES.map((phase) => [phase, []]));
  const seenStages = new Set();
  const stageObservationsOver50Ms = [];
  const sampleStageTotals = [];

  for (const sample of samples) {
    if (!Array.isArray(sample) || sample.length === 0) {
      throw new TypeError("Each Shiki sample must contain observations");
    }
    const sampleStages = {};
    const sampleSeenStages = new Set();
    const sampleStagePhases = Object.fromEntries(
      SHIKI_STAGE_NAMES.map((stage) => [stage, new Set()]),
    );
    for (const observation of sample) {
      if (!isPlainObject(observation)) {
        throw new TypeError("Each Shiki stage observation must be an object");
      }
      const { phase, stage } = observation;
      if (!SHIKI_PHASES.includes(phase) && phase !== SHIKI_WORKLOAD_PHASE) {
        throw new TypeError("Shiki stage observation phase must be cold, warm, or workload");
      }
      if (!SHIKI_STAGE_NAMES.includes(stage)) {
        throw new TypeError(`Unknown Shiki stage: ${String(stage)}`);
      }
      if (buildMode === "production" && SHIKI_RENDERER_STAGES.includes(stage)) {
        if (!hasExactKeys(observation, ["durationMs", "phase", "stage"])) {
          throw new TypeError("Production renderer observations must contain only phase, stage, and durationMs");
        }
        assertBoundedDuration(observation.durationMs);
        continue;
      }
      if ((stage === "style" || stage === "layout") && phase !== SHIKI_WORKLOAD_PHASE) {
        throw new TypeError("Style and layout observations must use the workload phase");
      }
      seenStages.add(stage);
      sampleSeenStages.add(stage);
      sampleStagePhases[stage].add(phase);
      if (stage === "responseBytes") {
        if (phase === SHIKI_WORKLOAD_PHASE) {
          throw new TypeError("Workload Shiki observations cannot contain response bytes");
        }
        if (!hasExactKeys(observation, ["bytes", "phase", "stage"])) {
          throw new TypeError("Response byte observations must contain only phase, stage, and bytes");
        }
        assertBoundedResponseBytes(observation.bytes);
        responseBytesByPhase[phase].push(observation.bytes);
        continue;
      }

      if (phase === SHIKI_WORKLOAD_PHASE) {
        if ((stage !== "style" && stage !== "layout") ||
          !hasExactKeys(observation, ["durationMs", "phase", "stage"])) {
          throw new TypeError("Workload observations must contain only style or layout duration data");
        }
        assertBoundedDuration(observation.durationMs);
        workloadStages[stage].push(observation.durationMs);
      } else {
        if (!hasExactKeys(observation, ["durationMs", "phase", "stage"])) {
          throw new TypeError("Duration observations must contain only phase, stage, and durationMs");
        }
        assertBoundedDuration(observation.durationMs);
        stagesByPhase[phase][stage].push(observation.durationMs);
      }
      sampleStages[stage] = (sampleStages[stage] ?? 0) + observation.durationMs;
      if (observation.durationMs > 50) {
        stageObservationsOver50Ms.push({ phase, stage, durationMs: observation.durationMs });
      }
    }
    for (const stage of SHIKI_WORKER_STAGES) {
      if (!sampleSeenStages.has(stage)) {
        throw new TypeError(`Each Shiki sample must include ${stage}`);
      }
      if (!sampleStagePhases[stage].has("cold") ||
        (stage !== "workerStartup" && !sampleStagePhases[stage].has("warm"))) {
        throw new TypeError(`Each Shiki sample must include complete cold and warm ${stage} observations`);
      }
    }
    if (buildMode === "profiling") {
      for (const stage of SHIKI_RENDERER_STAGES) {
        if (!sampleSeenStages.has(stage)) {
          throw new TypeError(`Each profiling Shiki sample must include ${stage}`);
        }
      }
    } else {
      for (const stage of ["style", "layout"]) {
        if (!sampleSeenStages.has(stage)) {
          throw new TypeError(`Each production Shiki sample must include workload ${stage}`);
        }
      }
    }
    sampleStageTotals.push(sampleStages);
  }

  const requiredStages = buildMode === "profiling"
    ? [...SHIKI_WORKER_STAGES, ...SHIKI_RENDERER_STAGES]
    : [...SHIKI_WORKER_STAGES, "style", "layout"];
  const missingStages = requiredStages.filter((stage) => !seenStages.has(stage));
  if (missingStages.length > 0) {
    throw new TypeError(`Missing Shiki stage observations: ${missingStages.join(", ")}`);
  }
  if (SHIKI_PHASES.some((phase) => stagesByPhase[phase] && responseBytesByPhase[phase].length === 0)) {
    throw new TypeError("Shiki stage observations must include cold and warm phases");
  }

  const stages = Object.fromEntries(
    SHIKI_PHASES.map((phase) => [
      phase,
      Object.fromEntries(
        SHIKI_DURATION_STAGE_NAMES.map((name) => [
          name,
          stagesByPhase[phase][name].length > 0
            ? summarizeValues(stagesByPhase[phase][name], "ms")
            : null,
        ]),
      ),
    ]),
  );
  const workload = Object.fromEntries(
    Object.entries(workloadStages).map(([stage, values]) => [
      stage,
      values.length > 0 ? summarizeValues(values, "ms") : null,
    ]),
  );
  const responseBytes = Object.fromEntries(
    SHIKI_PHASES.map((phase) => [
      phase,
      summarizeValues(responseBytesByPhase[phase], "bytes"),
    ]),
  );

  const largestStage = SHIKI_DURATION_STAGE_NAMES
    .filter((stage) => stage !== "totalCompletion")
    .map((stage) => {
      const sampleTotals = sampleStageTotals
        .map((totals) => totals[stage])
        .filter((durationMs) => Number.isFinite(durationMs));
      if (sampleTotals.length === 0) return null;
      return {
        stage,
        medianMs: summarizeValues(sampleTotals, "ms").medianMs,
        sampleTotals,
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.medianMs - left.medianMs)[0] ?? null;

  return {
    buildMode,
    stages,
    workload,
    responseBytes,
    largestStage: largestStage?.stage ?? null,
    largestStageObservation: largestStage,
    stageObservationsOver50Ms,
  };
}

async function waitForFrames(page, count = 2) {
  await page.bringToFront();
  return page.evaluate(async (frameCount) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }, count);
}

async function installFixtureRuntime(page) {
  await page.waitForFunction(
    () => Boolean(window.__mcodeFrontendPerformanceModules),
    null,
    { timeout: 30_000 },
  );
  await page.waitForFunction(
    () =>
      (window.__mcodeFrontendPerformanceModules?.workspaceStore.getState()
        .workspaces.length ?? 0) > 0,
    null,
    { timeout: 30_000 },
  );
  await page.evaluate(async () => {
    const modules = window.__mcodeFrontendPerformanceModules;
    if (!modules) throw new Error("The compiled performance fixture bridge is unavailable.");
    const workspaceStore = modules.workspaceStore;
    const threadStore = modules.threadStore;
    const diffStore = modules.diffStore;
    const workspace = workspaceStore.getState().workspaces[0];
    if (!workspace) throw new Error("The performance fixture needs one seeded workspace.");

    const now = "2026-08-09T21:00:00.000Z";
    const baseThread = (id, title) => ({
      id,
      workspace_id: workspace.id,
      title,
      status: "idle",
      mode: "local",
      worktree_path: null,
      branch: "main",
      checkout_state: "named",
      base_branch: null,
      worktree_managed: false,
      issue_number: null,
      pr_number: null,
      pr_status: null,
      has_file_changes: false,
      sdk_session_id: null,
      created_at: now,
      updated_at: now,
      model: null,
      provider: "codex",
      deleted_at: null,
      last_context_tokens: null,
      context_window: null,
      reasoning_level: null,
      interaction_mode: null,
      orchestration_mode: null,
      permission_mode: null,
      context_window_mode: null,
      thinking: null,
      codex_fast_mode: null,
      copilot_agent: null,
      default_open_in_app: null,
      parent_thread_id: null,
      forked_from_message_id: null,
      last_compact_summary: null,
    });

    const message = (threadId, index, content, role = index % 2 ? "assistant" : "user") => ({
      id: `${threadId}-message-${index}`,
      thread_id: threadId,
      role,
      content,
      tool_calls: null,
      files_changed: null,
      cost_usd: null,
      tokens_used: null,
      timestamp: now,
      sequence: index + 1,
      attachments: null,
      model: role === "assistant" ? "gpt-5.6" : null,
    });

    const makeMessages = (threadId, count, suffix = "") => Array.from(
      { length: count },
      (_, index) => message(
        threadId,
        index,
        `Fixture message ${index} ${suffix} ${"word ".repeat(30)}`,
      ),
    );

    const emptyNarrativeByMessage = (messages) => Object.fromEntries(
      messages
        .filter((item) => item.role === "assistant")
        .map((item) => [item.id, { tools: [], thoughts: [], hooks: [] }]),
    );

    const activate = (threadId, title, messages, patch = {}) => {
      const thread = baseThread(threadId, title);
      workspaceStore.setState((state) => ({
        ...state,
        activeWorkspaceId: workspace.id,
        activeThreadId: threadId,
        threads: [thread, ...state.threads.filter((item) => item.id !== threadId)],
      }));
      const { narrativeByMessage = {}, ...recordPatch } = patch;
      const record = {
        ...modules.createEmptyThreadRecord(),
        messages,
        oldestLoadedSequence: messages[0]?.sequence ?? 0,
        ...recordPatch,
        narrativeByMessage: {
          ...emptyNarrativeByMessage(messages),
          ...narrativeByMessage,
        },
      };
      threadStore.setState((state) => ({
        ...state,
        currentThreadId: threadId,
        records: new Map(state.records).set(threadId, record),
      }));
    };
    let snapshot = null;
    const takeSnapshot = () => {
      snapshot = {
        workspace: workspaceStore.getState(),
        thread: threadStore.getState(),
        diff: diffStore.getState(),
      };
    };
    const resetSnapshot = () => {
      if (!snapshot) throw new Error("The frontend performance fixture has no snapshot.");
      workspaceStore.setState(snapshot.workspace, true);
      threadStore.setState(snapshot.thread, true);
      diffStore.setState(snapshot.diff, true);
    };

    window.__issue1240 = {
      workspaceId: workspace.id,
      workspaceStore,
      threadStore,
      diffStore,
      recordModule: { createEmptyThreadRecord: modules.createEmptyThreadRecord },
      baseThread,
      message,
      makeMessages,
      emptyNarrativeByMessage,
      activate,
      snapshot: takeSnapshot,
      reset: resetSnapshot,
      revision: 0,
    };
  });
}

async function snapshotFixtureRuntime(page) {
  await page.evaluate(() => {
    const fixture = window.__issue1240;
    if (!fixture) throw new Error("The frontend performance fixture is unavailable.");
    fixture.snapshot();
  });
}

async function resetFixtureRuntime(page) {
  await page.evaluate(() => {
    const fixture = window.__issue1240;
    if (!fixture) throw new Error("The frontend performance fixture is unavailable.");
    fixture.reset();
  });
  await waitForFrames(page);
  await page.evaluate(() => {
    const modules = window.__mcodeFrontendPerformanceModules;
    if (!modules) throw new Error("The compiled performance fixture bridge is unavailable.");
    modules.recordCache.clear();
    modules.scrollMemory.clear();
  });
}

async function timeFixture(page, sampleCount, operation, modeCollector, options = {}) {
  const samples = [];
  const checks = [];
  const attributions = [];
  const captureShiki = options.captureShiki === true;
  const captureMessageListAttribution = options.captureMessageListAttribution !== false;
  await snapshotFixtureRuntime(page);
  try {
    await operation(-1);
  } finally {
    await resetFixtureRuntime(page);
  }
  if (captureMessageListAttribution) {
    await page.evaluate(() => {
      window.__mcodeFrontendPerformanceModules?.messageListPerformance.reset();
    });
  }
  if (captureShiki) {
    await page.evaluate(() => {
      const bridge = window.__mcodeFrontendPerformanceModules?.shikiPerformance;
      bridge?.setCapture(false);
      bridge?.reset();
      bridge?.resetWorker();
    });
  }
  for (let index = 0; index < sampleCount; index += 1) {
    await snapshotFixtureRuntime(page);
    if (captureMessageListAttribution) {
      await page.evaluate(() => {
        window.__mcodeFrontendPerformanceModules?.messageListPerformance.reset();
      });
    }
    if (captureShiki) {
      await page.evaluate(() => {
        const bridge = window.__mcodeFrontendPerformanceModules?.shikiPerformance;
        bridge?.reset();
        bridge?.resetWorker();
        bridge?.setCapture(true);
      });
    }
    let result;
    let attribution;
    try {
      ({ result, attribution } = await modeCollector.measure(
        () => operation(index),
        getShikiTraceOptions(captureShiki, options.buildMode),
      ));
      if (captureShiki) {
        result.check.buildMode = options.buildMode ?? "profiling";
        result.check.shikiAttribution = await page.evaluate(() => {
          const bridge = window.__mcodeFrontendPerformanceModules?.shikiPerformance;
          bridge?.setCapture(false);
          return bridge?.drain() ?? [];
        });
        const trace = attribution.chromium;
        if (Number.isFinite(trace?.styleMs) && trace.styleMs >= 0 && trace.styleMs <= MAX_SHIKI_DURATION_MS) {
          result.check.shikiAttribution.push({
            phase: "workload",
            stage: "style",
            durationMs: trace.styleMs,
          });
        }
        if (Number.isFinite(trace?.layoutMs) && trace.layoutMs >= 0 && trace.layoutMs <= MAX_SHIKI_DURATION_MS) {
          result.check.shikiAttribution.push({
            phase: "workload",
            stage: "layout",
            durationMs: trace.layoutMs,
          });
        }
        result.check.shikiLongTasksOver50Ms = extractShikiLongTasks(trace?.longTasksMs ?? [], index);
      }
      if (captureMessageListAttribution) {
        attribution.messageList = await page.evaluate(() =>
          window.__mcodeFrontendPerformanceModules?.messageListPerformance.drain() ?? [],
        );
      }
      samples.push(result.durationMs);
      checks.push(result.check);
      attributions.push(attribution);
    } finally {
      if (index !== sampleCount - 1 || options.deferFinalReset !== true) {
        await resetFixtureRuntime(page);
      }
    }
  }
  return { samples, checks, attributions };
}

/** Returns trace collection options only for production Shiki attribution. */
export function getShikiTraceOptions(captureShiki, buildMode) {
  return captureShiki && buildMode === "production" ? { trace: true } : undefined;
}

/** Returns correctness failures for one workload observation. */
export function validateWorkloadCheck(workload, check, buildMode = check?.buildMode ?? "profiling") {
  const failures = [];
  const requireCheck = (condition, message) => {
    if (!condition) failures.push(message);
  };

  switch (workload) {
    case "message100":
    case "message1000": {
      const expectedCount = workload === "message100" ? 100 : 1_000;
      requireCheck(check.totalMessages === expectedCount, `expected ${expectedCount} messages`);
      requireCheck(check.mountedMessages > 0, "expected visible message rows");
      requireCheck(
        check.mountedMessages <= MAX_MOUNTED_MESSAGE_ROWS,
        `virtualized message rows exceeded ${MAX_MOUNTED_MESSAGE_ROWS}`,
      );
      requireCheck(
        check.activeThreadId === check.currentThreadId &&
          check.currentThreadId === check.visibleThreadId,
        "selected and visible thread identities differ",
      );
      break;
    }
    case "threadSwitch":
      requireCheck(
        Boolean(check.activeThreadId) &&
          check.activeThreadId === check.currentThreadId &&
          check.currentThreadId === check.visibleThreadId,
        "resident thread switch selected the wrong thread",
      );
      break;
    case "streaming":
      requireCheck(check.streamingText === check.expectedText, "streamed response text differs");
      requireCheck(check.storeUpdateCommits === 200, "streaming updates were batched before the store commit");
      requireCheck(check.visibleStreamingUpdates === 200, "streaming did not visibly commit 200 updates");
      requireCheck(check.visualStreamingCommitted === true, "streaming content did not commit to the rendered response");
      requireCheck(check.tailFollowed === true, "streaming did not keep the tail in view");
      requireCheck(check.userAwayPreserved === true, "streaming moved a user who left the tail");
      break;
    case "messageListBehavior":
      requireCheck(check.longThreadScroll === true, "long-thread scroll did not change the visible range");
      requireCheck(check.dynamicHeightSettled === true, "dynamic row height did not settle at the tail");
      requireCheck(check.olderHistoryLoaded === true, "older history did not load a page");
      requireCheck(check.olderHistoryAnchor === true, "older history changed the reading anchor");
      requireCheck(check.newerHistoryLoaded === true, "newer history did not load a page");
      requireCheck(check.newerHistoryAnchor === true, "newer history changed the reading anchor");
      requireCheck(check.cacheHitThreadIdentity === true, "cache-hit switch did not change the visible thread");
      requireCheck(check.cacheHitRestored === true, "cache-hit switch did not restore the reading position");
      requireCheck(check.cacheMissThreadIdentity === true, "cache-miss switch did not change the visible thread");
      requireCheck(check.cacheMissLoadingObserved === true, "cache-miss did not hold the outgoing transcript while empty");
      requireCheck(check.cacheMissRestored === true, "cache-miss did not render the restored client record");
      requireCheck(check.cacheMissTailPositioned === true, "cache-miss did not position the restored transcript at the tail");
      requireCheck(check.stickyAbsentWhenUserVisible === true, "sticky user message remained visible beside its transcript row");
      requireCheck(check.stickyVisible === true, "sticky user message did not appear");
      requireCheck(check.stickyTargetWasUnmountedBeforeJump === true, "sticky user target stayed mounted before jump");
      requireCheck(check.stickyUserJumped === true, "sticky user message did not jump to its transcript row");
      requireCheck(check.focusPreserved === true, "sticky user-message control did not receive focus");
      requireCheck(check.interactiveControl === true, "sticky user-message control did not expand");
      requireCheck(check.liveToPersistedIdentity === true, "live response did not retain its persisted row identity");
      break;
    case "denseNarrative":
      requireCheck(check.sourceRows === 90, "dense narrative fixture row count differs");
      requireCheck(check.descendants < 500, "dense narrative viewport exceeded 499 descendants");
      requireCheck(check.browseDescendants < 500, "dense narrative browser exceeded 499 descendants");
      requireCheck(check.browsed === true, "dense narrative browser did not reach every page");
      requireCheck(check.returnedToSummary === true, "dense narrative browser did not return to summary");
      requireCheck(check.visible === true, "dense narrative message is not visible");
      requireCheck(check.assistantVisible === true, "dense narrative response content is missing");
      requireCheck(check.thoughtVisible === true, "dense narrative thought content is missing");
      requireCheck(check.lastThoughtVisible === true, "dense narrative final thought is missing");
      requireCheck(check.toolVisible === true, "dense narrative tool content is missing");
      requireCheck(check.lastToolVisible === true, "dense narrative final tool is missing");
      requireCheck(check.hookVisible === true, "dense narrative hook content is missing");
      break;
    case "markdownShiki":
      requireCheck(check.codeBlocks === 10, "expected 10 Markdown code blocks");
      requireCheck(check.highlightedBlocks === 10, "expected 10 highlighted code blocks");
      requireCheck(check.plainFallbackObserved === true, "expected plain fallback before highlight completion");
      requireCheck(check.themeClassAndStyle === true, "expected Shiki theme class and style");
      requireCheck(check.copyButtonsAccessible === true, "expected accessible copy buttons");
      requireCheck(check.semanticCodeBlocks === true, "expected semantic pre/code elements");
      requireCheck(check.highlightedContent === true, "expected highlighted code content");
      requireCheck(check.horizontalOverflow === true, "expected horizontal code overflow to remain scrollable");
      requireCheck(check.textSelection === true, "expected highlighted code text selection");
      if (buildMode === "production") {
        requireCheck(
          Array.isArray(check.shikiLongTasksOver50Ms),
          "expected Chromium long-task observations",
        );
      }
      try {
        aggregateShikiStageAttribution(check.shikiAttribution, buildMode);
      } catch {
        failures.push("expected Shiki stage attribution");
      }
      break;
    case "panelTransitions":
      requireCheck(check.visible === true, "right panel is closed");
      requireCheck(check.activeTab === "terminal", "Terminal is not the active panel");
      requireCheck(check.browserTabOpen === true, "Browser panel did not stay open");
      requireCheck(check.terminalTabOpen === true, "Terminal panel is not open");
      requireCheck(check.terminalShell === true, "Terminal surface is missing");
      break;
    case "vlistLifecycle":
      failures.push(...validateVListLifecycleFacts(check));
      break;
    default:
      failures.push(`unknown workload: ${workload}`);
  }
  return failures;
}

/** Returns profiling failures for one measured narrative-row update. */
export function validateNarrativeRowIsolation(reactAttribution) {
  if (!reactAttribution) return [];
  const failures = [];
  if (reactAttribution.affectedRow?.renderCount !== 1) {
    failures.push("expected the affected narrative row to render once");
  }
  const renderedSibling = reactAttribution.stableSiblingRows.find(
    (row) => row.renderCount !== 0,
  );
  if (renderedSibling) {
    failures.push(`stable narrative row rendered: ${renderedSibling.rowId}`);
  }
  return failures;
}

/** Run the shared frontend renderer matrix against one Playwright page. */
export async function runRendererMatrix(page, runtime, sampleCount = 7, mode = "production", options = {}) {
  if (!Number.isSafeInteger(sampleCount) || sampleCount < 1 || sampleCount > 50) {
    throw new Error("sampleCount must be an integer from 1 through 50");
  }
  const workloads = normalizeFrontendRendererWorkloads(options.workload ?? null);
  const selectedWorkloads = new Set(workloads);
  const expectedPageUrl = page.url();
  await page.bringToFront();
  await installFixtureRuntime(page);
  const signalCollector = await createPageSignalCollector(page);
  const modeCollector = await createModeSignalCollector(page, mode);

  const message100 = selectedWorkloads.has("message100")
    ? await timeFixture(page, sampleCount, async (sample) => {
    const result = await page.evaluate(async (sampleIndex) => {
      const fixture = window.__issue1240;
      const revision = ++fixture.revision;
      const threadId = `perf-message-100-${revision}`;
      const startedAt = performance.now();
      fixture.activate(
        threadId,
        `Message 100 sample ${sampleIndex}`,
        fixture.makeMessages(threadId, 100, String(revision)),
      );
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const list = document.querySelector('[data-testid="message-list"]');
      return {
        durationMs: performance.now() - startedAt,
        check: {
          activeThreadId: fixture.workspaceStore.getState().activeThreadId,
          currentThreadId: fixture.threadStore.getState().currentThreadId,
          mountedMessages: list?.querySelectorAll("[data-message-id]").length ?? 0,
          descendants: list?.querySelectorAll("*").length ?? 0,
          totalMessages: fixture.threadStore.getState().records.get(threadId)?.messages.length ?? 0,
          visibleThreadId: list
            ?.querySelector("[data-message-id]")
            ?.getAttribute("data-thread-id") ?? null,
        },
      };
    }, sample);
    return result;
    }, modeCollector)
    : null;

  const message1000 = selectedWorkloads.has("message1000")
    ? await timeFixture(page, sampleCount, async (sample) => {
    return page.evaluate(async (sampleIndex) => {
      const fixture = window.__issue1240;
      const revision = ++fixture.revision;
      const threadId = `perf-message-1000-${revision}`;
      const startedAt = performance.now();
      fixture.activate(
        threadId,
        `Message 1000 sample ${sampleIndex}`,
        fixture.makeMessages(threadId, 1000, String(revision)),
      );
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const list = document.querySelector('[data-testid="message-list"]');
      return {
        durationMs: performance.now() - startedAt,
        check: {
          activeThreadId: fixture.workspaceStore.getState().activeThreadId,
          currentThreadId: fixture.threadStore.getState().currentThreadId,
          mountedMessages: list?.querySelectorAll("[data-message-id]").length ?? 0,
          descendants: list?.querySelectorAll("*").length ?? 0,
          totalMessages: fixture.threadStore.getState().records.get(threadId)?.messages.length ?? 0,
          visibleThreadId: list
            ?.querySelector("[data-message-id]")
            ?.getAttribute("data-thread-id") ?? null,
        },
      };
    }, sample);
    }, modeCollector)
    : null;

  const threadSwitch = selectedWorkloads.has("threadSwitch")
    ? await timeFixture(page, sampleCount, async (sample) => {
    return page.evaluate(async (sampleIndex) => {
      const fixture = window.__issue1240;
      const revision = ++fixture.revision;
      const leftId = `perf-switch-left-${revision}`;
      const rightId = `perf-switch-right-${revision}`;
      fixture.activate(leftId, "Switch left", fixture.makeMessages(leftId, 1000, "left"));
      const rightThread = fixture.baseThread(rightId, "Switch right");
      const rightMessages = fixture.makeMessages(rightId, 1000, "right");
      const rightRecord = {
        ...fixture.recordModule.createEmptyThreadRecord(),
        messages: rightMessages,
        oldestLoadedSequence: 1,
        narrativeByMessage: fixture.emptyNarrativeByMessage(rightMessages),
      };
      fixture.workspaceStore.setState((state) => ({
        ...state,
        threads: [rightThread, ...state.threads.filter((item) => item.id !== rightId)],
      }));
      fixture.threadStore.setState((state) => ({
        ...state,
        records: new Map(state.records).set(rightId, rightRecord),
      }));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const startedAt = performance.now();
      fixture.workspaceStore.setState((state) => ({
        ...state,
        activeThreadId: rightId,
      }));
      fixture.threadStore.setState((state) => ({
        ...state,
        currentThreadId: rightId,
      }));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return {
        durationMs: performance.now() - startedAt,
        check: {
          activeThreadId: fixture.workspaceStore.getState().activeThreadId,
          currentThreadId: fixture.threadStore.getState().currentThreadId,
          visibleThreadId: document.querySelector("[data-message-id]")?.getAttribute("data-thread-id") ?? null,
          sampleIndex,
        },
      };
    }, sample);
    }, modeCollector)
    : null;

  const streaming = selectedWorkloads.has("streaming")
    ? await timeFixture(page, sampleCount, async (sample) => {
    return page.evaluate(async (sampleIndex) => {
      const fixture = window.__issue1240;
      const revision = ++fixture.revision;
      const threadId = `perf-stream-${revision}`;
      fixture.activate(threadId, "Streaming fixture", fixture.makeMessages(threadId, 100, "stream"));
      fixture.threadStore.getState().handleAgentEvent({
        type: "turnStarted",
        threadId,
        fileEffectTurnId: `stream-${revision}`,
      });
      const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
      const waitForStreamingCommit = async (expectedText, maxFrames = 8) => {
        for (let frame = 0; frame < maxFrames; frame += 1) {
          if (fixture.threadStore.getState().records.get(threadId)?.streaming === expectedText) return true;
          await nextFrame();
        }
        return fixture.threadStore.getState().records.get(threadId)?.streaming === expectedText;
      };
      const responseKey = fixture.threadStore.getState().records.get(threadId)?.currentTurnResponseKey;
      const waitForVisibleStreamingUpdate = async (expectedToken, maxFrames = 8) => {
        if (typeof responseKey !== "string" || responseKey.length === 0) return false;
        for (let frame = 0; frame < maxFrames; frame += 1) {
          const message = document.querySelector(`[data-message-id="${responseKey}"]`);
          if (message?.textContent?.includes(expectedToken)) return true;
          await nextFrame();
        }
        return document.querySelector(`[data-message-id="${responseKey}"]`)
          ?.textContent?.includes(expectedToken) ?? false;
      };
      let storeUpdateCommits = 0;
      let visibleStreamingUpdates = 0;
      const unsubscribe = fixture.threadStore.subscribe((state, previousState) => {
        const currentText = state.records.get(threadId)?.streaming;
        const previousText = previousState.records.get(threadId)?.streaming;
        if (currentText !== previousText) storeUpdateCommits += 1;
      });
      const startedAt = performance.now();
      let expectedText = "";
      for (let index = 0; index < 200; index += 1) {
        const delta = `token-${index} `;
        expectedText += delta;
        fixture.threadStore.getState().handleAgentEvent({
          type: "textDelta",
          threadId,
          delta,
          isFinalResponse: true,
        });
        await waitForStreamingCommit(expectedText);
        if (await waitForVisibleStreamingUpdate(delta)) visibleStreamingUpdates += 1;
      }
      const visualStreamingCommitted = await waitForStreamingCommit(expectedText)
        && typeof responseKey === "string"
        && responseKey.length > 0
        && await (async () => {
          for (let frame = 0; frame < 8; frame += 1) {
            const message = document.querySelector(`[data-message-id="${responseKey}"]`);
            if (message?.textContent?.includes("token-199")) return true;
            await nextFrame();
          }
          return false;
        })();
      unsubscribe();
      const list = document.querySelector('[data-testid="message-list"]')?.firstElementChild;
      const tailFollowed = list instanceof HTMLElement
        && Math.abs(list.scrollHeight - list.scrollTop - list.clientHeight) <= 4;
      const awayTop = list instanceof HTMLElement
        ? Math.max(0, list.scrollHeight - list.clientHeight - 400)
        : 0;
      if (list instanceof HTMLElement) {
        list.scrollTop = awayTop;
        list.dispatchEvent(new Event("scroll", { bubbles: true }));
      }
      fixture.threadStore.getState().handleAgentEvent({
        type: "textDelta",
        threadId,
        delta: "away-token ",
        isFinalResponse: true,
      });
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const record = fixture.threadStore.getState().records.get(threadId);
      return {
        durationMs: performance.now() - startedAt,
        check: {
          expectedText,
          streamingText: (record?.streaming ?? "").replace(/away-token $/, ""),
          storeUpdateCommits,
          visibleStreamingUpdates,
          visualStreamingCommitted,
          tailFollowed,
          userAwayPreserved: list instanceof HTMLElement
            && list.scrollTop <= awayTop + 2
            && document.querySelector('button[aria-label="New messages below"]') !== null,
          sampleIndex,
        },
      };
    }, sample);
    }, modeCollector)
    : null;

  const messageListBehavior = selectedWorkloads.has("messageListBehavior")
    ? await timeFixture(page, sampleCount, async (sample) => {
    return page.evaluate(async (sampleIndex) => {
      const fixture = window.__issue1240;
      const revision = ++fixture.revision;
      const frames = async (count = 2) => {
        for (let index = 0; index < count; index += 1) {
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
      };
      const waitFor = async (predicate, maxFrames = 60) => {
        for (let index = 0; index < maxFrames; index += 1) {
          if (predicate()) return true;
          await frames(1);
        }
        return predicate();
      };
      const waitForDuration = async (predicate, timeoutMs) => {
        const deadline = performance.now() + timeoutMs;
        while (performance.now() < deadline) {
          if (predicate()) return true;
          await frames(1);
        }
        return predicate();
      };
      const waitForConsecutiveFrames = async (predicate, requiredFrames, maxFrames = 60) => {
        let consecutiveFrames = 0;
        for (let index = 0; index < maxFrames; index += 1) {
          consecutiveFrames = predicate() ? consecutiveFrames + 1 : 0;
          if (consecutiveFrames >= requiredFrames) return true;
          await frames(1);
        }
        return false;
      };
      const waitForStableScrollHeight = async (element, requiredFrames, maxFrames = 120) => {
        let previousHeight = null;
        let consecutiveFrames = 0;
        for (let index = 0; index < maxFrames; index += 1) {
          const scrollHeight = element instanceof HTMLElement ? element.scrollHeight : null;
          consecutiveFrames = scrollHeight !== null && scrollHeight === previousHeight
            ? consecutiveFrames + 1
            : 0;
          if (consecutiveFrames >= requiredFrames) return true;
          previousHeight = scrollHeight;
          await frames(1);
        }
        return false;
      };
      const list = () => document.querySelector('[data-testid="message-list"]')?.firstElementChild;
      const scroll = (element) => element?.dispatchEvent(new Event("scroll", { bubbles: true }));
      const visibleAnchor = (element) => {
        if (!(element instanceof HTMLElement)) return null;
        const viewportTop = element.getBoundingClientRect().top;
        return [...element.querySelectorAll("[data-message-id]")]
          .find((node) => node.getBoundingClientRect().bottom > viewportTop + 2) ?? null;
      };
      const replaceMessages = (threadId, messages, patch = {}) => {
        fixture.threadStore.setState((state) => {
          const records = new Map(state.records);
          const record = records.get(threadId);
          if (!record) return state;
          const retainedNarrative = Object.fromEntries(
            messages
              .filter((message) => message.role === "assistant")
              .flatMap((message) => record.narrativeByMessage[message.id]
                ? [[message.id, record.narrativeByMessage[message.id]]]
                : []),
          );
          records.set(threadId, {
            ...record,
            ...patch,
            messages,
            narrativeByMessage: {
              ...fixture.emptyNarrativeByMessage(messages),
              ...retainedNarrative,
            },
          });
          return { ...state, records };
        });
      };
      const addThread = (threadId, title, messages, patch = {}) => {
        const thread = fixture.baseThread(threadId, title);
        const { narrativeByMessage = {}, ...recordPatch } = patch;
        fixture.workspaceStore.setState((state) => ({
          ...state,
          threads: [thread, ...state.threads.filter((item) => item.id !== threadId)],
        }));
        fixture.threadStore.setState((state) => ({
          ...state,
          records: new Map(state.records).set(threadId, {
            ...fixture.recordModule.createEmptyThreadRecord(),
            messages,
            oldestLoadedSequence: messages[0]?.sequence ?? 0,
            ...recordPatch,
            narrativeByMessage: {
              ...fixture.emptyNarrativeByMessage(messages),
              ...narrativeByMessage,
            },
          }),
        }));
      };
      const visibleThreadId = () => document.querySelector("[data-message-id]")?.getAttribute("data-thread-id") ?? null;
      const threadSwitchIdentity = (threadId, previous) => {
        const activeThreadId = fixture.workspaceStore.getState().activeThreadId;
        const currentThreadId = fixture.threadStore.getState().currentThreadId;
        return activeThreadId === threadId
          && currentThreadId === threadId
          && visibleThreadId() === threadId
          && (previous.activeThreadId !== threadId
            || previous.currentThreadId !== threadId
            || previous.visibleThreadId !== threadId);
      };
      const switchThread = async (threadId, waitForVisible = true) => {
        const previous = {
          activeThreadId: fixture.workspaceStore.getState().activeThreadId,
          currentThreadId: fixture.threadStore.getState().currentThreadId,
          visibleThreadId: visibleThreadId(),
        };
        fixture.workspaceStore.setState((state) => ({
          ...state,
          activeThreadId: threadId,
        }));
        fixture.threadStore.setState((state) => ({
          ...state,
          currentThreadId: threadId,
        }));
        return waitFor(() => {
          const activeThreadId = fixture.workspaceStore.getState().activeThreadId;
          const currentThreadId = fixture.threadStore.getState().currentThreadId;
          const changed = previous.activeThreadId !== threadId
            || previous.currentThreadId !== threadId
            || previous.visibleThreadId !== threadId;
          return activeThreadId === threadId
            && currentThreadId === threadId
            && changed
            && (!waitForVisible || visibleThreadId() === threadId);
        });
      };
      const startedAt = performance.now();
      const threadId = `perf-message-list-behavior-${revision}`;
      const user = fixture.message(
        threadId,
        0,
        `Last user prompt ${"detail ".repeat(160)}`,
        "user",
      );
      const messages = [
        user,
        ...Array.from({ length: 1_000 }, (_, index) => fixture.message(
          threadId,
          index + 1,
          `Assistant fixture ${index} ${"word ".repeat(30)}`,
          "assistant",
        )),
      ];
      let olderLoadCalls = 0;
      let olderExpectedMessageId = null;
      let newerLoadCalls = 0;
      let newerExpectedMessageId = null;
      fixture.threadStore.setState((state) => ({
        ...state,
        loadOlderMessages: async (requestedThreadId) => {
          olderLoadCalls += 1;
          const olderMessages = Array.from({ length: 120 }, (_, index) => fixture.message(
            requestedThreadId,
            index - 120,
            `Older history ${index} ${"word ".repeat(30)}`,
            "assistant",
          ));
          olderExpectedMessageId = olderMessages[0]?.id ?? null;
          const current = fixture.threadStore.getState().records.get(requestedThreadId);
          if (current) replaceMessages(requestedThreadId, [...olderMessages, ...current.messages], {
            hasMoreMessages: false,
          });
        },
        loadNewerMessages: async (requestedThreadId) => {
          newerLoadCalls += 1;
          const current = fixture.threadStore.getState().records.get(requestedThreadId);
          const start = current?.messages.length ?? 0;
          const newerMessages = Array.from({ length: 120 }, (_, index) => fixture.message(
            requestedThreadId,
            start + index,
            `Newer history ${index} ${"word ".repeat(30)}`,
            "assistant",
          ));
          newerExpectedMessageId = newerMessages.at(-1)?.id ?? null;
          if (current) replaceMessages(requestedThreadId, [...current.messages, ...newerMessages], {
            hasNewerMessages: false,
          });
        },
      }));
      fixture.activate(threadId, "MessageList behavior fixture", messages, {
        hasMoreMessages: true,
        hasNewerMessages: true,
      });
      await frames(12);

      const longScrollElement = list();
      const tailMessageId = messages.at(-1)?.id ?? null;
      if (longScrollElement instanceof HTMLElement) {
        longScrollElement.scrollTop = longScrollElement.scrollHeight / 2;
        scroll(longScrollElement);
      }
      await frames(4);
      const longScrollAnchor = visibleAnchor(longScrollElement);
      const longThreadScroll = Boolean(longScrollAnchor)
        && longScrollAnchor?.getAttribute("data-message-id") !== tailMessageId;

      if (longScrollElement instanceof HTMLElement) {
        longScrollElement.scrollTop = longScrollElement.scrollHeight;
        scroll(longScrollElement);
      }
      await frames(3);
      const dynamicMessageId = tailMessageId;
      const dynamicBefore = dynamicMessageId
        ? document.querySelector(`[data-message-id="${dynamicMessageId}"]`)?.getBoundingClientRect().height ?? 0
        : 0;
      replaceMessages(threadId, messages.map((message) =>
        message.id === dynamicMessageId
          ? { ...message, content: `${message.content}\n\n${"dynamic height ".repeat(1_000)}` }
          : message,
      ));
      const dynamicHeightSettled = await waitFor(() => {
        const element = dynamicMessageId
          ? document.querySelector(`[data-message-id="${dynamicMessageId}"]`)
          : null;
        const scroller = list();
        return element instanceof HTMLElement
          && scroller instanceof HTMLElement
          && element.getBoundingClientRect().height > dynamicBefore
          && Math.abs(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight) <= 4;
      });

      const olderScroller = list();
      if (olderScroller instanceof HTMLElement) {
        olderScroller.scrollTop = 120;
        scroll(olderScroller);
      }
      await frames(3);
      const olderAnchor = visibleAnchor(olderScroller);
      const olderAnchorId = olderAnchor?.getAttribute("data-message-id") ?? null;
      const olderAnchorTop = olderAnchor?.getBoundingClientRect().top ?? null;
      if (olderScroller instanceof HTMLElement) {
        olderScroller.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -100 }));
      }
      const olderHistoryLoaded = await waitFor(() => {
        const current = fixture.threadStore.getState().records.get(threadId);
        return olderLoadCalls > 0
          && olderExpectedMessageId !== null
          && current?.messages.some((message) => message.id === olderExpectedMessageId) === true;
      });
      const olderHistoryAnchor = olderHistoryLoaded && await waitForConsecutiveFrames(() => {
        const anchor = olderAnchorId
          ? document.querySelector(`[data-message-id="${olderAnchorId}"]`)
          : null;
        return anchor instanceof HTMLElement
          && olderAnchorTop !== null
          && Math.abs(anchor.getBoundingClientRect().top - olderAnchorTop) <= 2;
      }, 3);
      const olderHistoryHeightSettled = olderHistoryAnchor
        && await waitForStableScrollHeight(olderScroller, 4);

      const newerScroller = list();
      const newerPaginationGap = 96;
      if (olderHistoryHeightSettled && newerScroller instanceof HTMLElement) {
        newerScroller.scrollTop = Math.max(
          0,
          newerScroller.scrollHeight - newerScroller.clientHeight - newerPaginationGap,
        );
        scroll(newerScroller);
      }
      const newerPaginationPositioned = olderHistoryHeightSettled && await waitForConsecutiveFrames(() => {
        if (!(newerScroller instanceof HTMLElement)) return false;
        const gap = newerScroller.scrollHeight - newerScroller.scrollTop - newerScroller.clientHeight;
        return Math.abs(gap - newerPaginationGap) <= 2;
      }, 3);
      const newerAnchor = visibleAnchor(newerScroller);
      const newerAnchorId = newerAnchor?.getAttribute("data-message-id") ?? null;
      const newerAnchorTop = newerAnchor?.getBoundingClientRect().top ?? null;
      if (newerPaginationPositioned && newerScroller instanceof HTMLElement) {
        newerScroller.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 100 }));
      }
      const newerHistoryLoaded = newerPaginationPositioned && await waitFor(() => {
        const current = fixture.threadStore.getState().records.get(threadId);
        return newerLoadCalls > 0
          && newerExpectedMessageId !== null
          && current?.messages.some((message) => message.id === newerExpectedMessageId) === true;
      });
      const newerHistoryAnchor = newerHistoryLoaded && await waitFor(() => {
        const anchor = newerAnchorId
          ? document.querySelector(`[data-message-id="${newerAnchorId}"]`)
          : null;
        return anchor instanceof HTMLElement
          && newerAnchorTop !== null
          && Math.abs(anchor.getBoundingClientRect().top - newerAnchorTop) <= 2;
      });

      const cacheThreadId = `perf-message-list-cache-${revision}`;
      const cacheMessages = fixture.makeMessages(cacheThreadId, 1_000, "cache");
      addThread(cacheThreadId, "Cache behavior fixture", cacheMessages);
      const cacheInitialSwitchIdentity = await switchThread(cacheThreadId);
      const cacheScroller = list();
      let cacheAnchorId = null;
      let cacheAnchorTop = null;
      if (cacheScroller instanceof HTMLElement) {
        cacheScroller.scrollTop = cacheScroller.scrollHeight / 2;
        scroll(cacheScroller);
      }
      const cacheReaderPositioned = await waitForConsecutiveFrames(() => {
        if (!(cacheScroller instanceof HTMLElement)) return false;
        const targetScrollTop = cacheScroller.scrollHeight / 2;
        cacheScroller.scrollTop = targetScrollTop;
        scroll(cacheScroller);
        const anchor = visibleAnchor(cacheScroller);
        cacheAnchorId = anchor?.getAttribute("data-message-id") ?? null;
        cacheAnchorTop = anchor?.getBoundingClientRect().top ?? null;
        return cacheAnchorId !== null
          && cacheAnchorTop !== null
          && Math.abs(cacheScroller.scrollTop - targetScrollTop) <= 2;
      }, 3, 180);
      const cachePositionRemembered = cacheReaderPositioned && cacheAnchorId !== null && await waitFor(() => {
        if (cacheScroller instanceof HTMLElement) scroll(cacheScroller);
        const position = window.__mcodeFrontendPerformanceModules?.scrollMemory.recall(cacheThreadId);
        return position?.anchorMessageId === cacheAnchorId
          && position.anchorTop != null
          && cacheAnchorTop !== null
          && Math.abs(position.anchorTop - cacheAnchorTop) <= 2;
      });
      const cacheHitAwaySwitchIdentity = await switchThread(threadId);
      const cacheHitReturnSwitchIdentity = await switchThread(cacheThreadId);
      const cacheHitThreadIdentity = cacheInitialSwitchIdentity
        && cacheHitAwaySwitchIdentity
        && cacheHitReturnSwitchIdentity
        && threadSwitchIdentity(cacheThreadId, {
          activeThreadId: threadId,
          currentThreadId: threadId,
          visibleThreadId: threadId,
        });
      const cacheHitRestored = cachePositionRemembered && cacheHitThreadIdentity && await waitFor(() => {
        const anchor = cacheAnchorId
          ? document.querySelector(`[data-message-id="${cacheAnchorId}"]`)
          : null;
        return anchor instanceof HTMLElement
          && cacheAnchorTop !== null
          && Math.abs(anchor.getBoundingClientRect().top - cacheAnchorTop) <= 8;
      }, 180);

      const cacheMissAwaySwitchIdentity = await switchThread(threadId);
      window.__mcodeFrontendPerformanceModules?.scrollMemory.forget(cacheThreadId);
      replaceMessages(cacheThreadId, [], { loading: true });
      const cacheMissLoadingSwitchIdentity = await switchThread(cacheThreadId, false);
      const cacheMissLoadingObserved = cacheMissLoadingSwitchIdentity && await waitFor(() => {
        const activeRecord = fixture.threadStore.getState().records.get(cacheThreadId);
        const heldMessage = document.querySelector("[data-message-id]");
        return activeRecord?.loading === true
          && activeRecord.messages.length === 0
          && document.querySelector('[data-testid="conversation-hold-overlay"]') !== null
          && heldMessage?.getAttribute("data-thread-id") === threadId;
      });
      replaceMessages(cacheThreadId, cacheMessages, { loading: false });
      const cacheMissVisibleIdentity = await waitFor(() =>
        threadSwitchIdentity(cacheThreadId, {
          activeThreadId: threadId,
          currentThreadId: threadId,
          visibleThreadId: threadId,
        }));
      const cacheMissThreadIdentity = cacheMissAwaySwitchIdentity
        && cacheMissLoadingSwitchIdentity
        && cacheMissLoadingObserved
        && cacheMissVisibleIdentity;
      const cacheMissRestored = cacheMissThreadIdentity && await waitFor(() => {
        const record = fixture.threadStore.getState().records.get(cacheThreadId);
        return record?.loading === false
          && record.messages.length === cacheMessages.length
          && document.querySelector('[data-testid="conversation-hold-overlay"]') === null
          && visibleThreadId() === cacheThreadId;
      }, 180);
      const cacheMissTailPositioned = cacheMissRestored && await waitFor(() => {
        const scroller = list();
        return scroller instanceof HTMLElement
          && Math.abs(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight) <= 4;
      }, 180);

      const stickyThreadId = `perf-message-list-sticky-${revision}`;
      const stickyUser = fixture.message(
        stickyThreadId,
        0,
        `Sticky user message ${"detail ".repeat(160)}`,
        "user",
      );
      const stickyMessages = [
        stickyUser,
        ...Array.from({ length: 80 }, (_, index) => fixture.message(
          stickyThreadId,
          index + 1,
          `Sticky assistant ${index}`,
          "assistant",
        )),
      ];
      fixture.activate(stickyThreadId, "Sticky behavior fixture", stickyMessages);
      await frames(12);
      const stickyScroller = list();
      if (stickyScroller instanceof HTMLElement) {
        stickyScroller.scrollTop = 0;
        scroll(stickyScroller);
      }
      const stickyAbsentWhenUserVisible = await waitFor(() => {
        const userRow = document.querySelector(`[data-message-id="${stickyUser.id}"]`);
        return userRow instanceof HTMLElement
          && document.querySelector('[data-testid="sticky-user-message"]') === null;
      });
      if (stickyScroller instanceof HTMLElement) {
        stickyScroller.scrollTop = stickyScroller.scrollHeight - stickyScroller.clientHeight;
        scroll(stickyScroller);
      }
      const stickyVisible = stickyAbsentWhenUserVisible && await waitFor(() =>
        document.querySelector('[data-testid="sticky-user-message"]') !== null,
      );
      const stickyPreview = document.querySelector('button[aria-label="Expand your last message"]');
      stickyPreview?.focus();
      const focusPreserved = document.activeElement === stickyPreview;
      stickyPreview?.click();
      const interactiveControl = await waitFor(() => document.querySelector(
        'button[aria-label="Collapse your last message"]',
      ) !== null);
      const stickyTargetWasUnmountedBeforeJump = document.querySelector(
        `[data-message-id="${stickyUser.id}"]`,
      ) === null;
      const stickyJump = document.querySelector('button[aria-label="Jump to your last message"]');
      stickyJump?.click();
      const stickyUserJumped = stickyVisible && stickyTargetWasUnmountedBeforeJump && stickyJump !== null && await waitForDuration(() => {
        const stickyRow = document.querySelector(`[data-message-id="${stickyUser.id}"]`);
        const scroller = list();
        if (!(stickyRow instanceof HTMLElement) || !(scroller instanceof HTMLElement)) return false;
        const rowRect = stickyRow.getBoundingClientRect();
        const scrollerRect = scroller.getBoundingClientRect();
        const rowIntersectsViewport = rowRect.bottom > scrollerRect.top && rowRect.top < scrollerRect.bottom;
        const rowCenter = (rowRect.top + rowRect.bottom) / 2;
        const scrollerCenter = (scrollerRect.top + scrollerRect.bottom) / 2;
        const targetCentered = Math.abs(rowCenter - scrollerCenter) <= scroller.clientHeight / 2;
        const stickyDismissed = document.querySelector('[data-testid="sticky-user-message"]') === null;
        return rowIntersectsViewport && (stickyDismissed || targetCentered);
      }, 3_600);

      const identityThreadId = `perf-message-list-identity-${revision}`;
      const persistedId = `${identityThreadId}-persisted-response`;
      fixture.activate(identityThreadId, "Rendered identity fixture", [
        fixture.message(identityThreadId, 0, "Identity prompt", "user"),
      ], {
        narrativeByMessage: {
          [persistedId]: { tools: [], thoughts: [], hooks: [] },
        },
      });
      fixture.threadStore.getState().handleAgentEvent({
        type: "turnStarted",
        threadId: identityThreadId,
        fileEffectTurnId: `identity-${revision}`,
      });
      const responseKey = fixture.threadStore.getState().records.get(identityThreadId)?.currentTurnResponseKey;
      fixture.threadStore.getState().handleAgentEvent({
        type: "textDelta",
        threadId: identityThreadId,
        delta: "Live answer",
        isFinalResponse: true,
      });
      const liveNodeReady = typeof responseKey === "string" && responseKey.length > 0 && await waitFor(() =>
        document.querySelector(`[data-performance-virtual-item-key="${responseKey}"]`) !== null,
      );
      const liveNode = liveNodeReady
        ? document.querySelector(`[data-performance-virtual-item-key="${responseKey}"]`)
        : null;
      fixture.threadStore.getState().handleAgentEvent({
        type: "message",
        threadId: identityThreadId,
        messageId: persistedId,
        content: "Persisted answer",
      });
      const persistedNodeReady = typeof responseKey === "string" && await waitFor(() => {
        const node = document.querySelector(`[data-performance-virtual-item-key="${responseKey}"]`);
        return node !== null && node.querySelector(`[data-message-id="${persistedId}"]`) !== null;
      });
      const persistedNode = persistedNodeReady && typeof responseKey === "string"
        ? document.querySelector(`[data-performance-virtual-item-key="${responseKey}"]`)
        : null;
      const liveToPersistedIdentity = liveNode !== null
        && liveNode === persistedNode
        && persistedNode?.querySelector(`[data-message-id="${persistedId}"]`) !== null;

      return {
        durationMs: performance.now() - startedAt,
        check: {
          longThreadScroll,
          dynamicHeightSettled,
          olderHistoryLoaded,
          olderHistoryAnchor,
          newerHistoryLoaded,
          newerHistoryAnchor,
          cacheHitThreadIdentity,
          cacheHitRestored,
          cacheMissThreadIdentity,
          cacheMissLoadingObserved,
          cacheMissRestored,
          cacheMissTailPositioned,
          stickyAbsentWhenUserVisible,
          stickyVisible,
          stickyTargetWasUnmountedBeforeJump,
          stickyUserJumped,
          focusPreserved,
          interactiveControl,
          liveToPersistedIdentity,
          sampleIndex,
        },
      };
    }, sample);
    }, modeCollector)
    : null;

  const denseNarrative = selectedWorkloads.has("denseNarrative")
    ? await timeFixture(page, sampleCount, async (sample) => {
    return page.evaluate(async ({ sampleIndex, profileUpdate }) => {
      const fixture = window.__issue1240;
      const revision = ++fixture.revision;
      const threadId = `perf-narrative-${revision}`;
      const messageId = `${threadId}-assistant`;
      const assistant = fixture.message(
        threadId,
        0,
        "Dense narrative fixture completed.",
        "assistant",
      );
      assistant.id = messageId;
      const tools = Array.from({ length: 60 }, (_, index) => ({
        id: `${messageId}-tool-${index}`,
        message_id: messageId,
        parent_tool_call_id: null,
        tool_name: index % 3 === 0 ? "Bash" : index % 3 === 1 ? "Read" : "Edit",
        input_summary: `Fixture input ${index}`,
        output_summary: `Fixture output ${index}`,
        status: "completed",
        started_at: "2026-08-09T21:00:00.000Z",
        completed_at: "2026-08-09T21:00:00.010Z",
        sort_order: index * 3,
      }));
      const thoughts = Array.from({ length: 20 }, (_, index) => ({
        id: `${messageId}-thought-${index}`,
        message_id: messageId,
        text: `Narration segment ${index} ${"detail ".repeat(20)}`,
        started_at: "2026-08-09T21:00:00.000Z",
        ended_at: "2026-08-09T21:00:00.010Z",
        sort_order: index * 3 + 1,
      }));
      const hooks = Array.from({ length: 10 }, (_, index) => ({
        id: `${messageId}-hook-${index}`,
        message_id: messageId,
        hook_name: "PreToolUse",
        tool_name: "Bash",
        phase: "permission",
        payload: "{}",
        duration_ms: 3,
        did_block: false,
        started_at: "2026-08-09T21:00:00.000Z",
        ended_at: "2026-08-09T21:00:00.003Z",
        sort_order: index * 3 + 2,
      }));
      let startedAt = performance.now();
      fixture.activate(threadId, "Dense narrative fixture", [assistant], {
        narrativeByMessage: { [messageId]: { tools, thoughts, hooks } },
      });
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      let affectedRowId = null;
      let stableSiblingRowIds = [];
      if (profileUpdate) {
        const narrativeRows = [...document.querySelectorAll("[data-performance-row-id]")];
        const affectedRow = narrativeRows.find((candidate) =>
          candidate.textContent?.includes("Narration segment 0"),
        );
        affectedRowId = affectedRow?.getAttribute("data-performance-row-id") ?? null;
        stableSiblingRowIds = narrativeRows
          .map((candidate) => candidate.getAttribute("data-performance-row-id"))
          .filter((rowId) => rowId && rowId !== affectedRowId);
        const attribution = window.__mcodePerformanceAttribution;
        if (attribution) {
          attribution.commits = [];
          attribution.rowRenders = {};
        }
        startedAt = performance.now();
        fixture.threadStore.setState((state) => {
          const records = new Map(state.records);
          const record = records.get(threadId);
          const narrative = record?.narrativeByMessage[messageId];
          if (!record || !narrative) return state;
          records.set(threadId, {
            ...record,
            narrativeByMessage: {
              ...record.narrativeByMessage,
              [messageId]: {
                ...narrative,
                thoughts: narrative.thoughts.map((thought, index) =>
                  index === 0
                    ? { ...thought, text: `${thought.text} updated` }
                    : thought,
                ),
              },
            },
          });
          return { ...state, records };
        });
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }
      const row = document.querySelector(`[data-message-id="${messageId}"]`);
      const list = document.querySelector('[data-testid="message-list"]');
      const toolSummaries = [...document.querySelectorAll("[data-first-tool-call-id]")];
      return {
        durationMs: performance.now() - startedAt,
        check: {
          sourceRows: tools.length + thoughts.length + hooks.length,
          descendants: list?.querySelectorAll("*").length ?? 0,
          visible: Boolean(row),
          assistantVisible: list?.textContent?.includes("Dense narrative fixture completed.") ?? false,
          thoughtVisible: list?.textContent?.includes("Narration segment 0") ?? false,
          lastThoughtVisible: list?.textContent?.includes("Narration segment 19") ?? false,
          toolVisible: toolSummaries.some((summary) =>
            summary.getAttribute("data-first-tool-call-id") === `${messageId}-tool-0`,
          ),
          lastToolVisible: toolSummaries.some((summary) =>
            summary.getAttribute("data-last-tool-call-id") === `${messageId}-tool-59`,
          ),
          hookVisible: list?.textContent?.includes("PreToolUse") ?? false,
          affectedRowId,
          stableSiblingRowIds,
          sampleIndex,
        },
      };
    }, { sampleIndex: sample, profileUpdate: mode === "profiling" && sample >= 0 });
    }, modeCollector, { deferFinalReset: true })
    : null;

  if (denseNarrative) {
    let denseDisclosureCheck;
    try {
      denseDisclosureCheck = await page.evaluate(async () => {
      const list = document.querySelector('[data-testid="message-list"]');
      const expand = [...document.querySelectorAll("button")].find((button) =>
        button.textContent?.startsWith("Browse all "),
      );
      expand?.click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      let browseDescendants = list?.querySelectorAll("*").length ?? 0;
      let pageCount = 0;
      while (pageCount < 20) {
        pageCount += 1;
        const next = [...document.querySelectorAll("button")].find((button) =>
          button.textContent === "Next" && !button.disabled,
        );
        if (!next) break;
        next.click();
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        browseDescendants = Math.max(
          browseDescendants,
          list?.querySelectorAll("*").length ?? 0,
        );
      }
      const summary = [...document.querySelectorAll("button")].find((button) =>
        button.textContent === "Summary",
      );
      summary?.click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return {
        browsed: pageCount > 1,
        returnedToSummary: [...document.querySelectorAll("button")].some((button) =>
          button.textContent?.startsWith("Browse all "),
        ),
        browseDescendants,
      };
      });
    } finally {
      await resetFixtureRuntime(page);
    }
    for (const check of denseNarrative.checks) Object.assign(check, denseDisclosureCheck);
  }

  const markdownShiki = selectedWorkloads.has("markdownShiki")
    ? await timeFixture(page, sampleCount, async (sample) => {
    return page.evaluate(async (sampleIndex) => {
      const fixture = window.__issue1240;
      const revision = ++fixture.revision;
      const threadId = `perf-markdown-${revision}`;
      const blocks = Array.from({ length: 10 }, (_, block) => {
        const code = Array.from(
          { length: 100 },
          (_, line) => `const fixture_${block}_${line}: number = ${line};${line === 0 ? ` const overflow_${block} = "${"x".repeat(1800)}";` : ""}`,
        ).join("\n");
        return `## Block ${block}\n\n\`\`\`typescript\n${code}\n\`\`\``;
      }).join("\n\n");
      const assistant = fixture.message(threadId, 0, blocks, "assistant");
      const startedAt = performance.now();
      fixture.activate(threadId, "Markdown and Shiki fixture", [assistant]);
      const deadline = startedAt + 15_000;
      let highlightedBlocks = 0;
      let plainFallbackObserved = [...document.querySelectorAll(
        `[data-thread-id="${threadId}"] [data-code-block]`,
      )].some((block) => block.querySelector(".visible.opacity-100") !== null);
      do {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        highlightedBlocks = document.querySelectorAll(
          `[data-thread-id="${threadId}"] .shiki`,
        ).length;
        plainFallbackObserved ||= [...document.querySelectorAll(
          `[data-thread-id="${threadId}"] [data-code-block]`,
        )].some((block) => block.querySelector(".visible.opacity-100") !== null);
      } while (highlightedBlocks < 10 && performance.now() < deadline);
      return {
        durationMs: performance.now() - startedAt,
        check: {
          highlightedBlocks,
          codeBlocks: document.querySelectorAll(`[data-thread-id="${threadId}"] [data-code-block]`).length,
          plainFallbackObserved,
          themeClassAndStyle: [...document.querySelectorAll(
            `[data-thread-id="${threadId}"] [data-code-block] .shiki`,
          )].every((block) => {
            const expectedTheme = document.documentElement.classList.contains("dark")
              ? "github-dark"
              : "github-light";
            return block.classList.contains(expectedTheme) && Boolean(block.getAttribute("style"));
          }),
          copyButtonsAccessible: document.querySelectorAll(
            `[data-thread-id="${threadId}"] button[aria-label="Copy code"]`,
          ).length === 10,
          semanticCodeBlocks: document.querySelectorAll(
            `[data-thread-id="${threadId}"] [data-code-block] pre code`,
          ).length >= 10,
          highlightedContent: [...document.querySelectorAll(
            `[data-thread-id="${threadId}"] [data-code-block] .shiki code`,
          )].every((block) => block.textContent?.includes("fixture_")),
          textSelection: (() => {
            const code = document.querySelector(
              `[data-thread-id="${threadId}"] [data-code-block] .shiki code`,
            );
            if (!code) return false;
            const range = document.createRange();
            range.selectNodeContents(code);
            const selection = window.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
            return selection?.toString().includes("fixture_") ?? false;
          })(),
          horizontalOverflow: [...document.querySelectorAll(
            `[data-thread-id="${threadId}"] [data-code-block] .overflow-x-auto`,
          )].some((container) => container.scrollWidth > container.clientWidth),
          sampleIndex,
        },
      };
    }, sample);
    }, modeCollector, { captureShiki: true, buildMode: mode })
    : null;

  const panelTransitions = selectedWorkloads.has("panelTransitions")
    ? await timeFixture(page, sampleCount, async (sample) => {
    return page.evaluate(async (sampleIndex) => {
      const fixture = window.__issue1240;
      const revision = ++fixture.revision;
      const threadId = `perf-panel-${revision}`;
      fixture.activate(threadId, "Panel transition fixture", [
        fixture.message(threadId, 0, "Panel fixture prompt", "user"),
      ]);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const startedAt = performance.now();
      fixture.diffStore.getState().showRightPanel(fixture.workspaceId, threadId);
      fixture.diffStore.getState().setRightPanelTab(fixture.workspaceId, threadId, "preview");
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      fixture.diffStore.getState().setRightPanelTab(fixture.workspaceId, threadId, "terminal");
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const state = fixture.diffStore.getState().getRightPanel(fixture.workspaceId, threadId);
      return {
        durationMs: performance.now() - startedAt,
        check: {
          visible: state.visible,
          activeTab: state.activeTab,
          browserTabOpen: state.openTabs.includes("preview"),
          terminalTabOpen: state.openTabs.includes("terminal"),
          terminalShell: Boolean(document.querySelector('[data-testid="terminal-pool-slot"]')),
          sampleIndex,
        },
      };
    }, sample);
    }, modeCollector)
    : null;

  const vlistLifecycle = selectedWorkloads.has("vlistLifecycle")
    ? await timeFixture(page, sampleCount, async () => page.evaluate(async () => {
      const bridge = window.__mcodeFrontendPerformanceModules?.vlistLifecycle;
      if (!bridge) throw new Error("The vlist lifecycle performance probe is unavailable.");
      const startedAt = performance.now();
      const check = await bridge.run();
      return {
        durationMs: performance.now() - startedAt,
        check,
      };
    }), modeCollector, { captureMessageListAttribution: false })
    : null;

  await waitForFrames(page);
  const observations = await signalCollector.read();
  signalCollector.dispose();
  await modeCollector.dispose();
  const pageFailures = [];
  if (observations.consoleErrors.length > 0) {
    pageFailures.push(`console errors: ${observations.consoleErrors.join(" | ")}`);
  }
  if (observations.pageErrors.length > 0) {
    pageFailures.push(`page errors: ${observations.pageErrors.join(" | ")}`);
  }
  if (observations.pageState.url !== expectedPageUrl) {
    pageFailures.push(`page URL changed to ${observations.pageState.url}`);
  }
  if (observations.pageState.visibility !== "visible") {
    pageFailures.push(`page visibility is ${observations.pageState.visibility}`);
  }
  if (observations.pageState.title.length === 0) {
    pageFailures.push("page title is empty");
  }

  const metrics = Object.fromEntries(
    Object.entries({
      message100,
      message1000,
      threadSwitch,
      streaming,
      messageListBehavior,
      denseNarrative,
      markdownShiki,
      panelTransitions,
      vlistLifecycle,
    }).filter(([, result]) => result !== null).map(([name, result]) => {
      const rawSamples = result.samples.map((durationMs, sampleIndex) => {
        const observed = result.checks[sampleIndex];
        const attribution = result.attributions[sampleIndex];
        const lifecycle = name === "vlistLifecycle"
          ? deriveVListLifecycleGate(observed)
          : null;
        if (name === "denseNarrative" && attribution.react) {
          attribution.react.affectedRow = observed.affectedRowId
            ? {
                rowId: observed.affectedRowId,
                renderCount: attribution.react.rowRenders[observed.affectedRowId] ?? 0,
              }
            : null;
          attribution.react.stableSiblingRows = observed.stableSiblingRowIds.map((rowId) => ({
            rowId,
            renderCount: attribution.react.rowRenders[rowId] ?? 0,
          }));
        }
        const rowIsolationFailures = name === "denseNarrative"
          ? validateNarrativeRowIsolation(attribution.react)
          : [];
        const messageListAttributionFailures = name === "messageListBehavior"
          ? validateMessageListPerformanceAttribution(attribution.messageList)
          : [];
        const failures = [
          ...(lifecycle ? lifecycle.failures : validateWorkloadCheck(name, observed, mode)),
          ...rowIsolationFailures,
          ...messageListAttributionFailures,
          ...pageFailures,
        ];
        return {
          sampleIndex,
          durationMs,
          attribution,
          correctness: {
            passed: failures.length === 0,
            failures,
            observed,
            ...(lifecycle ? { derived: lifecycle } : {}),
          },
        };
      });
      const acceptedDurations = rawSamples
        .filter((sample) => sample.correctness.passed)
        .map((sample) => sample.durationMs);
      return [name, {
        rawSamples,
        summary: summarizeDurationSamples(acceptedDurations),
        shikiAttribution: (() => {
          if (name !== "markdownShiki") return null;
          const acceptedShikiSamples = rawSamples
            .filter((sample) => sample.correctness.passed)
            .map((sample) => sample.correctness.observed.shikiAttribution ?? []);
          if (acceptedShikiSamples.length === 0) return null;
          const attribution = aggregateShikiStageAttribution(acceptedShikiSamples, mode);
          return {
            ...attribution,
            longTasksOver50Ms: rawSamples
              .filter((sample) => sample.correctness.passed)
              .flatMap((sample) => sample.correctness.observed.shikiLongTasksOver50Ms ?? []),
          };
        })(),
        messageListAttribution: (() => {
          if (name === "vlistLifecycle") return null;
          const acceptedMessageListSamples = rawSamples
            .filter((sample) => sample.correctness.passed)
            .map((sample) => sample.attribution.messageList ?? []);
          return acceptedMessageListSamples.length > 0
            ? aggregateMessageListPerformanceAttribution(acceptedMessageListSamples)
            : null;
        })(),
        gateDecision: (() => {
          if (name !== "vlistLifecycle") return null;
          const decisions = rawSamples.map((sample) => sample.correctness.derived?.gateDecision);
          const allAccepted = decisions.every((decision) => decision?.status === "accepted"
            && decision.candidateEligible === true
            && decision.reason === null);
          return allAccepted
            ? {
                status: "accepted",
                candidateEligible: true,
                reason: null,
              }
            : {
                status: "invalid",
                candidateEligible: false,
                reason: "vlist lifecycle samples did not satisfy the lifecycle contract.",
              };
        })(),
        correctness: {
          passed: rawSamples.every((sample) => sample.correctness.passed),
          rejectedSamples: rawSamples.filter((sample) => !sample.correctness.passed).length,
        },
      }];
    }),
  );
  const correctness = {
    passed: Object.values(metrics).every((metric) => metric.correctness.passed),
    rejectedSamples: Object.values(metrics).reduce(
      (total, metric) => total + metric.correctness.rejectedSamples,
      0,
    ),
  };

  return {
    runtime,
    buildMode: mode,
    sampleCount,
    workloads,
    attributionSignals: {
      tanstackVirtualItems: "Duration of TanStack Virtual getVirtualItems(), not total virtualizer cost.",
      narrativeItemProjection: "Duration of MessageList buildStableItems(), including narrative-item construction, not total narrative rendering.",
      resizeObserverCallbackTraceMs: "Chromium trace duration for ResizeObserver-named events; null when Chromium does not expose them.",
      gcTraceMs: "Chromium trace duration for GC-named events; null when Chromium does not expose them.",
      endToEndDuration: "Workload duration includes predicate-based frames needed to observe settled UI behavior; it is not CPU-only cost.",
      cacheRestoration: "Cache hits restore the saved reading anchor. Cache misses preserve the outgoing transcript until the client record arrives, then position the restored transcript at the tail. Neither path measures server transport or hydration.",
    },
    metrics,
    observations,
    correctness,
  };
}
