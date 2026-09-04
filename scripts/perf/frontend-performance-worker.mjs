import * as NodeModule from "node:module";
import * as NodeFSPromises from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { collectRunEnvironment } from "./frontend-performance-collectors.mjs";
import {
  normalizeFrontendRendererRuntimes,
  normalizeFrontendRendererWorkloads,
  runRendererMatrix,
} from "./frontend-renderer-fixture.mjs";

const VIEWPORT = Object.freeze({ width: 1440, height: 1000 });
const WARMUP_COUNT = 1;

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

function parseSampleCount() {
  const value = Number(readArgument("--sample-count") ?? "7");
  if (!Number.isSafeInteger(value) || value < 1 || value > 50) {
    throw new Error("--sample-count must be an integer from 1 through 50");
  }
  return value;
}

function parseMode() {
  const mode = readArgument("--mode");
  if (mode !== "profiling" && mode !== "production") {
    throw new Error("--mode must be profiling or production");
  }
  return mode;
}

function parseWorkloads() {
  return normalizeFrontendRendererWorkloads(readArgument("--workload"));
}

function parseRuntimes() {
  return normalizeFrontendRendererRuntimes(readArgument("--runtime"));
}

function parseWebUrl() {
  const value = readArgument("--web-url");
  if (!value) throw new Error("--web-url is required");
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port) {
    throw new Error("--web-url must be a loopback HTTP URL with an explicit port");
  }
  return url.origin;
}

function parseElectronSessionFile(required) {
  const value = readArgument("--electron-session-file");
  if (!required && value == null) return null;
  if (!value || !/^electron-[a-z0-9-]+\.json$/.test(value)) {
    throw new Error("--electron-session-file must be a safe session file name");
  }
  return value;
}

function resolveOutputFile(repoRoot) {
  const outputRoot = NodePath.resolve(repoRoot, ".dev", "verification", "performance");
  const requested = readArgument("--output");
  const outputFile = requested
    ? NodePath.resolve(repoRoot, requested)
    : NodePath.join(outputRoot, `frontend-${new Date().toISOString().replaceAll(":", "-")}.json`);
  const relativePath = NodePath.relative(outputRoot, outputFile);
  if (relativePath.length === 0 || relativePath.startsWith("..")) {
    throw new Error("--output must name a file inside .dev/verification/performance");
  }
  return { outputFile, outputRoot };
}

async function collectPageEnvironment(page) {
  return page.evaluate(() => ({
    deviceMemoryGiB: navigator.deviceMemory ?? null,
    hardwareConcurrency: navigator.hardwareConcurrency,
    userAgent: navigator.userAgent,
  }));
}

function decorateRuntimeResult(
  result,
  runEnvironment,
  pageEnvironment,
  mode,
  hardwareAccelerationState,
) {
  const environment = {
    ...runEnvironment.host,
    ...pageEnvironment,
    versions: runEnvironment.versions,
  };
  return {
    ...result,
    sourceRevision: runEnvironment.sourceRevision,
    sourceDirty: runEnvironment.sourceDirty,
    buildMode: mode,
    hardwareAccelerationState,
    environment,
    metrics: Object.fromEntries(
      Object.entries(result.metrics).map(([workload, metric]) => [workload, {
        ...metric,
        workload,
        runtime: result.runtime,
        buildMode: mode,
        hardwareAccelerationState,
        warmupCount: WARMUP_COUNT,
        sampleCount: result.sampleCount,
        sourceRevision: runEnvironment.sourceRevision,
        environment,
      }]),
    ),
  };
}

async function run() {
  const context = await prepareWorkerContext();
  let browser;
  let electronSession;
  let browserResult;
  let electronResult;
  try {
    ({ browser, result: browserResult } = await runStandaloneWeb(context));
    ({ electronSession, result: electronResult } = await runElectron(context));
    const result = buildWorkerResult(context, browserResult, electronResult);
    const invalidLifecycleCandidate = hasInvalidLifecycleCandidate(result);
    await NodeFSPromises.writeFile(context.outputFile, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({
      outputFile: context.outputFile,
      correctness: result.correctness,
      invalidLifecycleCandidate,
      sourceRevision: context.runEnvironment.sourceRevision,
    })}\n`);
    if (!result.correctness.passed || invalidLifecycleCandidate) process.exitCode = 1;
  } finally {
    await closeElectronSession(electronSession, context.electronHelper);
    if (browser) await browser.close();
  }
  await NodeFSPromises.writeFile(`${context.outputFile}.complete`, "complete\n", "utf8");
}

async function prepareWorkerContext() {
  const repoRoot = process.cwd();
  const runtimes = parseRuntimes();
  const { outputFile, outputRoot } = resolveOutputFile(repoRoot);
  await NodeFSPromises.mkdir(outputRoot, { recursive: true });
  const scratchRequire = NodeModule.createRequire(NodePath.join(repoRoot, ".dev", "playwright-scratch", "package.json"));
  const playwright = scratchRequire("playwright");
  const playwrightVersion = scratchRequire("playwright/package.json").version;
  return {
    repoRoot,
    sampleCount: parseSampleCount(),
    mode: parseMode(),
    workloads: parseWorkloads(),
    runtimes,
    webUrl: parseWebUrl(),
    electronSessionFile: parseElectronSessionFile(runtimes.includes("electron")),
    outputFile,
    ports: JSON.parse(await NodeFSPromises.readFile(NodePath.join(repoRoot, ".dev", "ports.json"), "utf8")),
    playwright,
    electronHelper: await loadElectronHelper(repoRoot),
    runEnvironment: collectRunEnvironment(repoRoot, {
      electron: process.versions.electron,
      playwright: playwrightVersion,
    }),
  };
}

function loadElectronHelper(repoRoot) {
  return import(NodeURL.pathToFileURL(NodePath.join(
    repoRoot, ".agents", "skills", "electorn-live-testing", "scripts", "electron-session.mjs",
  )).href);
}

async function runStandaloneWeb(context) {
  if (!context.runtimes.includes("standalone-web")) return { browser: undefined, result: undefined };
  const browser = await context.playwright.chromium.launch({ headless: true });
  const page = await createStandaloneWebPage(browser, context.ports.seedLogin, context.webUrl);
  const result = decorateRuntimeResult(
    await runRendererMatrix(page, "standalone-web", context.sampleCount, context.mode, {
      workload: context.workloads.join(","),
    }),
    context.runEnvironment,
    await collectPageEnvironment(page),
    context.mode,
    null,
  );
  return { browser, result };
}

async function createStandaloneWebPage(browser, seedLogin, webUrl) {
  const browserContext = await browser.newContext({ viewport: VIEWPORT });
  await browserContext.addCookies([{ name: seedLogin.cookieName, value: seedLogin.token, url: webUrl }]);
  const page = await browserContext.newPage();
  await page.goto(webUrl, { waitUntil: "domcontentloaded" });
  await page.bringToFront();
  return page;
}

async function runElectron(context) {
  if (!context.runtimes.includes("electron")) return { electronSession: undefined, result: undefined };
  const electronSession = await context.electronHelper.connectElectronSession({
    playwright: context.playwright,
    repoRoot: context.repoRoot,
    sessionFileName: context.electronSessionFile,
  });
  await electronSession.page.setViewportSize(VIEWPORT);
  const metrics = await readElectronStartupMetrics(electronSession.page, context.mode);
  await electronSession.page.bringToFront();
  const result = decorateRuntimeResult(
    await runRendererMatrix(electronSession.page, "electron", context.sampleCount, context.mode, {
      workload: context.workloads.join(","),
    }),
    context.runEnvironment,
    await collectPageEnvironment(electronSession.page),
    context.mode,
    metrics.accelerationMode === "default",
  );
  return { electronSession, result };
}

async function readElectronStartupMetrics(page, mode) {
  const metrics = await page.evaluate(async () => window.desktopBridge?.performance?.getMetrics?.() ?? null);
  if (!metrics) throw new Error("Electron performance metrics are unavailable");
  if (mode === "production" && metrics.devToolsOpen) {
    throw new Error("Production performance mode must run without open DevTools");
  }
  return metrics;
}

function buildWorkerResult(context, browserResult, electronResult) {
  const entries = [["standaloneWeb", browserResult], ["electron", electronResult]]
    .filter(([, runtime]) => runtime !== undefined);
  const runtimes = entries.map(([, runtime]) => runtime);
  return {
    schemaVersion: 2,
    recordedAt: new Date().toISOString(),
    buildMode: context.mode,
    comparisonContract: {
      viewport: VIEWPORT,
      workloadOrder: context.workloads,
      warmupCount: WARMUP_COUNT,
      sampleCount: context.sampleCount,
    },
    correctness: buildCorrectness(runtimes),
    runtimes: Object.fromEntries(entries),
  };
}

function buildCorrectness(runtimes) {
  return {
    passed: runtimes.every((runtime) => runtime.correctness.passed),
    rejectedSamples: runtimes.reduce((total, runtime) => total + runtime.correctness.rejectedSamples, 0),
  };
}

function hasInvalidLifecycleCandidate(result) {
  return Object.values(result.runtimes).some((runtime) => {
    const decision = runtime.metrics.vlistLifecycle?.gateDecision;
    return decision != null && (
      decision.status !== "accepted" || decision.candidateEligible !== true || decision.reason !== null
    );
  });
}

async function closeElectronSession(electronSession, electronHelper) {
  if (!electronSession) return;
  try {
    await electronSession.page.evaluate(async () => {
      await window.desktopBridge?.performance?.quit?.();
    });
  } catch {
    // The target can close before the quit IPC response reaches the renderer.
  }
  try {
    await electronHelper.disconnectElectronSession(electronSession);
  } catch {
    // A graceful application quit closes the CDP connection first.
  }
}

try {
  await run();
} catch (error) {
  const failureFile = NodePath.resolve(
    process.cwd(),
    ".dev",
    "verification",
    "performance",
    "frontend-worker-error.json",
  );
  await NodeFSPromises.mkdir(NodePath.dirname(failureFile), { recursive: true });
  await NodeFSPromises.writeFile(
    failureFile,
    `${JSON.stringify({
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null,
    }, null, 2)}\n`,
    "utf8",
  );
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}
