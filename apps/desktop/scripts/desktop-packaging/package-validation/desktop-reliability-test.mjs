/**
 * Packaged Desktop reliability scenario.
 *
 * Launches the packaged Desktop executable with an isolated data directory,
 * performs one authenticated settings write, publishes a deterministic assistant
 * prefix, injects an abnormal server exit, then proves Desktop restored both.
 * The test intentionally sends no mutation after the restart.
 */

import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { killPidTree, killProcessTree } from "../../../../../scripts/kill-process-tree.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, "..", "..", "..");
const releaseDir = resolve(desktopRoot, "release");
const STARTUP_TIMEOUT_MS = 30_000;
const RECOVERY_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 100;

/** Locate a packaged Desktop executable in the standard electron-builder output paths. */
export function findPackagedDesktop() {
  const candidates = [
    resolve(releaseDir, "win-unpacked/Mcode.exe"),
    resolve(releaseDir, "linux-unpacked/mcode-desktop"),
    resolve(releaseDir, "mac/Mcode.app/Contents/MacOS/Mcode"),
    resolve(releaseDir, "mac-arm64/Mcode.app/Contents/MacOS/Mcode"),
  ];
  const desktop = candidates.find((candidate) => existsSync(candidate));
  return desktop ? { desktop } : null;
}

/** Run the abnormal-exit packaged scenario and return its evidence. */
export async function runPackagedReliabilityScenario() {
  const found = findPackagedDesktop();
  if (!found) {
    throw new Error("Packaged Desktop executable not found. Run the target package task first.");
  }

  const runRoot = resolve(tmpdir(), `mcode-reliability-${randomUUID()}`);
  const dataDir = join(runRoot, "data");
  const userDataDir = join(runRoot, "user-data");
  const capabilityPath = join(runRoot, "reliability-capability.json");
  const token = randomBytes(32).toString("hex");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(capabilityPath, JSON.stringify({ version: 1, token, runId: randomUUID() }), { mode: 0o600 });

  const child = spawn(found.desktop, process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox"] : [], {
    cwd: dirname(found.desktop),
    env: {
      ...process.env,
      NODE_ENV: "production",
      MCODE_DATA_DIR: dataDir,
      MCODE_ELECTRON_USER_DATA_DIR: userDataDir,
      MCODE_RELIABILITY_CAPABILITY_PATH: capabilityPath,
      MCODE_AGENT_RUNTIME: "1",
      MCODE_SINGLE_INSTANCE: "false",
      MCODE_MODE: "desktop",
      ELECTRON_ENABLE_LOGGING: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    ...resolveOwnedDesktopSpawnOptions(),
  });
  let output = "";
  const capture = (chunk) => {
    output = `${output}${chunk.toString()}`.slice(-12_000);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);

  let mutationCount = 0;
  let ownedServerAuthToken = null;
  let observer = null;
  try {
    const initialLock = await waitForServerLock(dataDir, STARTUP_TIMEOUT_MS);
    ownedServerAuthToken = initialLock.authToken;
    await waitForHealth(initialLock.port, STARTUP_TIMEOUT_MS);
    const rendezvous = await waitForDesktopRendezvous(runRoot, child.pid, token, STARTUP_TIMEOUT_MS);
    await rpc(initialLock, "settings.update", { appearance: { theme: "dark" } }, () => { mutationCount += 1; });
    const workspace = (await rpc(initialLock, "workspace.create", {
      name: "Reliability harness",
      path: runRoot,
    })).result;
    const thread = (await rpc(initialLock, "thread.create", {
      workspaceId: workspace.id,
      title: "Restart recovery",
      mode: "direct",
      branch: "main",
    })).result;
    observer = await observeAgentText(initialLock, thread.id);
    const streamed = await postDesktopFault(rendezvous.port, token, {
      control: "assistant-stream",
      threadId: thread.id,
    });
    const stream = streamed?.stream;
    if (!stream || stream.threadId !== thread.id || typeof stream.executionId !== "string" || typeof stream.text !== "string") {
      throw new Error("Reliability assistant stream did not return its durable identity");
    }
    const published = await observer.published;
    if (published.delta !== stream.text) {
      throw new Error("Published assistant prefix differed from the durable stream");
    }
    observer.close();
    observer = null;

    await postDesktopFault(rendezvous.port, token, { control: "server-exit" });
    const recoveredLock = await waitForChangedServerLock(dataDir, initialLock, RECOVERY_TIMEOUT_MS);
    await waitForHealth(recoveredLock.port, RECOVERY_TIMEOUT_MS);
    const persisted = await rpc(recoveredLock, "settings.get", {});

    if (mutationCount !== 1) throw new Error(`Expected one settings mutation, observed ${mutationCount}`);
    if (persisted?.result?.appearance?.theme !== "dark") {
      throw new Error("Persisted settings sentinel was not retained after server recovery");
    }
    const conversation = await rpc(recoveredLock, "message.list", { threadId: thread.id, limit: 10 });
    const assistants = conversation?.result?.messages?.filter((message) => message.role === "assistant") ?? [];
    if (assistants.length !== 1
      || assistants[0].content !== stream.text
      || assistants[0].outcome !== "interrupted"
      || assistants[0].outcomeExecutionId !== stream.executionId) {
      throw new Error("Recovered assistant prefix was not restored exactly once as Interrupted");
    }

    return {
      initialServer: { pid: initialLock.pid, startedAt: initialLock.startedAt },
      recoveredServer: { pid: recoveredLock.pid, startedAt: recoveredLock.startedAt },
      persistedTheme: persisted.result.appearance.theme,
      mutationCount,
      assistant: {
        threadId: thread.id,
        executionId: stream.executionId,
        publishedPrefix: published.delta,
        restoredPrefix: assistants[0].content,
        outcome: assistants[0].outcome,
      },
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${detail}\nPackaged Desktop output:\n${output.slice(-4_000)}`);
  } finally {
    observer?.close();
    await cleanupOwnedRun(child, dataDir, runRoot, { expectedServerAuthToken: ownedServerAuthToken });
  }
}

async function waitForServerLock(dataDir, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const lockPath = join(dataDir, "server.lock");
  while (Date.now() < deadline) {
    const lock = readJson(lockPath);
    if (isServerLock(lock)) return lock;
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`Packaged Desktop did not publish a server lock within ${timeoutMs}ms`);
}

async function waitForDesktopRendezvous(runRoot, desktopPid, token, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const rendezvousPath = join(runRoot, "desktop-reliability-rendezvous.json");
  while (Date.now() < deadline) {
    const rendezvous = readJson(rendezvousPath);
    if (rendezvous && rendezvous.version === 1 && Number.isSafeInteger(rendezvous.port) && rendezvous.port > 0 && rendezvous.pid === desktopPid) {
      if (JSON.stringify(rendezvous).includes(token)) throw new Error("Desktop rendezvous leaked the capability token");
      return rendezvous;
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`Desktop did not publish a valid rendezvous within ${timeoutMs}ms`);
}

async function waitForChangedServerLock(dataDir, previous, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const lockPath = join(dataDir, "server.lock");
  while (Date.now() < deadline) {
    const lock = readJson(lockPath);
    if (isServerLock(lock) && (lock.pid !== previous.pid || lock.startedAt !== previous.startedAt)) return lock;
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`Server identity did not change within the bounded recovery window (${timeoutMs}ms)`);
}

async function waitForHealth(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // Startup and recovery legitimately have a short unavailable interval.
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`Server health did not recover within ${timeoutMs}ms`);
}

async function postDesktopFault(port, token, command) {
  const response = await fetch(`http://127.0.0.1:${port}/__mcode/reliability`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Fault activation failed with HTTP ${response.status}`);
  return response.json();
}

async function observeAgentText(lock, threadId) {
  return new Promise((resolvePromise, reject) => {
    const subscriptionId = randomUUID();
    const ws = new WebSocket(`ws://127.0.0.1:${lock.port}/?token=${lock.authToken}`);
    let resolved = false;
    let receiveText;
    const published = new Promise((resolveText, rejectText) => {
      receiveText = resolveText;
      const timeout = setTimeout(() => rejectText(new Error("Timed out waiting for published assistant text")), 10_000);
      ws.addEventListener("close", () => clearTimeout(timeout), { once: true });
    });
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("WebSocket subscription timed out"));
    }, 10_000);
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({
        id: subscriptionId,
        method: "push.subscribeThread",
        params: { threadId },
      }));
    });
    ws.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.id === subscriptionId) {
        clearTimeout(timeout);
        resolved = true;
        resolvePromise({
          published,
          close: () => {
            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
          },
        });
        return;
      }
      if (message.type === "push" && message.channel === "agent.event"
        && message.data?.threadId === threadId && message.data?.type === "textDelta") {
        receiveText({ delta: message.data.delta, sequence: message.data.sequence });
      }
    });
    ws.addEventListener("error", () => {
      clearTimeout(timeout);
      if (!resolved) reject(new Error("WebSocket subscription failed"));
    });
  });
}

function rpc(lock, method, params, onMutation = () => undefined) {
  return new Promise((resolvePromise, reject) => {
    const id = randomUUID();
    const ws = new WebSocket(`ws://127.0.0.1:${lock.port}/?token=${lock.authToken}`);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`WebSocket RPC timed out: ${method}`));
    }, 10_000);
    ws.addEventListener("open", () => {
      if (method === "settings.update") onMutation();
      ws.send(JSON.stringify({ id, method, params }));
    });
    ws.addEventListener("message", (event) => {
      let response;
      try {
        response = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (response.id !== id) return;
      clearTimeout(timeout);
      ws.close();
      if (response.error) reject(new Error(`${method} failed: ${response.error.message ?? "unknown error"}`));
      else resolvePromise(response);
    });
    ws.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error(`WebSocket transport failed for ${method}`));
    });
  });
}

/** Clean up the isolated server, Desktop tree, and run directory in order. */
export async function cleanupOwnedRun(child, dataDir, runRoot, overrides = {}) {
  const operations = {
    readLock: readJson,
    readAuthSecret: (target) => {
      try {
        return readFileSync(target, "utf8").trim();
      } catch {
        return null;
      }
    },
    fetch: globalThis.fetch,
    killPidTree,
    killProcessTree,
    waitForProcessExit,
    removeRunRoot: (target) => rmSync(target, { recursive: true, force: true }),
    pathExists: existsSync,
    platform: process.platform,
    ...overrides,
  };
  const errors = [];
  try {
    await cleanupOwnedServer(dataDir, operations);
  } catch (error) {
    errors.push(error);
  }
  try {
    await cleanupOwnedDesktop(child, operations);
  } catch (error) {
    errors.push(error);
  }
  try {
    operations.removeRunRoot(runRoot);
    if (operations.pathExists(runRoot)) {
      throw new Error(`Owned reliability run directory survived cleanup: ${runRoot}`);
    }
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Reliability harness cleanup failed");
  }
}

async function cleanupOwnedServer(dataDir, operations) {
  const lockPath = join(dataDir, "server.lock");
  let lock = operations.readLock(lockPath);
  if (!isServerLock(lock)) return;
  const expectedAuthToken = operations.expectedServerAuthToken ?? operations.readAuthSecret(join(dataDir, "auth-secret"));
  if (!expectedAuthToken || !isOwnedServerLock(lock, expectedAuthToken)) {
    throw new Error("Refusing to terminate a server without an isolated-run identity");
  }

  for (let attempt = 0; attempt < 4 && lock; attempt += 1) {
    try {
      await operations.fetch(`http://127.0.0.1:${lock.port}/shutdown`, {
        method: "POST",
        headers: { Authorization: `Bearer ${lock.authToken}` },
        signal: AbortSignal.timeout(2_000),
      });
    } catch {
      // The server may already have exited or be intentionally hung.
    }

    const beforeTerminate = operations.readLock(lockPath);
    if (!beforeTerminate) return;
    if (!isOwnedServerLock(beforeTerminate, expectedAuthToken)) {
      throw new Error("Server lock identity changed outside the isolated run");
    }
    if (!sameServerIdentity(lock, beforeTerminate)) {
      lock = beforeTerminate;
      continue;
    }

    const useProcessGroup = operations.platform !== "win32";
    await operations.killPidTree(lock.pid, "SIGTERM", { graceMs: 500, useProcessGroup });
    await operations.waitForProcessExit(lock.pid, 5_000, { useProcessGroup });

    const afterTerminate = operations.readLock(lockPath);
    if (!afterTerminate) return;
    if (!isOwnedServerLock(afterTerminate, expectedAuthToken)) {
      throw new Error("Server lock identity changed outside the isolated run");
    }
    if (!sameServerIdentity(lock, afterTerminate)) {
      lock = afterTerminate;
      continue;
    }
    return;
  }
  throw new Error("Server lock kept changing during cleanup");
}

async function cleanupOwnedDesktop(child, operations) {
  if (!child?.pid) return;
  const useProcessGroup = operations.platform !== "win32";
  await operations.killProcessTree(child, { graceMs: 500, useProcessGroup });
  await operations.waitForProcessExit(child.pid, 5_000, { useProcessGroup });
}

/** Return process options that make the owned Desktop tree independently killable. */
export function resolveOwnedDesktopSpawnOptions(platform = process.platform) {
  return { detached: platform !== "win32" };
}

/** Validate that a lock belongs to the server authenticated during this run. */
export function isOwnedServerLock(lock, expectedAuthToken) {
  return isServerLock(lock) && typeof expectedAuthToken === "string" && lock.authToken === expectedAuthToken;
}

function sameServerIdentity(left, right) {
  return left.pid === right.pid && left.startedAt === right.startedAt && left.authToken === right.authToken;
}

/** Wait until a process or POSIX process group has no surviving members. */
export async function waitForProcessExit(pid, timeoutMs, options = {}) {
  const {
    useProcessGroup = false,
    platform = process.platform,
    processKill = process.kill,
    sleep = delay,
  } = options;
  const target = useProcessGroup && platform !== "win32" ? -pid : pid;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      processKill(target, 0);
    } catch (error) {
      const code = error?.code;
      const message = error instanceof Error ? error.message : String(error ?? "");
      if (code === "ESRCH" || message.includes("ESRCH")) return;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Owned process tree ${pid} survived cleanup`);
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function isServerLock(value) {
  return Boolean(value && typeof value === "object" && Number.isSafeInteger(value.port) && value.port > 0 && Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.authToken === "string" && value.authToken.length > 0 && typeof value.startedAt === "string");
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

if (import.meta.main) {
  try {
    const evidence = await runPackagedReliabilityScenario();
    console.log(`[desktop-reliability] PASS ${JSON.stringify(evidence)}`);
  } catch (error) {
    console.error(`[desktop-reliability] FAIL ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
