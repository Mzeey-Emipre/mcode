import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { collectRunEnvironment } from "./frontend-performance-collectors.mjs";
import {
  FRONTEND_RENDERER_WORKLOADS,
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

function decorateRuntimeResult(result, runEnvironment, pageEnvironment) {
  const environment = {
    ...runEnvironment.host,
    ...pageEnvironment,
    versions: runEnvironment.versions,
  };
  return {
    ...result,
    sourceRevision: runEnvironment.sourceRevision,
    sourceDirty: runEnvironment.sourceDirty,
    environment,
    metrics: Object.fromEntries(
      Object.entries(result.metrics).map(([workload, metric]) => [workload, {
        ...metric,
        workload,
        runtime: result.runtime,
        sourceRevision: runEnvironment.sourceRevision,
        environment,
      }]),
    ),
  };
}

async function run() {
  const repoRoot = process.cwd();
  const sampleCount = parseSampleCount();
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
    browser = await playwright.chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: VIEWPORT });
    await context.addCookies([
      {
        name: ports.seedLogin.cookieName,
        value: ports.seedLogin.token,
        url: ports.appUrl,
      },
    ]);
    const webPage = await context.newPage();
    await webPage.goto(ports.appUrl, { waitUntil: "domcontentloaded" });
    await webPage.bringToFront();

    electronSession = await electronHelper.connectElectronSession({
      playwright,
      repoRoot,
    });
    await electronSession.page.setViewportSize(VIEWPORT);

    const webResult = decorateRuntimeResult(
      await runRendererMatrix(webPage, "standalone-web", sampleCount),
      runEnvironment,
      await collectPageEnvironment(webPage),
    );
    await electronSession.page.bringToFront();
    const electronResult = decorateRuntimeResult(
      await runRendererMatrix(electronSession.page, "electron", sampleCount),
      runEnvironment,
      await collectPageEnvironment(electronSession.page),
    );
    const result = {
      schemaVersion: 1,
      recordedAt: new Date().toISOString(),
      comparisonContract: {
        viewport: VIEWPORT,
        workloadOrder: FRONTEND_RENDERER_WORKLOADS,
        warmupCount: WARMUP_COUNT,
        sampleCount,
      },
      correctness: {
        passed: webResult.correctness.passed && electronResult.correctness.passed,
        rejectedSamples:
          webResult.correctness.rejectedSamples + electronResult.correctness.rejectedSamples,
      },
      runtimes: {
        standaloneWeb: webResult,
        electron: electronResult,
      },
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
      await electronHelper.disconnectElectronSession(electronSession);
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
