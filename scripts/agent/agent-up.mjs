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
  computeAvailablePorts,
  ensureRuntimeRoot,
  generateInstanceToken,
  getRuntimePaths,
  resolveRepoRoot,
  writePortsFile,
} from "./runtime-contract.mjs";
import { seedFixtureRepo } from "./fixture-repo.mjs";
import { stopRecordedPidFile } from "./runtime-processes.mjs";
import { stopRecordedRuntimePids } from "./agent-down.mjs";
import { ensureDependencies } from "./ensure-dependencies.mjs";
import { seedDatabaseForStartup } from "../db-seed.mjs";
import {
  prepareRuntimeDirectories as prepareSharedRuntimeDirectories,
  resolveElectronBinary as resolveSharedElectronBinary,
  resolveElectronBinding,
  waitForHttpOk as waitForSharedHttpOk,
} from "../runtime/launch-mechanics.mjs";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const rootDir = NodePath.resolve(__dirname, "..", "..");
const desktopRoot = NodePath.resolve(rootDir, "apps", "desktop");
const serverCjs = NodePath.resolve(desktopRoot, "dist", "server", "server.cjs");
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
 *   seedDatabaseForStartup: typeof seedDatabaseForStartup,
 *   seedFixtureRepo: typeof seedFixtureRepo,
 *   computeAvailablePorts: typeof computeAvailablePorts,
 *   getElectronBinary: typeof getElectronBinary,
 *   rebuildServerDevBundle: () => Promise<void>,
 *   spawnLogged: typeof spawnLogged,
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
 * @returns {Promise<import("./runtime-contract.mjs").AgentRuntimePorts>}
 */
export async function agentUp(repoRoot = resolveRepoRoot()) {
  const paths = ensureRuntimeRoot(repoRoot);
  prepareSharedRuntimeDirectories(paths);
  const stopRuntimePids = agentUpTestHooks.stopRecordedRuntimePids ?? stopRecordedRuntimePids;
  await stopRuntimePids(repoRoot);
  const seedRuntimeDatabase = agentUpTestHooks.seedDatabaseForStartup ?? seedDatabaseForStartup;
  // agent:reset owns fresh snapshots; an ordinary restart must retain threads.
  seedRuntimeDatabase({ repoRoot, preserveExistingTarget: true });

  const runtime = await prepareRuntime(repoRoot);
  const electronBin = resolveElectronBinary();
  if (!electronBin) throw new Error("Electron binary not found. Run 'bun install' in the project root.");
  runtime.electronBinding = getElectronBinding();
  await rebuildRuntimeServerBundle();

  const startedPidFiles = [];
  try {
    const server = startRuntimeServer({ electronBin, paths, repoRoot, runtime });
    startedPidFiles.push(writePid(paths, "server", server.pid));

    await waitForHealth(runtime.contract.healthUrl);
    writePortsFile(runtime.contract, repoRoot);

    const web = startRuntimeWeb({ paths, repoRoot, runtime });
    startedPidFiles.push(writePid(paths, "web", web.pid));
    await waitForHttpOk(runtime.contract.appUrl, "web app");

    await writeRuntimeContract(runtime.contract);
    return runtime.contract;
  } catch (error) {
    await cleanupStartedProcesses(startedPidFiles, repoRoot);
    throw error;
  }
}

async function prepareRuntime(repoRoot) {
  const seedRuntimeFixtureRepo = agentUpTestHooks.seedFixtureRepo ?? seedFixtureRepo;
  const computeRuntimePorts = agentUpTestHooks.computeAvailablePorts ?? computeAvailablePorts;
  const fixtureRepo = seedRuntimeFixtureRepo(repoRoot);
  const { serverPort, webPort } = await computeRuntimePorts(repoRoot);
  const token = NodeCrypto.randomUUID();
  const instanceToken = generateInstanceToken();
  return {
    fixtureRepo,
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

async function rebuildRuntimeServerBundle() {
  const rebuild = agentUpTestHooks.rebuildServerDevBundle
    ?? (await import("../build-server-dev-bundle.mjs")).rebuildServerDevBundle;
  await rebuild();
}

function startRuntimeServer({ electronBin, paths, repoRoot, runtime }) {
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

function startRuntimeWeb({ paths, repoRoot, runtime }) {
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

async function writeRuntimeContract(contract) {
  if (!process.argv.includes("--quiet")) await writeStdout(`${JSON.stringify(contract)}\n`);
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
function spawnLogged(command, args, options, logPath) {
  const logFd = NodeFS.openSync(logPath, "a");
  const child = NodeChildProcess.spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", logFd, logFd],
    detached: true,
    shell: false,
    windowsHide: true,
  });
  child.unref();
  return child;
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
  NodeFS.writeFileSync(pidFile, `${pid}\n`, { encoding: "utf8" });
  return pidFile;
}

/**
 * Wait for the server health endpoint to return HTTP 200.
 *
 * @param {string} healthUrl
 * @param {number} [timeoutMs]
 */
async function waitForHealth(healthUrl, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(healthUrl);
      if (res.ok) return;
    } catch {
      // Retry until the startup deadline.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
  }
  throw new Error(`Server did not become healthy: ${healthUrl}`);
}

/**
 * Wait for a URL to return a successful HTTP response.
 *
 * @param {string} url
 * @param {string} label
 * @param {number} [timeoutMs]
 */
async function waitForHttpOk(url, label, timeoutMs = 30_000) {
  return waitForSharedHttpOk(url, label, timeoutMs);
}

/**
 * Stops only processes started by the current failed `agent:up` attempt.
 *
 * @param {string[]} pidFiles
 * @param {string} repoRoot
 */
async function cleanupStartedProcesses(pidFiles, repoRoot) {
  const paths = getRuntimePaths(repoRoot);
  NodeFS.rmSync(paths.portsFile, { force: true });
  for (const pidFile of [...pidFiles].reverse()) {
    try {
      await stopRecordedPidFile(pidFile, { repoRoot });
    } catch {
      // Startup is already failing; preserve the original error.
    }
  }
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
  ensureDependencies({ repoRoot });
  await agentUp(repoRoot);
}
