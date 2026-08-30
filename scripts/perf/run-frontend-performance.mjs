import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { agentDown } from "../agent/agent-down.mjs";
import { readPortsFile } from "../agent/runtime-contract.mjs";
import { ensurePlaywright } from "../../.codex/skills/electorn-live-testing/scripts/ensure-playwright.mjs";
import { startElectron } from "../../.codex/skills/electorn-live-testing/scripts/start-electron.mjs";
import { stopElectron } from "../../.codex/skills/electorn-live-testing/scripts/stop-electron.mjs";
import {
  normalizeFrontendRendererRuntimes,
  normalizeFrontendRendererWorkloads,
} from "./frontend-renderer-fixture.mjs";

const POLL_INTERVAL_MS = 250;

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

function parseSampleCount() {
  const value = Number(readArgument("--sample-count") ?? "7");
  if (!Number.isSafeInteger(value) || value < 3 || value > 20) {
    throw new Error("--sample-count must be an integer from 3 through 20");
  }
  return value;
}

/** Parses the required renderer build mode. */
export function parsePerformanceMode() {
  const value = readArgument("--mode") ?? "production";
  if (value !== "profiling" && value !== "production") {
    throw new Error("--mode must be profiling or production");
  }
  return value;
}

/** Parses the optional frontend workload filter. */
export function parseFrontendPerformanceWorkloads() {
  return normalizeFrontendRendererWorkloads(readArgument("--workload"));
}

/** Parses the optional frontend runtime filter. */
export function parseFrontendPerformanceRuntimes() {
  return normalizeFrontendRendererRuntimes(readArgument("--runtime"));
}

function resolveOutputFile(repoRoot) {
  const outputRoot = resolve(repoRoot, ".dev", "verification", "performance");
  const requested = readArgument("--output");
  const outputFile = requested
    ? resolve(repoRoot, requested)
    : join(outputRoot, "frontend-latest.json");
  const relativePath = relative(outputRoot, outputFile);
  if (
    relativePath.length === 0 ||
    relativePath.startsWith("..") ||
    resolve(outputFile) === outputRoot
  ) {
    throw new Error("--output must name a file inside .dev/verification/performance");
  }
  return outputFile;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", rejectCommand);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveCommand();
        return;
      }
      rejectCommand(
        new Error(
          `${command} exited with code ${code ?? "none"} and signal ${signal ?? "none"}`,
        ),
      );
    });
  });
}

async function isRuntimeReady(repoRoot) {
  const ports = readPortsFile(repoRoot);
  if (!ports) return false;
  try {
    if (
      resolve(ports.worktreeIdentity).toLowerCase() !== repoRoot.toLowerCase() ||
      !ports.healthUrl.startsWith("http://127.0.0.1:") ||
      !ports.appUrl.startsWith("http://127.0.0.1:")
    ) {
      return false;
    }
    const [health, app] = await Promise.all([
      fetch(ports.healthUrl),
      fetch(ports.appUrl),
    ]);
    return health.ok && app.ok;
  } catch {
    return false;
  }
}

async function ensureRuntime(repoRoot) {
  if (await isRuntimeReady(repoRoot)) return false;
  await runCommand(
    process.execPath,
    ["scripts/agent/agent-up.mjs", "--quiet"],
    {
      cwd: repoRoot,
      env: { ...process.env, BUN_BE_BUN: "1" },
    },
  );
  if (!(await isRuntimeReady(repoRoot))) {
    throw new Error("The worktree runtime did not become ready");
  }
  return true;
}

async function waitForWorker(outputFile, failureFile, sampleCount) {
  const completionFile = `${outputFile}.complete`;
  const timeoutMs = 120_000 + sampleCount * 120_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(failureFile)) {
      const failure = JSON.parse(readFileSync(failureFile, "utf8"));
      throw new Error(`Frontend performance worker failed: ${failure.message}`);
    }
    if (existsSync(completionFile)) {
      return JSON.parse(readFileSync(outputFile, "utf8"));
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, POLL_INTERVAL_MS));
  }
  throw new Error(`Frontend performance worker exceeded ${timeoutMs} ms`);
}

async function startBuiltRendererServer(root, port) {
  const child = spawn(
    process.execPath,
    [
      join(root, "scripts", "perf", "frontend-performance-server.mjs"),
      "--root",
      join(root, "apps", "desktop", "dist", "renderer"),
      "--contract",
      join(root, ".dev", "ports.json"),
      "--port",
      String(port),
    ],
    {
      cwd: root,
      shell: false,
      stdio: ["ignore", "ignore", "inherit"],
      windowsHide: true,
    },
  );
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Built renderer server exited with code ${child.exitCode}`);
    }
    try {
      if ((await fetch(url)).ok) return { child, url };
    } catch {
      // The connection can fail while the bounded local server starts.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, POLL_INTERVAL_MS));
  }
  child.kill();
  throw new Error("Built renderer server did not become ready within 30 seconds");
}

function waitForExpectedExit(child, label, expectedExitCode) {
  if (child.exitCode !== null) {
    return child.exitCode === expectedExitCode
      ? Promise.resolve()
      : Promise.reject(new Error(`${label} exited with code ${child.exitCode}`));
  }
  return new Promise((resolveExit, rejectExit) => {
    child.once("exit", (code, signal) => {
      if (code === expectedExitCode) resolveExit();
      else rejectExit(new Error(`${label} exited with code ${code ?? "none"} and signal ${signal ?? "none"}`));
    });
  });
}

/** Returns the process exit code for harness failures and invalid lifecycle candidates. */
export function getFrontendPerformanceExitCode(result) {
  const invalidLifecycleCandidate = Object.values(result?.runtimes ?? {}).some((runtime) => {
    const decision = runtime.metrics?.vlistLifecycle?.gateDecision;
    return decision != null
      && (decision.status !== "accepted"
        || decision.candidateEligible !== true
        || decision.reason !== null);
  });
  return result?.correctness?.passed === true && !invalidLifecycleCandidate ? 0 : 1;
}

function printResult(result, outputFile) {
  process.stdout.write(`Frontend performance result: ${outputFile}\n`);
  for (const [runtimeName, runtime] of Object.entries(result.runtimes)) {
    process.stdout.write(`${runtimeName}: correctness=${runtime.correctness.passed}\n`);
    for (const workload of result.comparisonContract.workloadOrder) {
      printWorkloadResult(workload, runtime.metrics[workload]);
    }
  }
}

function printWorkloadResult(workload, metric) {
  if (workload === "vlistLifecycle") {
    printVListLifecycleResult(metric);
    return;
  }
  const median = metric.summary ? `${metric.summary.medianMs.toFixed(1)} ms` : "rejected";
  process.stdout.write(`  ${workload}: median=${median}, rejected=${metric.correctness.rejectedSamples}\n`);
  printShikiAttribution(metric.shikiAttribution);
}

function printVListLifecycleResult(metric) {
  const decision = metric.gateDecision;
  process.stdout.write(
    `  vlistLifecycle: harness=${metric.correctness.passed}, candidate=${decision?.status ?? "invalid"}, ` +
    `eligible=${decision?.candidateEligible ?? false}, timing ignored\n`,
  );
}

function printShikiAttribution(attribution) {
  if (!attribution) return;
  process.stdout.write(
    `    Shiki largest=${attribution.largestStage ?? "none"}; ` +
    `stageOver50=${JSON.stringify(attribution.stageObservationsOver50Ms)}; ` +
    `longTasksOver50=${JSON.stringify(attribution.longTasksOver50Ms)}\n`,
  );
}

/** Runs the paired standalone-web and Electron renderer matrix. */
export async function runFrontendPerformance(repoRoot = process.cwd()) {
  const root = resolve(repoRoot);
  const options = readFrontendPerformanceOptions(root);
  const state = { startedRuntime: false, startedElectron: false, rendererServer: null };
  try {
    const electronRecord = await startFrontendPerformanceResources(root, options, state);
    const result = await runFrontendPerformanceWorker(root, options, state.rendererServer, electronRecord);
    const exitCode = getFrontendPerformanceExitCode(result);
    printResult(result, options.outputFile);
    if (exitCode !== 0) process.exitCode = exitCode;
    return result;
  } finally {
    await stopFrontendPerformanceResources(root, options, state);
  }
}

function readFrontendPerformanceOptions(root) {
  const mode = parsePerformanceMode();
  const outputFile = resolveOutputFile(root);
  const failureFile = resolve(root, ".dev", "verification", "performance", "frontend-worker-error.json");
  const options = {
    sampleCount: parseSampleCount(),
    mode,
    workloads: parseFrontendPerformanceWorkloads(),
    runtimes: parseFrontendPerformanceRuntimes(),
    outputFile,
    failureFile,
    sessionFileName: `electron-performance-${mode}.json`,
  };
  for (const artifact of [outputFile, `${outputFile}.complete`, failureFile]) rmSync(artifact, { force: true });
  return options;
}

async function startFrontendPerformanceResources(root, options, state) {
  state.startedRuntime = await ensureRuntime(root);
  ensurePlaywright(root);
  await buildFrontendPerformanceApp(root, options.mode);
  state.rendererServer = await startRendererPerformanceServer(root);
  if (!options.runtimes.includes("electron")) return undefined;
  const sessionPath = join(root, ".dev", options.sessionFileName);
  if (existsSync(sessionPath)) stopElectron(root, { sessionFileName: options.sessionFileName });
  const record = await startElectron(root, {
    performanceMode: options.mode,
    rendererUrl: null,
    sessionFileName: options.sessionFileName,
  });
  state.startedElectron = true;
  return record;
}

async function buildFrontendPerformanceApp(root, mode) {
  await runCommand(process.execPath, ["run", "--cwd", "apps/desktop", "build"], {
    cwd: root,
    env: {
      ...process.env,
      MCODE_FRONTEND_PERFORMANCE_MODE: mode,
      VITE_MCODE_PERFORMANCE_MODE: mode,
      VITE_MCODE_SINGLE_INSTANCE: "1",
    },
  });
}

async function startRendererPerformanceServer(root) {
  const runtimeContract = await import("../agent/runtime-contract.mjs");
  const webPort = await runtimeContract.findAvailablePort(
    runtimeContract.computeDeterministicPort(root, 44_000),
  );
  return startBuiltRendererServer(root, webPort);
}

async function runFrontendPerformanceWorker(root, options, rendererServer, electronRecord) {
  const worker = spawn(
    electronRecord?.executablePath ?? process.execPath,
    frontendPerformanceWorkerArguments(root, options, rendererServer.url),
    {
      cwd: root,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    },
  );
  const launchFailure = new Promise((_, rejectWorker) => {
    worker.once("error", (error) => rejectWorker(new Error(`Frontend performance worker launch failed: ${error.message}`)));
  });
  const result = await Promise.race([
    waitForWorker(options.outputFile, options.failureFile, options.sampleCount),
    launchFailure,
  ]);
  await waitForExpectedExit(worker, "Frontend performance worker", getFrontendPerformanceExitCode(result));
  return result;
}

function frontendPerformanceWorkerArguments(root, options, webUrl) {
  const args = [
    join(root, "scripts", "perf", "frontend-performance-worker.mjs"),
    "--sample-count", String(options.sampleCount), "--mode", options.mode,
    "--workload", options.workloads.join(","), "--runtime", options.runtimes.join(","),
    "--web-url", webUrl, "--output", options.outputFile,
  ];
  if (options.runtimes.includes("electron")) args.push("--electron-session-file", options.sessionFileName);
  return args;
}

async function stopFrontendPerformanceResources(root, options, state) {
  if (state.startedElectron) stopElectron(root, { sessionFileName: options.sessionFileName });
  if (state.rendererServer?.child && state.rendererServer.child.exitCode === null) state.rendererServer.child.kill();
  if (state.startedRuntime) await agentDown(root);
}

if (import.meta.main) {
  await runFrontendPerformance();
}
