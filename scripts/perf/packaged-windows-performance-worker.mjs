import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodeFSPromises from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
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
  const outputRoot = NodePath.resolve(repoRoot, ".dev", "verification", "performance");
  const outputFile = NodePath.resolve(repoRoot, readRequiredArgument("--output"));
  const outputRelativePath = NodePath.relative(outputRoot, outputFile);
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
  const context = await prepareWorkerContext();

  let electronSession;
  try {
    electronSession = await context.electronHelper.connectElectronSession({
      playwright: context.playwright,
      repoRoot: context.repoRoot,
      sessionFileName: context.sessionFileName,
    });
    const result = await measurePackagedSession(electronSession, context);
    await NodeFSPromises.writeFile(context.outputFile, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    if (!result.correctness.passed) process.exitCode = 1;
  } finally {
    await disconnectElectronSession(electronSession, context.electronHelper);
  }
}

async function prepareWorkerContext() {
  const repoRoot = process.cwd();
  const adapterName = readRequiredArgument("--adapter-name").trim();
  validateAdapterName(adapterName);
  const sessionFileName = readRequiredArgument("--electron-session-file");
  validateSessionFileName(sessionFileName);
  const electronVersion = readRequiredArgument("--electron-version");
  const outputFile = resolveOutputFile(repoRoot);
  await NodeFSPromises.mkdir(NodePath.dirname(outputFile), { recursive: true });
  const scratchRequire = NodeModule.createRequire(NodePath.join(repoRoot, ".dev", "playwright-scratch", "package.json"));
  const playwrightVersion = scratchRequire("playwright/package.json").version;
  return {
    repoRoot,
    adapterName,
    sessionFileName,
    outputFile,
    electronVersion,
    sampleCount: parseCount("--sample-count", 3, 20),
    gpuSampleCount: parseCount("--gpu-sample-count", 5, 300),
    accelerationMode: parseChoice("--acceleration-mode", ["disabled", "default"]),
    gpuType: parseChoice("--gpu-type", ["integrated", "discrete"]),
    playwright: scratchRequire("playwright"),
    electronHelper: await loadElectronHelper(repoRoot),
    runEnvironment: collectRunEnvironment(repoRoot, { electron: electronVersion, playwright: playwrightVersion }),
  };
}

function validateAdapterName(adapterName) {
  if (adapterName.length === 0 || adapterName.length > 256) {
    throw new Error("--adapter-name must identify one Windows video adapter");
  }
}

function validateSessionFileName(sessionFileName) {
  if (!/^electron-[a-z0-9-]+\.json$/.test(sessionFileName)) {
    throw new Error("--electron-session-file must be a safe session file name");
  }
}

function loadElectronHelper(repoRoot) {
  return import(NodeURL.pathToFileURL(NodePath.join(
    repoRoot, ".agents", "skills", "electorn-live-testing", "scripts", "electron-session.mjs",
  )).href);
}

async function measurePackagedSession(electronSession, context) {
  await electronSession.page.setViewportSize(VIEWPORT);
  const startupMetrics = await readPackagedStartupMetrics(electronSession.page, context.accelerationMode);
  const [matrix, gpu] = await Promise.all([
    runRendererMatrix(electronSession.page, "packaged-windows-electron", context.sampleCount, "production"),
    collectWindowsGpuEngineEvidence(context.repoRoot, startupMetrics.processes, context.gpuSampleCount),
  ]);
  return buildPackagedResult(context, startupMetrics, matrix, gpu);
}

async function readPackagedStartupMetrics(page, accelerationMode) {
  const metrics = await page.evaluate(async () => window.desktopBridge?.performance?.getMetrics?.() ?? null);
  if (!metrics) throw new Error("Electron performance metrics are unavailable");
  if (!metrics.packaged) throw new Error("The packaged Windows runner connected to an unpackaged app");
  if (metrics.devToolsOpen) throw new Error("The packaged Windows runner requires closed DevTools");
  if (metrics.accelerationMode !== accelerationMode) {
    throw new Error(`${accelerationMode} packaged run reported accelerationMode=${metrics.accelerationMode}`);
  }
  return metrics;
}

function buildPackagedResult(context, startupMetrics, matrix, gpu) {
  return {
    schemaVersion: 3,
    recordedAt: new Date().toISOString(),
    packaged: true,
    buildMode: "production",
    devToolsOpen: startupMetrics.devToolsOpen,
    accelerationMode: context.accelerationMode,
    gpuFeatureStatus: startupMetrics.gpuFeatureStatus,
    gpuType: context.gpuType,
    gpuClassification: resolveWindowsGpuClassification(gpu.devices, context.adapterName, context.gpuType),
    sourceRevision: context.runEnvironment.sourceRevision,
    sourceDirty: context.runEnvironment.sourceDirty,
    deviceIdentity: { hostname: NodeOS.hostname(), adapters: gpu.devices },
    comparisonContract: {
      viewport: VIEWPORT,
      workloadOrder: FRONTEND_RENDERER_WORKLOADS,
      warmupCount: WARMUP_COUNT,
      sampleCount: context.sampleCount,
      gpuSampleCount: context.gpuSampleCount,
    },
    correctness: matrix.correctness,
    frameResults: summarizeFrameResults(matrix.metrics),
    electronProcesses: startupMetrics.processes,
    gpu,
    metrics: matrix.metrics,
    observations: matrix.observations,
    environment: { ...context.runEnvironment.host, versions: context.runEnvironment.versions },
  };
}

async function disconnectElectronSession(electronSession, electronHelper) {
  if (!electronSession) return;
  try {
    await electronHelper.disconnectElectronSession(electronSession);
  } catch {
    // The parent runner still owns and stops the packaged process tree.
  }
}

try {
  await run();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}
