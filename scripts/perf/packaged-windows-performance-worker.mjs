import { createRequire } from "node:module";
import { hostname } from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  collectRunEnvironment,
  summarizeDurationSamples,
} from "./frontend-performance-collectors.mjs";
import {
  FRONTEND_RENDERER_WORKLOADS,
  runRendererMatrix,
} from "./frontend-renderer-fixture.mjs";
import {
  collectWindowsGpuEngineEvidence,
  resolveWindowsGpuClassification,
} from "./windows-gpu-engine-collector.mjs";

const VIEWPORT = Object.freeze({ width: 1440, height: 1000 });
const WARMUP_COUNT = 1;

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

function readRequiredArgument(name) {
  const value = readArgument(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseCount(name, minimum, maximum) {
  const value = Number(readRequiredArgument(name));
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function parseChoice(name, choices) {
  const value = readRequiredArgument(name);
  if (!choices.includes(value)) {
    throw new Error(`${name} must be ${choices.join(" or ")}`);
  }
  return value;
}

function resolveOutputFile(repoRoot) {
  const outputRoot = resolve(repoRoot, ".dev", "verification", "performance");
  const outputFile = resolve(repoRoot, readRequiredArgument("--output"));
  const outputRelativePath = relative(outputRoot, outputFile);
  if (
    outputRelativePath.length === 0 ||
    outputRelativePath.startsWith("..")
  ) {
    throw new Error("--output must name a file inside .dev/verification/performance");
  }
  return outputFile;
}

function summarizeFrameResults(metrics) {
  return Object.fromEntries(
    Object.entries(metrics).map(([workload, metric]) => {
      const acceptedSamples = metric.rawSamples.filter(
        (sample) => sample.correctness.passed,
      );
      const frameIntervals = acceptedSamples.flatMap(
        (sample) =>
          sample.attribution.chromium?.frameCadence.intervalsMs ?? [],
      );
      const longTasks = acceptedSamples.flatMap(
        (sample) => sample.attribution.chromium?.longTasksMs ?? [],
      );
      return [
        workload,
        {
          frameIntervals: summarizeDurationSamples(frameIntervals),
          longTasks: summarizeDurationSamples(longTasks),
        },
      ];
    }),
  );
}

async function run() {
  const repoRoot = process.cwd();
  const sampleCount = parseCount("--sample-count", 3, 20);
  const gpuSampleCount = parseCount("--gpu-sample-count", 5, 300);
  const accelerationMode = parseChoice("--acceleration-mode", ["disabled", "default"]);
  const gpuType = parseChoice("--gpu-type", ["integrated", "discrete"]);
  const adapterName = readRequiredArgument("--adapter-name").trim();
  if (adapterName.length === 0 || adapterName.length > 256) {
    throw new Error("--adapter-name must identify one Windows video adapter");
  }
  const electronVersion = readRequiredArgument("--electron-version");
  const sessionFileName = readRequiredArgument("--electron-session-file");
  if (!/^electron-[a-z0-9-]+\.json$/.test(sessionFileName)) {
    throw new Error("--electron-session-file must be a safe session file name");
  }
  const outputFile = resolveOutputFile(repoRoot);
  await mkdir(dirname(outputFile), { recursive: true });

  const scratchRequire = createRequire(
    join(repoRoot, ".dev", "playwright-scratch", "package.json"),
  );
  const playwright = scratchRequire("playwright");
  const playwrightVersion = scratchRequire("playwright/package.json").version;
  const electronHelper = await import(
    pathToFileURL(
      join(
        repoRoot,
        ".codex",
        "skills",
        "electorn-live-testing",
        "scripts",
        "electron-session.mjs",
      ),
    ).href,
  );
  const runEnvironment = collectRunEnvironment(repoRoot, {
    electron: electronVersion,
    playwright: playwrightVersion,
  });

  let electronSession;
  try {
    electronSession = await electronHelper.connectElectronSession({
      playwright,
      repoRoot,
      sessionFileName,
    });
    await electronSession.page.setViewportSize(VIEWPORT);
    const startupMetrics = await electronSession.page.evaluate(async () =>
      window.desktopBridge?.performance?.getMetrics?.() ?? null,
    );
    if (!startupMetrics) {
      throw new Error("Electron performance metrics are unavailable");
    }
    if (!startupMetrics.packaged) {
      throw new Error("The packaged Windows runner connected to an unpackaged app");
    }
    if (startupMetrics.devToolsOpen) {
      throw new Error("The packaged Windows runner requires closed DevTools");
    }
    if (startupMetrics.accelerationMode !== accelerationMode) {
      throw new Error(
        `${accelerationMode} packaged run reported accelerationMode=${startupMetrics.accelerationMode}`,
      );
    }

    const [matrix, gpu] = await Promise.all([
      runRendererMatrix(
        electronSession.page,
        "packaged-windows-electron",
        sampleCount,
        "production",
      ),
      collectWindowsGpuEngineEvidence(
        repoRoot,
        startupMetrics.processes,
        gpuSampleCount,
      ),
    ]);
    const gpuClassification = resolveWindowsGpuClassification(
      gpu.devices,
      adapterName,
      gpuType,
    );
    const result = {
      schemaVersion: 3,
      recordedAt: new Date().toISOString(),
      packaged: true,
      buildMode: "production",
      devToolsOpen: startupMetrics.devToolsOpen,
      accelerationMode,
      gpuFeatureStatus: startupMetrics.gpuFeatureStatus,
      gpuType,
      gpuClassification,
      sourceRevision: runEnvironment.sourceRevision,
      sourceDirty: runEnvironment.sourceDirty,
      deviceIdentity: {
        hostname: hostname(),
        adapters: gpu.devices,
      },
      comparisonContract: {
        viewport: VIEWPORT,
        workloadOrder: FRONTEND_RENDERER_WORKLOADS,
        warmupCount: WARMUP_COUNT,
        sampleCount,
        gpuSampleCount,
      },
      correctness: matrix.correctness,
      frameResults: summarizeFrameResults(matrix.metrics),
      electronProcesses: startupMetrics.processes,
      gpu,
      metrics: matrix.metrics,
      observations: matrix.observations,
      environment: {
        ...runEnvironment.host,
        versions: runEnvironment.versions,
      },
    };
    await writeFile(outputFile, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    if (!result.correctness.passed) process.exitCode = 1;
  } finally {
    if (electronSession) {
      try {
        await electronHelper.disconnectElectronSession(electronSession);
      } catch {
        // The parent runner still owns and stops the packaged process tree.
      }
    }
  }
}

try {
  await run();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}
