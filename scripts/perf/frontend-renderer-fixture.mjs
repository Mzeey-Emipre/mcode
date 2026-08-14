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
  "denseNarrative",
  "markdownShiki",
  "panelTransitions",
]);

/** Maximum descendants allowed in one renderer scrollable viewport. */
export const MAX_RENDERER_VIEWPORT_DESCENDANTS = 499;

/** Maximum duration allowed for one main-thread task. */
export const MAX_MAIN_THREAD_TASK_DURATION_MS = 50;

/** Layout events longer than this duration count toward the slow-layout budget. */
export const SLOW_LAYOUT_DURATION_THRESHOLD_MS = 1;

/** Maximum number of slow layout events allowed in one workload sample. */
export const MAX_SLOW_LAYOUT_COUNT = 2;

/** Minimum start-time gap between slow layout events. */
export const MIN_SLOW_LAYOUT_START_GAP_MS = 16.7;

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
const LAYOUT_TIME_COMPARISON_EPSILON_MS = 0.000001;

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, keys) {
  const actualKeys = Object.keys(value).sort();
  return actualKeys.length === keys.length && keys.every((key, index) => actualKeys[index] === key);
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

    const activate = (threadId, title, messages, patch = {}) => {
      const thread = baseThread(threadId, title);
      workspaceStore.setState((state) => ({
        ...state,
        activeWorkspaceId: workspace.id,
        activeThreadId: threadId,
        threads: [thread, ...state.threads.filter((item) => item.id !== threadId)],
      }));
      const record = {
        ...modules.createEmptyThreadRecord(),
        messages,
        oldestLoadedSequence: messages[0]?.sequence ?? 0,
        ...patch,
      };
      threadStore.setState((state) => ({
        ...state,
        currentThreadId: threadId,
        records: new Map(state.records).set(threadId, record),
      }));
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
      activate,
      revision: 0,
    };
  });
}

async function timeFixture(page, sampleCount, operation, modeCollector, options = {}) {
  const samples = [];
  const checks = [];
  const attributions = [];
  const captureShiki = options.captureShiki === true;
  await operation(-1);
  if (captureShiki) {
    await page.evaluate(() => {
      const bridge = window.__mcodeFrontendPerformanceModules?.shikiPerformance;
      bridge?.setCapture(false);
      bridge?.reset();
      bridge?.resetWorker();
    });
  }
  for (let index = 0; index < sampleCount; index += 1) {
    if (captureShiki) {
      await page.evaluate(() => {
        const bridge = window.__mcodeFrontendPerformanceModules?.shikiPerformance;
        bridge?.reset();
        bridge?.resetWorker();
        bridge?.setCapture(true);
      });
    }
    const { result, attribution } = await modeCollector.measure(
      () => operation(index),
      getShikiTraceOptions(captureShiki, options.buildMode),
    );
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
    samples.push(result.durationMs);
    checks.push(result.check);
    attributions.push(attribution);
  }
  return { samples, checks, attributions };
}

/** Returns trace collection options only for production Shiki attribution. */
export function getShikiTraceOptions(captureShiki, buildMode) {
  return captureShiki && buildMode === "production" ? { trace: true } : undefined;
}

function formatBudgetValue(value) {
  if (value === undefined || value === null) return "unavailable";
  return String(value);
}

function addBudgetFailure(failures, workload, metric, observed, budget) {
  failures.push(
    `${workload} ${metric}: observed ${formatBudgetValue(observed)}; budget ${budget}`,
  );
}

/** Returns strict renderer budget failures for one measured workload sample. */
export function validateRendererBudgetSample(
  workload,
  check,
  attribution,
  buildMode = "profiling",
) {
  if (buildMode !== "profiling" && buildMode !== "production") {
    throw new TypeError("buildMode must be profiling or production");
  }
  const failures = [];
  const viewportDescendants = check?.viewportDescendants;
  if (!Number.isSafeInteger(viewportDescendants)) {
    addBudgetFailure(
      failures,
      workload,
      "viewport descendants",
      "unavailable",
      `<= ${MAX_RENDERER_VIEWPORT_DESCENDANTS}`,
    );
  } else if (viewportDescendants > MAX_RENDERER_VIEWPORT_DESCENDANTS) {
    addBudgetFailure(
      failures,
      workload,
      "viewport descendants",
      viewportDescendants,
      `<= ${MAX_RENDERER_VIEWPORT_DESCENDANTS}`,
    );
  }

  if (workload === "denseNarrative") {
    const browsingViewportDescendants = check?.browsingViewportDescendants ?? check?.browseDescendants;
    if (!Number.isSafeInteger(browsingViewportDescendants)) {
      addBudgetFailure(
        failures,
        workload,
        "browsing viewport descendants",
        "unavailable",
        `<= ${MAX_RENDERER_VIEWPORT_DESCENDANTS}`,
      );
    } else if (browsingViewportDescendants > MAX_RENDERER_VIEWPORT_DESCENDANTS) {
      addBudgetFailure(
        failures,
        workload,
        "browsing viewport descendants",
        browsingViewportDescendants,
        `<= ${MAX_RENDERER_VIEWPORT_DESCENDANTS}`,
      );
    }
  }

  if (buildMode !== "production") return failures;

  const chromium = attribution?.chromium;
  if (!isPlainObject(chromium)) {
    addBudgetFailure(
      failures,
      workload,
      "Chromium trace",
      "unavailable",
      "production trace data required",
    );
    return failures;
  }

  if (chromium.longTaskObserverAvailable !== true || !Array.isArray(chromium.longTasksMs)) {
    addBudgetFailure(
      failures,
      workload,
      "main-thread task trace",
      "unavailable",
      "finite task durations with a long-task observer",
    );
  } else {
    for (const durationMs of chromium.longTasksMs) {
      if (!Number.isFinite(durationMs) || durationMs < 0) {
        addBudgetFailure(
          failures,
          workload,
          "main-thread task duration",
          `${durationMs} ms`,
          `finite values <= ${MAX_MAIN_THREAD_TASK_DURATION_MS} ms`,
        );
      } else if (durationMs > MAX_MAIN_THREAD_TASK_DURATION_MS) {
        addBudgetFailure(
          failures,
          workload,
          "main-thread task duration",
          `${durationMs} ms`,
          `<= ${MAX_MAIN_THREAD_TASK_DURATION_MS} ms`,
        );
      }
    }
  }

  if (
    !Array.isArray(chromium.layoutEvents) ||
    !Number.isSafeInteger(chromium.traceEventCount) ||
    chromium.traceEventCount < 1 ||
    chromium.traceEventsTruncated === true ||
    chromium.malformedTraceEventCount > 0 ||
    chromium.malformedLayoutEventCount > 0
  ) {
    const observedLayoutTrace = !Array.isArray(chromium.layoutEvents)
      ? "unavailable"
      : chromium.traceEventsTruncated
        ? `${chromium.traceEventCount} events (truncated)`
        : chromium.malformedTraceEventCount > 0
          ? `${chromium.malformedTraceEventCount} malformed events`
          : chromium.malformedLayoutEventCount > 0
            ? `${chromium.malformedLayoutEventCount} malformed layout events`
            : chromium.traceEventCount < 1
              ? "unavailable"
              : "malformed";
    addBudgetFailure(
      failures,
      workload,
      "layout trace",
      observedLayoutTrace,
      "individual layout start and duration data",
    );
    return failures;
  }

  const invalidLayoutEvent = chromium.layoutEvents.find(
    (event) =>
      !isPlainObject(event) ||
      !Number.isFinite(event.startTimeMs) ||
      !Number.isFinite(event.durationMs) ||
      event.startTimeMs < 0 ||
      event.durationMs < 0,
  );
  if (invalidLayoutEvent) {
    addBudgetFailure(
      failures,
      workload,
      "layout event",
      "malformed",
      "finite non-negative start and duration values",
    );
    return failures;
  }

  const slowLayouts = chromium.layoutEvents
    .filter((event) => event.durationMs > SLOW_LAYOUT_DURATION_THRESHOLD_MS)
    .sort((left, right) => left.startTimeMs - right.startTimeMs);
  if (slowLayouts.length > MAX_SLOW_LAYOUT_COUNT) {
    addBudgetFailure(
      failures,
      workload,
      "slow layout count",
      slowLayouts.length,
      `<= ${MAX_SLOW_LAYOUT_COUNT}`,
    );
  }
  for (let index = 1; index < slowLayouts.length; index += 1) {
    const gapMs = slowLayouts[index].startTimeMs - slowLayouts[index - 1].startTimeMs;
    if (gapMs + LAYOUT_TIME_COMPARISON_EPSILON_MS < MIN_SLOW_LAYOUT_START_GAP_MS) {
      addBudgetFailure(
        failures,
        workload,
        "slow layout start gap",
        `${gapMs} ms`,
        `>= ${MIN_SLOW_LAYOUT_START_GAP_MS} ms`,
      );
    }
  }
  return failures;
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
      break;
    case "denseNarrative":
      requireCheck(check.sourceRows === 90, "dense narrative fixture row count differs");
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
export async function runRendererMatrix(page, runtime, sampleCount = 7, mode = "production") {
  if (!Number.isSafeInteger(sampleCount) || sampleCount < 1 || sampleCount > 50) {
    throw new Error("sampleCount must be an integer from 1 through 50");
  }
  const expectedPageUrl = page.url();
  await page.bringToFront();
  await installFixtureRuntime(page);
  const signalCollector = await createPageSignalCollector(page);
  const modeCollector = await createModeSignalCollector(page, mode);

  const message100 = await timeFixture(page, sampleCount, async (sample) => {
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
      const viewport = list?.querySelector(".overflow-y-auto") ?? list;
      return {
        durationMs: performance.now() - startedAt,
        check: {
          activeThreadId: fixture.workspaceStore.getState().activeThreadId,
          currentThreadId: fixture.threadStore.getState().currentThreadId,
          mountedMessages: list?.querySelectorAll("[data-message-id]").length ?? 0,
          descendants: list?.querySelectorAll("*").length ?? 0,
          viewportDescendants: viewport ? viewport.querySelectorAll("*").length : null,
          totalMessages: fixture.threadStore.getState().records.get(threadId)?.messages.length ?? 0,
          visibleThreadId: list
            ?.querySelector("[data-message-id]")
            ?.getAttribute("data-thread-id") ?? null,
        },
      };
    }, sample);
    return result;
  }, modeCollector);

  const message1000 = await timeFixture(page, sampleCount, async (sample) => {
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
      const viewport = list?.querySelector(".overflow-y-auto") ?? list;
      return {
        durationMs: performance.now() - startedAt,
        check: {
          activeThreadId: fixture.workspaceStore.getState().activeThreadId,
          currentThreadId: fixture.threadStore.getState().currentThreadId,
          mountedMessages: list?.querySelectorAll("[data-message-id]").length ?? 0,
          descendants: list?.querySelectorAll("*").length ?? 0,
          viewportDescendants: viewport ? viewport.querySelectorAll("*").length : null,
          totalMessages: fixture.threadStore.getState().records.get(threadId)?.messages.length ?? 0,
          visibleThreadId: list
            ?.querySelector("[data-message-id]")
            ?.getAttribute("data-thread-id") ?? null,
        },
      };
    }, sample);
  }, modeCollector);

  const threadSwitch = await timeFixture(page, sampleCount, async (sample) => {
    return page.evaluate(async (sampleIndex) => {
      const fixture = window.__issue1240;
      const revision = ++fixture.revision;
      const leftId = `perf-switch-left-${revision}`;
      const rightId = `perf-switch-right-${revision}`;
      fixture.activate(leftId, "Switch left", fixture.makeMessages(leftId, 1000, "left"));
      const rightThread = fixture.baseThread(rightId, "Switch right");
      const rightRecord = {
        ...fixture.recordModule.createEmptyThreadRecord(),
        messages: fixture.makeMessages(rightId, 1000, "right"),
        oldestLoadedSequence: 1,
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
      fixture.workspaceStore.getState().setActiveThread(rightId);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const list = document.querySelector('[data-testid="message-list"]');
      const viewport = list?.querySelector(".overflow-y-auto") ?? list;
      return {
        durationMs: performance.now() - startedAt,
        check: {
          activeThreadId: fixture.workspaceStore.getState().activeThreadId,
          currentThreadId: fixture.threadStore.getState().currentThreadId,
          visibleThreadId: document.querySelector("[data-message-id]")?.getAttribute("data-thread-id") ?? null,
          viewportDescendants: viewport ? viewport.querySelectorAll("*").length : null,
          sampleIndex,
        },
      };
    }, sample);
  }, modeCollector);

  const streaming = await timeFixture(page, sampleCount, async (sample) => {
    return page.evaluate(async (sampleIndex) => {
      const fixture = window.__issue1240;
      const revision = ++fixture.revision;
      const threadId = `perf-stream-${revision}`;
      fixture.activate(threadId, "Streaming fixture", fixture.makeMessages(threadId, 100, "stream"));
      const startedAt = performance.now();
      for (let index = 0; index < 200; index += 1) {
        fixture.threadStore.getState().handleAgentEvent({
          type: "textDelta",
          threadId,
          delta: `token-${index} `,
          isFinalResponse: true,
        });
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const record = fixture.threadStore.getState().records.get(threadId);
      const list = document.querySelector('[data-testid="message-list"]');
      const viewport = list?.querySelector(".overflow-y-auto") ?? list;
      const expectedText = Array.from(
        { length: 200 },
        (_, index) => `token-${index} `,
      ).join("");
      return {
        durationMs: performance.now() - startedAt,
        check: {
          expectedText,
          streamingText: record?.streaming ?? "",
          viewportDescendants: viewport ? viewport.querySelectorAll("*").length : null,
          sampleIndex,
        },
      };
    }, sample);
  }, modeCollector);

  const denseNarrative = await timeFixture(page, sampleCount, async (sample) => {
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
      const viewport = list?.querySelector(".overflow-y-auto") ?? list;
      const toolSummaries = [...document.querySelectorAll("[data-first-tool-call-id]")];
      return {
        durationMs: performance.now() - startedAt,
        check: {
          sourceRows: tools.length + thoughts.length + hooks.length,
          descendants: list?.querySelectorAll("*").length ?? 0,
          viewportDescendants: viewport ? viewport.querySelectorAll("*").length : null,
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
  }, modeCollector);

  const denseDisclosureCheck = await page.evaluate(async () => {
    const list = document.querySelector('[data-testid="message-list"]');
    const expand = [...document.querySelectorAll("button")].find((button) =>
      button.textContent?.startsWith("Browse all "),
    );
    expand?.click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const viewport = list?.querySelector(".overflow-y-auto") ?? list;
    let browseDescendants = viewport ? viewport.querySelectorAll("*").length : null;
    let pageCount = 0;
    while (pageCount < 20) {
      pageCount += 1;
      const next = [...document.querySelectorAll("button")].find((button) =>
        button.textContent === "Next" && !button.disabled,
      );
      if (!next) break;
      next.click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const currentDescendants = viewport ? viewport.querySelectorAll("*").length : null;
      if (currentDescendants !== null) {
        browseDescendants = browseDescendants === null
          ? currentDescendants
          : Math.max(browseDescendants, currentDescendants);
      }
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
      browsingViewportDescendants: browseDescendants,
    };
  });
  for (const check of denseNarrative.checks) Object.assign(check, denseDisclosureCheck);

  const markdownShiki = await timeFixture(page, sampleCount, async (sample) => {
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
      const list = document.querySelector('[data-testid="message-list"]');
      const viewport = list?.querySelector(".overflow-y-auto") ?? list;
      return {
        durationMs: performance.now() - startedAt,
        check: {
          highlightedBlocks,
          viewportDescendants: viewport ? viewport.querySelectorAll("*").length : null,
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
  }, modeCollector, { captureShiki: true, buildMode: mode });

  const panelTransitions = await timeFixture(page, sampleCount, async (sample) => {
    return page.evaluate(async (sampleIndex) => {
      const fixture = window.__issue1240;
      const revision = ++fixture.revision;
      const threadId = `perf-panel-${revision}`;
      fixture.activate(
        threadId,
        "Panel transitions fixture",
        fixture.makeMessages(threadId, 100, String(revision)),
      );
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const startedAt = performance.now();
      fixture.diffStore.getState().showRightPanel(fixture.workspaceId, threadId);
      fixture.diffStore.getState().setRightPanelTab(fixture.workspaceId, threadId, "preview");
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      fixture.diffStore.getState().setRightPanelTab(fixture.workspaceId, threadId, "terminal");
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const state = fixture.diffStore.getState().getRightPanel(fixture.workspaceId, threadId);
      const list = document.querySelector('[data-testid="message-list"]');
      const viewport = list?.querySelector(".overflow-y-auto") ?? list;
      return {
        durationMs: performance.now() - startedAt,
        check: {
          visible: state.visible,
          activeTab: state.activeTab,
          browserTabOpen: state.openTabs.includes("preview"),
          terminalTabOpen: state.openTabs.includes("terminal"),
          terminalShell: Boolean(document.querySelector('[data-testid="terminal-pool-slot"]')),
          viewportDescendants: viewport ? viewport.querySelectorAll("*").length : null,
          sampleIndex,
        },
      };
    }, sample);
  }, modeCollector);

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
      denseNarrative,
      markdownShiki,
      panelTransitions,
    }).map(([name, result]) => {
      const rawSamples = result.samples.map((durationMs, sampleIndex) => {
        const observed = result.checks[sampleIndex];
        const attribution = result.attributions[sampleIndex];
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
        const failures = [
          ...validateWorkloadCheck(name, observed, mode).map(
            (failure) => `${name} visible correctness: observed ${failure}; budget workload contract`,
          ),
          ...validateRendererBudgetSample(name, observed, attribution, mode),
          ...rowIsolationFailures.map(
            (failure) => `${name} narrative row isolation: observed ${failure}; budget affected row once and stable siblings zero`,
          ),
          ...pageFailures.map(
            (failure) => `${name} page state: observed ${failure}; budget expected URL, visibility, title, and no page errors`,
          ),
        ];
        return {
          sampleIndex,
          durationMs,
          attribution,
          correctness: {
            passed: failures.length === 0,
            failures,
            observed,
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
    metrics,
    observations,
    correctness,
  };
}
