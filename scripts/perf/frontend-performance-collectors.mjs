import { execFileSync } from "node:child_process";
import { cpus, platform, release, totalmem } from "node:os";

/** Maximum Chromium trace events retained for one renderer sample. */
export const MAX_CHROMIUM_TRACE_EVENTS = 10_000;

const CHROMIUM_TRACE_STYLE_EVENTS = new Set(["RecalculateStyles", "UpdateLayoutTree"]);
const CHROMIUM_TRACE_LAYOUT_EVENTS = new Set(["Layout"]);
const CHROMIUM_TRACE_PAINT_EVENTS = new Set(["Paint", "PaintImage", "CompositeLayers"]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function percentile(sortedSamples, quantile) {
  return sortedSamples[Math.ceil(sortedSamples.length * quantile) - 1] ?? Number.NaN;
}

/** Summarizes one accepted duration sample set in milliseconds. */
export function summarizeDurationSamples(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    return null;
  }
  if (samples.some((sample) => !Number.isFinite(sample) || sample < 0)) {
    throw new Error("Duration samples must contain finite non-negative numbers");
  }

  const sorted = [...samples].sort((left, right) => left - right);
  return {
    sampleCount: sorted.length,
    minMs: sorted[0],
    medianMs: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted.at(-1),
  };
}

/** Captures console, page, and browser performance signals without changing product state. */
export async function createPageSignalCollector(page) {
  const consoleErrors = [];
  const pageErrors = [];
  const onConsole = (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  };
  const onPageError = (error) => pageErrors.push(String(error));
  page.on("console", onConsole);
  page.on("pageerror", onPageError);

  await page.evaluate(() => {
    window.__mcodeFrontendPerformanceSignals = {
      longTasks: [],
      layoutShifts: [],
    };
    new PerformanceObserver((list) => {
      window.__mcodeFrontendPerformanceSignals.longTasks.push(
        ...list.getEntries().map((entry) => entry.duration),
      );
    }).observe({ type: "longtask", buffered: true });
    new PerformanceObserver((list) => {
      window.__mcodeFrontendPerformanceSignals.layoutShifts.push(
        ...list.getEntries().map((entry) => entry.value),
      );
    }).observe({ type: "layout-shift", buffered: true });
  });

  return {
    /** Reads the current signals as serializable data. */
    async read() {
      const browserSignals = await page.evaluate(() => ({
        documentDescendants: document.querySelectorAll("*").length,
        layoutShifts: window.__mcodeFrontendPerformanceSignals?.layoutShifts ?? [],
        longTasks: window.__mcodeFrontendPerformanceSignals?.longTasks ?? [],
        pageState: {
          title: document.title,
          url: window.location.href,
          visibility: document.visibilityState,
        },
        totalJsHeapBytes: performance.memory?.totalJSHeapSize ?? null,
        usedJsHeapBytes: performance.memory?.usedJSHeapSize ?? null,
      }));
      return {
        ...browserSignals,
        consoleErrors: [...consoleErrors],
        pageErrors: [...pageErrors],
      };
    },

    /** Removes the Playwright listeners owned by this collector. */
    dispose() {
      page.off("console", onConsole);
      page.off("pageerror", onPageError);
    },
  };
}

function metricMap(metrics) {
  return new Map(metrics.map(({ name, value }) => [name, value]));
}

function metricDelta(before, after, name) {
  const beforeValue = before.get(name);
  const afterValue = after.get(name);
  return Number.isFinite(beforeValue) && Number.isFinite(afterValue)
    ? Math.max(0, (afterValue - beforeValue) * 1_000)
    : null;
}

function durationSummary(samples) {
  return samples.length > 0 ? summarizeDurationSamples(samples) : null;
}

async function installAttributionRuntime(page) {
  await page.evaluate(() => {
    const longTaskObserverAvailable =
      Array.isArray(PerformanceObserver.supportedEntryTypes) &&
      PerformanceObserver.supportedEntryTypes.includes("longtask");
    const state = {
      commits: [],
      frameTimes: [],
      longTasks: [],
      longTaskObserverAvailable,
      rowRenders: {},
    };
    window.__mcodePerformanceAttribution = state;
    window.__mcodeReactPerformanceSink = {
      recordCommit(commit) {
        state.commits.push(commit);
      },
      recordRowRender(rowId) {
        state.rowRenders[rowId] = (state.rowRenders[rowId] ?? 0) + 1;
      },
    };
    if (longTaskObserverAvailable) {
      new PerformanceObserver((list) => {
        state.longTasks.push(...list.getEntries().map((entry) => entry.duration));
      }).observe({ type: "longtask", buffered: true });
    }
    const recordFrame = (timestamp) => {
      state.frameTimes.push(timestamp);
      if (state.frameTimes.length > 10_000) state.frameTimes.splice(0, 5_000);
      requestAnimationFrame(recordFrame);
    };
    requestAnimationFrame(recordFrame);
  });
}

async function resetAttributionRuntime(page) {
  return page.evaluate(() => {
    const state = window.__mcodePerformanceAttribution;
    if (!state) throw new Error("Performance attribution runtime is not installed");
    state.commits = [];
    state.rowRenders = {};
    return {
      frameIndex: state.frameTimes.length,
      longTaskIndex: state.longTasks.length,
    };
  });
}

async function readAttributionRuntime(page, indexes) {
  return page.evaluate(({ frameIndex, longTaskIndex }) => {
    const state = window.__mcodePerformanceAttribution;
    if (!state) throw new Error("Performance attribution runtime is not installed");
    return {
      commits: [...state.commits],
      frameTimes: state.frameTimes.slice(frameIndex),
      longTasks: state.longTasks.slice(longTaskIndex),
      longTaskObserverAvailable: state.longTaskObserverAvailable,
      rowRenders: { ...state.rowRenders },
    };
  }, indexes);
}

function summarizeFrames(frameTimes) {
  const intervals = frameTimes.slice(1).map((time, index) => time - frameTimes[index]);
  return {
    intervalsMs: intervals,
    summary: durationSummary(intervals),
  };
}

/** Converts Chromium trace events into bounded aggregate and individual layout signals. */
export function summarizeChromiumTrace(
  events,
  {
    totalEventCount = events?.length,
    traceEventsTruncated = false,
    malformedTraceEventCount: additionalMalformedTraceEventCount = 0,
  } = {},
) {
  if (!Array.isArray(events)) {
    throw new TypeError("Chromium trace events must be an array");
  }
  if (events.length > MAX_CHROMIUM_TRACE_EVENTS) {
    throw new RangeError(
      `Chromium trace events cannot exceed ${MAX_CHROMIUM_TRACE_EVENTS} retained events`,
    );
  }
  if (
    !Number.isSafeInteger(totalEventCount) ||
    totalEventCount < 0 ||
    totalEventCount < events.length
  ) {
    throw new TypeError("Chromium trace event count must be a bounded non-negative count");
  }
  if (typeof traceEventsTruncated !== "boolean") {
    throw new TypeError("Chromium trace truncation must be a boolean");
  }
  if (
    !Number.isSafeInteger(additionalMalformedTraceEventCount) ||
    additionalMalformedTraceEventCount < 0
  ) {
    throw new TypeError("Malformed Chromium trace event count must be non-negative");
  }
  const durations = { style: 0, layout: 0, paint: 0 };
  const durationCounts = { style: 0, layout: 0, paint: 0 };
  const layoutEvents = [];
  let layoutEventCount = 0;
  let malformedTraceEventCount = 0;
  let malformedLayoutEventCount = 0;
  for (const event of events) {
    if (!isPlainObject(event)) {
      malformedTraceEventCount += 1;
      continue;
    }
    if (event.ph !== "X") continue;
    const isLayout = CHROMIUM_TRACE_LAYOUT_EVENTS.has(event.name);
    const metric = CHROMIUM_TRACE_STYLE_EVENTS.has(event.name)
      ? "style"
      : isLayout
        ? "layout"
        : CHROMIUM_TRACE_PAINT_EVENTS.has(event.name)
          ? "paint"
          : null;
    if (!metric) continue;
    if (isLayout) layoutEventCount += 1;
    if (
      !Number.isFinite(event.ts) ||
      event.ts < 0 ||
      !Number.isFinite(event.dur) ||
      event.dur < 0
    ) {
      malformedTraceEventCount += 1;
      if (isLayout) malformedLayoutEventCount += 1;
      continue;
    }
    durations[metric] += event.dur / 1_000;
    durationCounts[metric] += 1;
    if (isLayout) {
      layoutEvents.push({
        startTimeMs: event.ts / 1_000,
        durationMs: event.dur / 1_000,
      });
    }
  }
  return {
    styleMs: durationCounts.style > 0 ? durations.style : null,
    layoutMs: durationCounts.layout > 0 ? durations.layout : null,
    paintMs: durationCounts.paint > 0 ? durations.paint : null,
    traceEventCount: totalEventCount,
    retainedTraceEventCount: events.length,
    traceEventsTruncated: traceEventsTruncated || totalEventCount > events.length,
    layoutEventCount,
    layoutEvents,
    malformedTraceEventCount: malformedTraceEventCount + additionalMalformedTraceEventCount,
    malformedLayoutEventCount,
  };
}

async function readElectronProcessMetrics(page) {
  return page.evaluate(async () => {
    return window.desktopBridge?.performance?.getMetrics?.() ?? null;
  });
}

/** Creates the mode-specific React, Chromium, and Electron process collector. */
export async function createModeSignalCollector(page, mode) {
  if (mode !== "profiling" && mode !== "production") {
    throw new Error("mode must be profiling or production");
  }
  await installAttributionRuntime(page);
  let session = null;
  const ensureSession = async () => {
    if (!session) session = await page.context().newCDPSession(page);
    await session.send("Performance.enable");
    return session;
  };
  return {
    /** Measures one sample and optionally extracts trace-only browser stages. */
    async measure(operation, options = {}) {
      const indexes = await resetAttributionRuntime(page);
      const traceEnabled = mode === "production" || options.trace === true;
      const activeSession = traceEnabled ? await ensureSession() : null;
      const before = activeSession && mode === "production"
        ? metricMap((await activeSession.send("Performance.getMetrics")).metrics)
        : null;
      const processBefore = mode === "production" ? await readElectronProcessMetrics(page) : null;
      const traceEvents = [];
      let traceEventCount = 0;
      let traceEventsTruncated = false;
      let malformedTraceBatchCount = 0;
      const onTraceData = (payload) => {
        const value = payload?.value;
        if (!Array.isArray(value)) {
          malformedTraceBatchCount += 1;
          return;
        }
        traceEventCount += value.length;
        const remainingCapacity = MAX_CHROMIUM_TRACE_EVENTS - traceEvents.length;
        if (remainingCapacity > 0) traceEvents.push(...value.slice(0, remainingCapacity));
        if (traceEventCount > traceEvents.length) traceEventsTruncated = true;
      };
      if (activeSession) {
        activeSession.on("Tracing.dataCollected", onTraceData);
        await activeSession.send("Tracing.start", {
          categories: "devtools.timeline,blink.user_timing,disabled-by-default-devtools.timeline.frame",
          transferMode: "ReportEvents",
        });
      }
      let result;
      try {
        result = await operation();
      } finally {
        if (activeSession) {
          const completed = new Promise((resolveComplete) => {
            activeSession.once("Tracing.tracingComplete", resolveComplete);
          });
          await activeSession.send("Tracing.end");
          await completed;
          activeSession.off("Tracing.dataCollected", onTraceData);
        }
      }
      const processAfter = mode === "production" ? await readElectronProcessMetrics(page) : null;
      const after = activeSession && mode === "production"
        ? metricMap((await activeSession.send("Performance.getMetrics")).metrics)
        : null;
      const signals = await readAttributionRuntime(page, indexes);
      const traceSummary = () => summarizeChromiumTrace(traceEvents, {
        totalEventCount: traceEventCount,
        traceEventsTruncated,
        malformedTraceEventCount: malformedTraceBatchCount,
      });
      const chromium = mode === "production"
        ? {
            scriptingMs: metricDelta(before, after, "ScriptDuration"),
            layoutMs: metricDelta(before, after, "LayoutDuration"),
            taskMs: metricDelta(before, after, "TaskDuration"),
            longTasksMs: signals.longTasks,
            longTaskObserverAvailable: signals.longTaskObserverAvailable,
            frameCadence: summarizeFrames(signals.frameTimes),
            ...traceSummary(),
          }
        : traceEnabled
          ? { ...traceSummary(), longTasksMs: signals.longTasks }
          : null;
      return {
        result,
        attribution: {
          react: mode === "profiling"
            ? { commits: signals.commits, rowRenders: signals.rowRenders }
            : null,
          chromium,
          electronProcess: processBefore && processAfter
            ? { before: processBefore, after: processAfter }
            : null,
          gpu: null,
        },
      };
    },
    async dispose() {
      if (session) await session.detach();
    },
  };
}

/** Returns stable host and source metadata for a performance result. */
export function collectRunEnvironment(repoRoot, runtimeVersions = {}) {
  const cpuList = cpus();
  const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim().length > 0;

  return {
    sourceRevision,
    sourceDirty: dirty,
    host: {
      arch: process.arch,
      cpuCount: cpuList.length,
      cpuModel: cpuList[0]?.model ?? "unknown",
      memoryBytes: totalmem(),
      platform: platform(),
      release: release(),
    },
    versions: {
      node: process.versions.node,
      ...runtimeVersions,
    },
  };
}
