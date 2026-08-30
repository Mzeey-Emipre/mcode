import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { terminateProcessTree } from "./process-tree.mjs";

const SESSION_FILE_NAME = "electron-live-testing.json";
const CDP_PROBE_TIMEOUT_MS = 1_000;

function isCdpVersionPayload(value) {
  if (!value || typeof value !== "object") return false;
  const payload = value;
  if (!hasCdpVersionFields(payload)) return false;
  return hasCdpWebSocketUrl(payload.webSocketDebuggerUrl);
}

function hasCdpVersionFields(payload) {
  return isNonEmptyString(payload.Browser)
    && isNonEmptyString(payload["Protocol-Version"])
    && typeof payload.webSocketDebuggerUrl === "string";
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasCdpWebSocketUrl(value) {
  try {
    const websocketUrl = new URL(value);
    return (
      (websocketUrl.protocol === "ws:" || websocketUrl.protocol === "wss:") &&
      websocketUrl.pathname.startsWith("/devtools/browser/") &&
      websocketUrl.pathname.length > "/devtools/browser/".length
    );
  } catch {
    return false;
  }
}

/** Probes a loopback CDP JSON/version endpoint with a bounded HTTP attempt. */
export async function probeCdpVersion(
  endpoint,
  { fetchImpl = globalThis.fetch, timeoutMs = CDP_PROBE_TIMEOUT_MS } = {},
) {
  const timeoutSignal = typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(timeoutMs)
    : (() => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), timeoutMs).unref?.();
        return controller.signal;
      })();
  let timeoutId;
  const timeout = new Promise((resolveTimeout) => {
    timeoutId = setTimeout(() => resolveTimeout(false), timeoutMs);
  });
  const request = Promise.resolve()
    .then(() => fetchImpl(`${endpoint}/json/version`, { signal: timeoutSignal }))
    .then(async (response) => {
      if (!response?.ok) return false;
      let payload;
      try {
        payload = await response.json();
      } catch {
        return false;
      }
      return isCdpVersionPayload(payload);
    })
    .catch(() => false);
  try {
    return await Promise.race([request, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Starts one detached Electron process with an agent-owned dynamic CDP endpoint. */
export async function startElectron(repoRoot = process.cwd(), options = {}) {
  const root = resolve(repoRoot);
  const runtime = await loadElectronRuntime(root, options);
  const settings = resolveElectronSettings(options, runtime.ports, runtime.packagedExecutablePath);
  const sessionFile = join(runtime.paths.devDir, settings.sessionFileName);
  const existing = await readExistingSession(sessionFile, root);
  if (existing) return existing;
  const debugPort = await runtime.runtimeContract.findAvailablePort(
    runtime.runtimeContract.computeDeterministicPort(root, 43_000),
  );
  const launch = resolveElectronLaunch(root, runtime.paths, settings, debugPort);
  const record = createStartingRecord(root, settings, launch, debugPort);
  writeStartingSession(sessionFile, record);
  return launchElectron({
    launch,
    record,
    runtime,
    sessionFile,
    settings,
  });
}

async function loadElectronRuntime(root, options) {
  const runtimeContract = await import(
    pathToFileURL(join(root, "scripts", "agent", "runtime-contract.mjs")).href
  );
  const paths = runtimeContract.getRuntimePaths(root);
  const packagedExecutablePath = options.packagedExecutablePath
    ? resolve(options.packagedExecutablePath)
    : null;
  const ports = runtimeContract.readPortsFile(root);
  if (!packagedExecutablePath && !ports) {
    throw new Error("Start the worktree runtime before launching Electron");
  }
  if (ports && resolve(ports.worktreeIdentity).toLowerCase() !== root.toLowerCase()) {
    throw new Error("ports.json belongs to a different worktree");
  }
  return { packagedExecutablePath, paths, ports, runtimeContract };
}

function resolveElectronSettings(options, ports, packagedExecutablePath) {
  const sessionFileName = resolveSessionFileName(options);
  const performanceMode = resolvePerformanceMode(options);
  const accelerationMode = resolveAccelerationMode(options, performanceMode);
  const rendererUrl = resolveRendererUrl(options, packagedExecutablePath, ports);
  return { accelerationMode, packagedExecutablePath, performanceMode, rendererUrl, sessionFileName };
}

function resolveSessionFileName(options) {
  const sessionFileName = options.sessionFileName ?? SESSION_FILE_NAME;
  if (!/^electron-[a-z0-9-]+\.json$/.test(sessionFileName)) {
    throw new Error("sessionFileName must be a safe Electron session file name");
  }
  return sessionFileName;
}

function resolvePerformanceMode(options) {
  const performanceMode = options.performanceMode ?? null;
  if (performanceMode !== null && performanceMode !== "profiling" && performanceMode !== "production") {
    throw new Error("performanceMode must be profiling or production");
  }
  return performanceMode;
}

function resolveAccelerationMode(options, performanceMode) {
  const accelerationMode = options.accelerationMode ?? null;
  if (
    accelerationMode !== null &&
    (performanceMode !== "production" ||
      (accelerationMode !== "disabled" && accelerationMode !== "default"))
  ) {
    throw new Error(
      "accelerationMode must be disabled or default for a production performance run",
    );
  }
  return accelerationMode;
}

function resolveRendererUrl(options, packagedExecutablePath, ports) {
  const rendererUrl = options.rendererUrl === undefined
    ? packagedExecutablePath
      ? null
      : ports.appUrl
    : options.rendererUrl;
  if (rendererUrl !== null && (typeof rendererUrl !== "string" || !rendererUrl.startsWith("http://127.0.0.1:"))) {
    throw new Error("rendererUrl must be a loopback HTTP URL or null");
  }
  return rendererUrl;
}

async function readExistingSession(sessionFile, root) {
  if (existsSync(sessionFile)) {
    const existing = JSON.parse(readFileSync(sessionFile, "utf8"));
    if (await isReusable(existing, root)) return existing;
    throw new Error(
      `A stale Electron session record exists at ${sessionFile}. Inspect its PID before removal.`,
    );
  }
  return null;
}

function resolveElectronLaunch(root, paths, settings, debugPort) {
  const endpoint = `http://127.0.0.1:${debugPort}`;
  const desktopRoot = join(root, "apps", "desktop");
  const processConfig = settings.packagedExecutablePath
    ? resolvePackagedElectron(desktopRoot, settings.packagedExecutablePath)
    : resolveDevelopmentElectron(desktopRoot);
  const sessionStem = settings.sessionFileName.slice(0, -".json".length);
  const userDataDir = join(paths.devDir, sessionStem);
  const electronRuntimeDir = join(userDataDir, "runtime");
  return { ...processConfig, electronRuntimeDir, endpoint, userDataDir };
}

function resolvePackagedElectron(desktopRoot, packagedExecutablePath) {
  const releaseRoot = resolve(desktopRoot, "release");
  const releaseRelativePath = relative(releaseRoot, packagedExecutablePath);
  if (
    !packagedExecutablePath.toLowerCase().endsWith(".exe") ||
    isAbsolute(releaseRelativePath) ||
    releaseRelativePath.startsWith("..") ||
    !existsSync(packagedExecutablePath)
  ) {
    throw new Error("packagedExecutablePath must name an existing executable under apps/desktop/release");
  }
  return {
    executablePath: packagedExecutablePath,
    launchDirectory: dirname(packagedExecutablePath),
    launchTarget: [],
  };
}

function resolveDevelopmentElectron(desktopRoot) {
  const desktopEntry = join(desktopRoot, "dist", "main", "main.cjs");
  if (!existsSync(desktopEntry)) {
    throw new Error("Build the Electron main process before launching the session");
  }
  const desktopRequire = createRequire(join(desktopRoot, "package.json"));
  return {
    executablePath: desktopRequire("electron"),
    launchDirectory: desktopRoot,
    launchTarget: ["."],
  };
}

function createStartingRecord(root, settings, launch, debugPort) {
  return {
    debugPort,
    endpoint: launch.endpoint,
    executablePath: launch.executablePath,
    appUrlPrefix: settings.rendererUrl ?? "file://",
    repoRoot: root,
    status: "starting",
    userDataDir: launch.userDataDir,
  };
}

function writeStartingSession(sessionFile, record) {
  writeFileSync(sessionFile, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

function buildElectronEnvironment(root, runtime, launch, settings) {
  const env = {
    ...process.env,
    ...runtime.runtimeContract.buildRuntimeStateEnv(root, {
      MCODE_AGENT_FIXTURE_REPO: runtime.paths.fixtureRepoDir,
      MCODE_DATA_DIR: launch.electronRuntimeDir,
      MCODE_DB_PATH: join(launch.electronRuntimeDir, "db", "app.sqlite"),
      MCODE_ELECTRON_USER_DATA_DIR: launch.userDataDir,
    }),
    ...(settings.rendererUrl ? { ELECTRON_RENDERER_URL: settings.rendererUrl } : {}),
    ...(settings.performanceMode ? { MCODE_FRONTEND_PERFORMANCE_MODE: settings.performanceMode } : {}),
    ...(settings.accelerationMode
      ? { MCODE_FRONTEND_PERFORMANCE_ACCELERATION_MODE: settings.accelerationMode }
      : {}),
    NODE_ENV: settings.rendererUrl ? "development" : "production",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function spawnDetachedElectron(launch, logsDir, env) {
  mkdirSync(logsDir, { recursive: true });
  mkdirSync(launch.userDataDir, { recursive: true });
  const stdout = openSync(join(logsDir, "electron-live-testing.stdout.log"), "a");
  const stderr = openSync(join(logsDir, "electron-live-testing.stderr.log"), "a");
  try {
    return spawn(launch.executablePath, [`--remote-debugging-port=${launch.debugPort}`, ...launch.launchTarget], {
      cwd: launch.launchDirectory,
      detached: true,
      env,
      stdio: ["ignore", stdout, stderr],
    });
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }
}

async function launchElectron({ launch, record, runtime, sessionFile, settings }) {
  let child;
  try {
    child = spawnDetachedElectron(
      { ...launch, debugPort: record.debugPort },
      runtime.paths.logsDir,
      buildElectronEnvironment(record.repoRoot, runtime, launch, settings),
    );
    const spawnFailure = new Promise((_, rejectSpawn) => {
      child.once("error", rejectSpawn);
    });
    child.unref();

    const running = {
      ...record,
      pid: child.pid,
      startedAt: new Date().toISOString(),
      status: "running",
    };
    writeFileSync(sessionFile, `${JSON.stringify(running, null, 2)}\n`, "utf8");
    await Promise.race([waitForDebugger(launch.endpoint, child), spawnFailure]);
    return running;
  } catch (error) {
    if (child?.pid) terminateProcessTree(child.pid);
    rmSync(sessionFile, { force: true });
    throw error;
  }
}

async function isReusable(record, root) {
  if (
    !record ||
    record.status !== "running" ||
    !Number.isSafeInteger(record.pid) ||
    record.pid <= 0 ||
    !Number.isInteger(record.debugPort) ||
    typeof record.repoRoot !== "string" ||
    resolve(record.repoRoot).toLowerCase() !== root.toLowerCase()
  ) {
    return false;
  }
  try {
    process.kill(record.pid, 0);
    return await probeCdpVersion(`http://127.0.0.1:${record.debugPort}`);
  } catch {
    return false;
  }
}

async function waitForDebugger(endpoint, child) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Electron exited before CDP became ready with code ${child.exitCode}`);
    }
    if (await probeCdpVersion(endpoint)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error("Electron CDP endpoint did not become ready within 60 seconds");
}

if (import.meta.main) {
  console.log(JSON.stringify(await startElectron(), null, 2));
}
