#!/usr/bin/env bun
/**
 * Starts a self-contained per-worktree runtime for automation agents.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  buildPortsContract,
  buildRuntimeStateEnv,
  assertRuntimeDirectorySafe,
  assertRuntimeFileSafe,
  assertRuntimeRootSafe,
  computeAvailablePorts,
  ensureRuntimeRoot,
  generateInstanceToken,
  getRuntimePaths,
  resolveRepoRoot,
  writePortsFile,
} from "./runtime-contract.mjs";
import { stopPid } from "./runtime-processes.mjs";
import { stopRecordedRuntimePids } from "./agent-down.mjs";
import { MANAGED_DESKTOP_SESSION_FILE, startManagedDesktop, stopManagedDesktop } from "./managed-desktop.mjs";
import { isFixtureRepo } from "./fixture-repo.mjs";
import { hasRuntimeDatabaseMarker } from "./runtime-database.mjs";
import {
  prepareRuntimeDirectories as prepareSharedRuntimeDirectories,
  resolveElectronBinary as resolveSharedElectronBinary,
  resolveElectronBinding,
  waitForHttpOk as waitForSharedHttpOk,
} from "../runtime/launch-mechanics.mjs";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const rootDir = NodePath.resolve(__dirname, "..", "..");
let agentUpTestHooks = {};

/** Resolves the explicit web-automation opt-in for the Vite child process. */
export function isWebAutomationEnabled(env = process.env) {
  const normalized = env.MCODE_WEB_AUTOMATION?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

/** Builds matching server and Vite child-process opt-in values. */
export function buildWebAutomationEnv(env = process.env) {
  const enabled = isWebAutomationEnabled(env);
  return {
    MCODE_WEB_AUTOMATION: enabled ? "1" : "0",
    VITE_MCODE_WEB_AUTOMATION: enabled ? "1" : "0",
  };
}

/**
 * Installs process-local hooks for focused agentUp tests.
 *
 * @param {Partial<{
 *   stopRecordedRuntimePids: typeof stopRecordedRuntimePids,
 *   computeAvailablePorts: typeof computeAvailablePorts,
 *   getElectronBinary: typeof getElectronBinary,
 *   getElectronBinding: typeof getElectronBinding,
 *   spawnLogged: typeof spawnLogged,
 *   startManagedDesktop: typeof startManagedDesktop,
 *   stopManagedDesktop: typeof stopManagedDesktop,
 *   waitForDesktopPage: typeof waitForDesktopPage,
 *   writePid: typeof writePid,
 *   stopPid: typeof stopPid,
 * }>} hooks
 * @returns {() => void}
 */
export function setAgentUpTestHooks(hooks) {
  agentUpTestHooks = hooks;
  return () => {
    agentUpTestHooks = {};
  };
}

/**
 * Starts the server and Vite web app for the current worktree.
 *
 * @param {string} [repoRoot]
 * @param {{ desktop?: boolean, wait?: boolean }} [options]
 * @returns {Promise<import("./runtime-contract.mjs").AgentRuntimePorts>}
 */
export async function agentUp(repoRoot = resolveRepoRoot(), { desktop = false, wait = false } = {}) {
  assertRuntimeRootSafe(repoRoot);
  const paths = ensureRuntimeRoot(repoRoot);
  prepareSharedRuntimeDirectories(paths);
  if (desktop) assertManagedDesktopPathsSafe(paths);
  assertRuntimeProvisioned(repoRoot, paths, desktop);
  const stopRuntimePids = agentUpTestHooks.stopRecordedRuntimePids ?? stopRecordedRuntimePids;
  await stopRuntimePids(repoRoot);

  const runtime = await prepareRuntime(repoRoot);
  const electronBin = requireElectronBinary();
  const getBinding = agentUpTestHooks.getElectronBinding ?? getElectronBinding;
  runtime.electronBinding = getBinding();
  return startProvisionedRuntime({ desktop, electronBin, paths, repoRoot, runtime, wait });
}

function requireElectronBinary() {
  const electronBin = resolveElectronBinary();
  if (!electronBin) throw new Error("Electron binary not found. Run 'bun run agent:setup' first.");
  return electronBin;
}

async function startProvisionedRuntime({ desktop, electronBin, paths, repoRoot, runtime, wait }) {
  const startedProcesses = [];
  const persistPid = agentUpTestHooks.writePid ?? writePid;
  try {
    const server = await startRuntimeServer({ electronBin, paths, repoRoot, runtime });
    startedProcesses.push({ name: "server", pid: requireChildPid("server", server) });
    startedProcesses.at(-1).pidFile = persistPid(paths, "server", server.pid);
    writePortsFile(runtime.contract, repoRoot);

    const web = await startRuntimeWeb({ paths, repoRoot, runtime });
    startedProcesses.push({ name: "web", pid: requireChildPid("web", web) });
    startedProcesses.at(-1).pidFile = persistPid(paths, "web", web.pid);

    const desktopProcess = desktop ? await startRuntimeDesktop(repoRoot, electronBin) : null;
    if (desktopProcess) {
      startedProcesses.push({ name: "desktop", pid: requireChildPid("desktop", desktopProcess) });
      startedProcesses.at(-1).pidFile = persistPid(paths, "desktop", desktopProcess.pid);
    }

    if (wait) await waitForRuntimeReadiness(runtime.contract, desktopProcess);

    await writeRuntimeSummary(runtime.contract, repoRoot);
    return runtime.contract;
  } catch (error) {
    const cleanupError = await cleanupStartedProcesses(startedProcesses, repoRoot);
    if (cleanupError) {
      throw new AggregateError([error, cleanupError], `Agent runtime startup failed: ${error.message}`, { cause: error });
    }
    throw error;
  }
}

function requireChildPid(name, child) {
  if (!Number.isSafeInteger(child?.pid) || child.pid <= 0) {
    throw new Error(`Could not start ${name}: child process has no PID`);
  }
  return child.pid;
}

function assertManagedDesktopPathsSafe(paths) {
  const userDataDir = NodePath.join(paths.devDir, MANAGED_DESKTOP_SESSION_FILE.slice(0, -".json".length));
  assertRuntimeDirectorySafe(userDataDir, "managed desktop user-data directory", true);
  assertRuntimeDirectorySafe(NodePath.join(userDataDir, "runtime"), "managed desktop runtime directory", true);
}

async function waitForRuntimeReadiness(contract, desktopProcess) {
  await waitForHttpOk(contract.healthUrl, "server health");
  await waitForHttpOk(contract.appUrl, "web app");
  if (desktopProcess) await waitForRuntimeDesktopPage(desktopProcess.endpoint, contract.appUrl);
}

/** Parses command-line startup options. */
export function parseAgentUpOptions(args) {
  return {
    desktop: args.includes("--desktop"),
    wait: args.includes("--wait"),
  };
}

/**
 * Fails fast when the runtime has not been provisioned by `agent:setup`.
 *
 * @param {string} repoRoot
 * @param {ReturnType<typeof getRuntimePaths>} paths
 * @param {boolean} desktop
 */
function assertRuntimeProvisioned(repoRoot, paths, desktop) {
  const serverCjs = NodePath.resolve(repoRoot, "apps", "desktop", "dist", "server", "server.cjs");
  const desktopMain = NodePath.resolve(repoRoot, "apps", "desktop", "dist", "main", "main.cjs");
  const missing = [];
  if (!hasRuntimeDatabaseMarker(repoRoot)) missing.push("a valid .dev/db database marker");
  if (!isFixtureRepo(repoRoot)) missing.push("an independent .dev/fixture-repo");
  if (!NodeFS.existsSync(serverCjs)) missing.push("apps/desktop/dist/server/server.cjs");
  if (desktop && !NodeFS.existsSync(desktopMain)) missing.push("apps/desktop/dist/main/main.cjs");
  if (missing.length > 0) {
    throw new Error(
      `Agent runtime is not provisioned. Run 'bun run agent:setup' first. Missing: ${missing.join(", ")}`,
    );
  }
}

async function startRuntimeDesktop(repoRoot, electronBin) {
  const startDesktop = agentUpTestHooks.startManagedDesktop ?? startManagedDesktop;
  return startDesktop(repoRoot, electronBin);
}

async function waitForRuntimeDesktopPage(endpoint, appUrl) {
  const waitForPage = agentUpTestHooks.waitForDesktopPage ?? waitForDesktopPage;
  return waitForPage(endpoint, appUrl);
}

async function prepareRuntime(repoRoot) {
  const computeRuntimePorts = agentUpTestHooks.computeAvailablePorts ?? computeAvailablePorts;
  const { serverPort, webPort } = await computeRuntimePorts(repoRoot);
  const token = NodeCrypto.randomUUID();
  const instanceToken = generateInstanceToken();
  return {
    fixtureRepo: getRuntimePaths(repoRoot).fixtureRepoDir,
    token,
    instanceToken,
    serverPort,
    webPort,
    contract: buildPortsContract({
      repoRoot,
      serverPort,
      webPort,
      instanceToken,
      worktreeIdentity: repoRoot,
      seedLogin: {
        email: "agent@seed.local",
        token,
        authHeader: `Bearer ${token}`,
        cookieName: "mcode-auth",
      },
    }),
  };
}

function resolveElectronBinary() {
  const getElectron = agentUpTestHooks.getElectronBinary ?? getElectronBinary;
  return getElectron();
}

async function startRuntimeServer({ electronBin, paths, repoRoot, runtime }) {
  const serverCjs = NodePath.resolve(repoRoot, "apps", "desktop", "dist", "server", "server.cjs");
  const spawnRuntimeProcess = agentUpTestHooks.spawnLogged ?? spawnLogged;
  return spawnRuntimeProcess(
    electronBin,
    [serverCjs],
    {
      cwd: NodePath.dirname(serverCjs),
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        BETTER_SQLITE3_BINDING: runtime.electronBinding,
        NODE_ENV: "development",
        ...buildRuntimeStateEnv(repoRoot, { MCODE_AGENT_FIXTURE_REPO: runtime.fixtureRepo }),
        MCODE_PORT: String(runtime.serverPort),
        MCODE_HOST: "127.0.0.1",
        MCODE_AUTH_TOKEN: runtime.token,
        MCODE_SINGLE_INSTANCE: "true",
        MCODE_INSTANCE_TOKEN: runtime.instanceToken,
        MCODE_WORKTREE_IDENTITY: repoRoot,
        MCODE_WEB_AUTOMATION: buildWebAutomationEnv().MCODE_WEB_AUTOMATION,
      },
      windowsHide: true,
    },
    NodePath.resolve(paths.logsDir, "server.log"),
  );
}

async function startRuntimeWeb({ paths, repoRoot, runtime }) {
  const spawnRuntimeProcess = agentUpTestHooks.spawnLogged ?? spawnLogged;
  return spawnRuntimeProcess(
    getBunBinary(),
    ["run", "dev", "--host", "127.0.0.1", "--port", String(runtime.webPort), "--strictPort"],
    {
      cwd: NodePath.resolve(rootDir, "apps", "web"),
      env: {
        ...process.env,
        NODE_ENV: "development",
        MCODE_AGENT_RUNTIME: "1",
        MCODE_WEB_PORT: String(runtime.webPort),
        VITE_MCODE_SINGLE_INSTANCE: "true",
        VITE_MCODE_WORKTREE_IDENTITY: repoRoot,
        VITE_MCODE_RUNTIME_CONTRACT: paths.portsFile,
        VITE_MCODE_WEB_AUTOMATION: buildWebAutomationEnv().VITE_MCODE_WEB_AUTOMATION,
      },
      windowsHide: true,
    },
    NodePath.resolve(paths.logsDir, "web.log"),
  );
}

async function writeRuntimeSummary(contract, repoRoot) {
  if (process.argv.includes("--quiet")) return;
  const { portsFile } = getRuntimePaths(repoRoot);
  await writeStdout(`${JSON.stringify({
    healthUrl: contract.healthUrl,
    appUrl: contract.appUrl,
    worktreeIdentity: contract.worktreeIdentity,
    contractPath: NodePath.relative(repoRoot, portsFile).replace(/\\/g, "/"),
  })}\n`);
}

/**
 * Resolve the local Electron binary used to run the server bundle.
 *
 * @returns {string | null}
 */
function getElectronBinary() {
  return resolveSharedElectronBinary(rootDir);
}

/** Resolve the workspace Electron-native better-sqlite3 binding. */
function getElectronBinding() {
  return resolveElectronBinding(rootDir);
}

/**
 * Spawn a long-running process with stdout and stderr redirected to one log file.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd: string, env: NodeJS.ProcessEnv }} options
 * @param {string} logPath
 * @returns {import("node:child_process").ChildProcess}
 */
async function spawnLogged(command, args, options, logPath) {
  assertRuntimeFileSafe(logPath, "runtime log", true);
  const logFd = NodeFS.openSync(logPath, "a");
  const child = NodeChildProcess.spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", logFd, logFd],
    detached: true,
    shell: false,
    windowsHide: true,
  });
  await acknowledgeSpawn(child);
  child.unref();
  return child;
}

function acknowledgeSpawn(child) {
  return new Promise((resolveSpawn, rejectSpawn) => {
    const failed = (error) => {
      clearImmediate(acknowledged);
      rejectSpawn(error);
    };
    const acknowledged = setImmediate(() => {
      child.off("error", failed);
      resolveSpawn();
    });
    child.once("error", failed);
  });
}

/**
 * Resolve the Bun executable used to launch Vite.
 *
 * @returns {string}
 */
function getBunBinary() {
  if (process.env.BUN) return process.env.BUN;
  if (process.platform === "win32") {
    const result = NodeChildProcess.spawnSync("where.exe", ["bun"], { encoding: "utf8" });
    const candidate = result.stdout.split(/\r?\n/).find(Boolean);
    if (candidate) return candidate;
  }
  return "bun";
}

/**
 * Persist the PID of a process started by `agent:up`.
 *
 * @param {ReturnType<typeof getRuntimePaths>} paths
 * @param {string} name
 * @param {number | undefined} pid
 */
function writePid(paths, name, pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`Could not start ${name}: child process has no PID`);
  }
  const pidFile = NodePath.resolve(paths.pidsDir, `${name}.pid`);
  assertRuntimeFileSafe(pidFile, "runtime PID file", true);
  NodeFS.writeFileSync(pidFile, `${pid}\n`, { encoding: "utf8" });
  return pidFile;
}

/**
 * Wait for the server health endpoint to return HTTP 200.
 *
 * @param {string} healthUrl
 * @param {number} [timeoutMs]
 */
/**
 * Wait for a URL to return a successful HTTP response.
 *
 * @param {string} url
 * @param {string} label
 * @param {number} [timeoutMs]
 */
export async function waitForHttpOk(url, label, timeoutMs = 30_000, options) {
  return waitForSharedHttpOk(url, label, timeoutMs, options);
}

/** Waits until Electron opens the exact managed worktree app page. */
export async function waitForDesktopPage(
  endpoint,
  appUrl,
  { fetchImpl = globalThis.fetch, intervalMs = 200, probeTimeoutMs = 1_000, timeoutMs = 30_000 } = {},
) {
  const expectedUrl = new URL(appUrl);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const remainingMs = Math.max(1, deadline - Date.now());
    const probeTimer = setTimeout(() => controller.abort(), Math.min(probeTimeoutMs, remainingMs));
    try {
      const response = await fetchImpl(`${endpoint}/json/list`, { signal: controller.signal });
      const targets = await response.json();
      if (Array.isArray(targets) && targets.some((target) => isManagedAppPage(target, expectedUrl))) {
        return;
      }
    } catch {
      // Electron may expose CDP before the BrowserWindow finishes loading.
    } finally {
      clearTimeout(probeTimer);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, intervalMs));
  }
  throw new Error(`Electron did not open the managed app URL within ${timeoutMs}ms`);
}

function isManagedAppPage(target, expectedUrl) {
  if (target?.type !== "page" || typeof target.url !== "string") return false;
  try {
    const targetUrl = new URL(target.url);
    return targetUrl.origin === expectedUrl.origin && targetUrl.pathname === expectedUrl.pathname;
  } catch {
    return false;
  }
}

/**
 * Stops only processes started by the current failed `agent:up` attempt.
 *
 * @param {string[]} pidFiles
 * @param {string} repoRoot
 */
async function cleanupStartedProcesses(processes, repoRoot) {
  const paths = getRuntimePaths(repoRoot);
  const cleanupErrors = [];
  try {
    assertRuntimeFileSafe(paths.portsFile, "runtime contract", true);
    NodeFS.rmSync(paths.portsFile, { force: true });
  } catch (error) {
    cleanupErrors.push(error);
  }
  const stopDesktop = agentUpTestHooks.stopManagedDesktop ?? stopManagedDesktop;
  const stopOwnedProcess = agentUpTestHooks.stopPid ?? stopPid;
  for (const processRecord of [...processes].reverse()) {
    try {
      await cleanupStartedProcess(processRecord, { paths, repoRoot, stopDesktop, stopOwnedProcess });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  return cleanupErrors.length === 0 ? null : new AggregateError(cleanupErrors, "Agent runtime cleanup failed");
}

async function cleanupStartedProcess(processRecord, { paths, repoRoot, stopDesktop, stopOwnedProcess }) {
  if (processRecord.name === "desktop") {
    await cleanupStartedDesktop(processRecord.pid, paths, repoRoot, stopDesktop, stopOwnedProcess);
  } else {
    await stopOwnedProcess(processRecord.pid);
  }
  if (!processRecord.pidFile) return;
  assertRuntimeFileSafe(processRecord.pidFile, "runtime PID file", true);
  NodeFS.rmSync(processRecord.pidFile, { force: true });
}

async function cleanupStartedDesktop(pid, paths, repoRoot, stopDesktop, stopOwnedProcess) {
  let result;
  try {
    result = await stopDesktop(repoRoot);
  } catch {
    return stopCapturedDesktop(pid, paths, stopOwnedProcess);
  }
  if (result?.status === "not-running") return stopCapturedDesktop(pid, paths, stopOwnedProcess);
}

async function stopCapturedDesktop(pid, paths, stopOwnedProcess) {
  await stopOwnedProcess(pid);
  const sessionFile = NodePath.join(paths.devDir, MANAGED_DESKTOP_SESSION_FILE);
  assertRuntimeFileSafe(sessionFile, "desktop session", true);
  NodeFS.rmSync(sessionFile, { force: true });
}

/**
 * Waits for stdout to accept the full startup contract before Node exits.
 *
 * @param {string} value
 * @returns {Promise<void>}
 */
async function writeStdout(value) {
  await new Promise((resolveWrite, rejectWrite) => {
    process.stdout.write(value, (error) => {
      if (error) {
        rejectWrite(error);
        return;
      }
      resolveWrite();
    });
  });
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  const repoArg = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
  const repoRoot = repoArg ? NodePath.resolve(repoArg) : resolveRepoRoot();
  await agentUp(repoRoot, parseAgentUpOptions(process.argv.slice(2)));
}
