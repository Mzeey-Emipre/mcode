import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
  const outputRoot = resolve(repoRoot, ".dev", "verification", "performance");
  const requested = readArgument("--output");
  const outputFile = requested
    ? resolve(repoRoot, requested)
    : join(outputRoot, `frontend-${new Date().toISOString().replaceAll(":", "-")}.json`);
  const relativePath = relative(outputRoot, outputFile);
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
  const repoRoot = process.cwd();
  const sampleCount = parseSampleCount();
  const mode = parseMode();
  const workloads = parseWorkloads();
  const runtimes = parseRuntimes();
  const webUrl = parseWebUrl();
  const electronSessionFile = parseElectronSessionFile(runtimes.includes("electron"));
  const { outputFile, outputRoot } = resolveOutputFile(repoRoot);
  await mkdir(outputRoot, { recursive: true });

  const ports = JSON.parse(
    await readFile(join(repoRoot, ".dev", "ports.json"), "utf8"),
  );
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
    electron: process.versions.electron,
    playwright: playwrightVersion,
  });
  let browser;
  let electronSession;
  try {
    let webResult;
    if (runtimes.includes("standalone-web")) {
      browser = await playwright.chromium.launch({ headless: true });
      const context = await browser.newContext({ viewport: VIEWPORT });
      await context.addCookies([
        {
          name: ports.seedLogin.cookieName,
          value: ports.seedLogin.token,
          url: webUrl,
        },
      ]);
      const webPage = await context.newPage();
      await webPage.goto(webUrl, { waitUntil: "domcontentloaded" });
      await webPage.bringToFront();
      webResult = decorateRuntimeResult(
        await runRendererMatrix(webPage, "standalone-web", sampleCount, mode, {
          workload: workloads.join(","),
        }),
        runEnvironment,
        await collectPageEnvironment(webPage),
        mode,
        null,
      );
    }

    let electronResult;
    if (runtimes.includes("electron")) {
      electronSession = await electronHelper.connectElectronSession({
        playwright,
        repoRoot,
        sessionFileName: electronSessionFile,
      });
      await electronSession.page.setViewportSize(VIEWPORT);
      const electronStartupMetrics = await electronSession.page.evaluate(async () =>
        window.desktopBridge?.performance?.getMetrics?.() ?? null,
      );
      if (!electronStartupMetrics) {
        throw new Error("Electron performance metrics are unavailable");
      }
      if (mode === "production" && electronStartupMetrics.devToolsOpen) {
        throw new Error("Production performance mode must run without open DevTools");
      }
      await electronSession.page.bringToFront();
      electronResult = decorateRuntimeResult(
        await runRendererMatrix(electronSession.page, "electron", sampleCount, mode, {
          workload: workloads.join(","),
        }),
        runEnvironment,
        await collectPageEnvironment(electronSession.page),
        mode,
        electronStartupMetrics.accelerationMode === "default",
      );
    }
    const result = {
      schemaVersion: 2,
      recordedAt: new Date().toISOString(),
      buildMode: mode,
      comparisonContract: {
        viewport: VIEWPORT,
        workloadOrder: workloads,
        warmupCount: WARMUP_COUNT,
        sampleCount,
      },
      correctness: {
        passed: [webResult, electronResult].every((runtime) => runtime?.correctness.passed),
        rejectedSamples: [webResult, electronResult].reduce(
          (total, runtime) => total + (runtime?.correctness.rejectedSamples ?? 0),
          0,
        ),
      },
      runtimes: Object.fromEntries([
        ["standaloneWeb", webResult],
        ["electron", electronResult],
      ].filter(([, runtime]) => runtime !== undefined)),
    };
    await writeFile(outputFile, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({
      outputFile,
      correctness: result.correctness,
      sourceRevision: runEnvironment.sourceRevision,
    })}\n`);
    if (!result.correctness.passed) process.exitCode = 1;
  } finally {
    if (electronSession) {
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
    if (browser) await browser.close();
  }
  await writeFile(`${outputFile}.complete`, "complete\n", "utf8");
}

try {
  await run();
} catch (error) {
  const failureFile = resolve(
    process.cwd(),
    ".dev",
    "verification",
    "performance",
    "frontend-worker-error.json",
  );
  await mkdir(dirname(failureFile), { recursive: true });
  await writeFile(
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
