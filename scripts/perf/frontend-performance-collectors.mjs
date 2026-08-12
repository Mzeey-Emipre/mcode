import { execFileSync } from "node:child_process";
import { cpus, platform, release, totalmem } from "node:os";

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
