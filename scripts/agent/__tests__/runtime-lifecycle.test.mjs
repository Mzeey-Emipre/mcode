/**
 * Tests for agent runtime start/stop lifecycle helpers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";

import { agentDown } from "../agent-down.mjs";
import { agentUp, setAgentUpTestHooks } from "../agent-up.mjs";
import { agentReset } from "../agent-reset.mjs";
import {
  buildPortsContract,
  getRuntimePaths,
  writePortsFile,
} from "../runtime-contract.mjs";
import { resolveDevSingleInstanceFlag } from "../single-instance-flag.mjs";
import { stopRecordedPidFile } from "../runtime-processes.mjs";

test("agentDown posts shutdown with seedLogin.authHeader and cleans only .dev/pids", async () => {
  const repo = makeRepo();
  const originalFetch = globalThis.fetch;
  const fetchCalls = [];
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url, init });
    return new Response("", { status: 200 });
  };

  try {
    const paths = getRuntimePaths(repo);
    const contract = buildPortsContract({
      repoRoot: repo,
      serverPort: 41_123,
      webPort: 41_124,
      instanceToken: "instance-token-abc1234567890abc1234567890",
      worktreeIdentity: repo,
      seedLogin: {
        email: "agent@seed.local",
        token: "seed-token",
        authHeader: "Bearer seed-token",
        cookieName: "mcode-auth",
      },
    });
    writePortsFile(contract, repo);
    mkdirSync(paths.pidsDir, { recursive: true });
    writeFileSync(join(paths.pidsDir, "server.pid"), "999998\n");
    writeFileSync(join(paths.pidsDir, "web.pid"), "999999\n");
    const outsidePid = join(paths.devDir, "web.pid");
    writeFileSync(outsidePid, "999997\n");

    await agentDown(repo, { stop: async () => {} });

    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, "http://127.0.0.1:41123/shutdown");
    assert.equal(fetchCalls[0].init.method, "POST");
    assert.equal(fetchCalls[0].init.headers.Authorization, "Bearer seed-token");
    assert.equal(existsSync(join(paths.pidsDir, "server.pid")), false);
    assert.equal(existsSync(join(paths.pidsDir, "web.pid")), false);
    assert.equal(readFileSync(outsidePid, "utf8"), "999997\n");
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(repo, { recursive: true, force: true });
  }
});

test("agentDown falls back to PID cleanup when the shutdown request never settles", { timeout: 1_000 }, async () => {
  const repo = makeRepo();
  const originalFetch = globalThis.fetch;
  let stopCalled = false;
  globalThis.fetch = async () => new Promise(() => {});

  try {
    const paths = getRuntimePaths(repo);
    writePortsFile(buildPortsContract({
      repoRoot: repo,
      serverPort: 41_125,
      webPort: 41_126,
      instanceToken: "instance-token-abc1234567890abc1234567890",
      worktreeIdentity: repo,
      seedLogin: {
        email: "agent@seed.local",
        token: "seed-token",
        authHeader: "Bearer seed-token",
        cookieName: "mcode-auth",
      },
    }), repo);
    mkdirSync(paths.pidsDir, { recursive: true });
    const pidFile = join(paths.pidsDir, "server.pid");
    writeFileSync(pidFile, "999998\n");

    const stopping = agentDown(repo, {
      shutdownTimeoutMs: 25,
      serverGraceMs: 25,
      isProcessAlive: () => true,
      stop: async () => {
        stopCalled = true;
      },
    });

    await waitUntil(() => stopCalled, {
      timeoutMs: 250,
      intervalMs: 5,
      message: "PID cleanup did not start after the bounded shutdown timeout",
    });
    await stopping;

    assert.equal(existsSync(pidFile), false);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(repo, { recursive: true, force: true });
  }
});

test("agentDown does not force-stop a server that exits gracefully", async () => {
  const repo = makeRepo();
  const originalFetch = globalThis.fetch;
  let forceStops = 0;
  globalThis.fetch = async () => new Response("", { status: 200 });

  try {
    const paths = getRuntimePaths(repo);
    writeGracefulRuntimeContract(repo, 41_127);
    mkdirSync(paths.pidsDir, { recursive: true });
    const pidFile = join(paths.pidsDir, "server.pid");
    writeFileSync(pidFile, "700001\n");

    await agentDown(repo, {
      serverGraceMs: 10,
      isProcessAlive: () => false,
      now: () => 0,
      sleep: async () => {},
      stop: async () => { forceStops += 1; },
    });

    assert.equal(forceStops, 0);
    assert.equal(existsSync(pidFile), false);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(repo, { recursive: true, force: true });
  }
});

test("agentDown force-stops a server that ignores graceful shutdown", async () => {
  const repo = makeRepo();
  const originalFetch = globalThis.fetch;
  let forceStops = 0;
  let clock = 0;
  globalThis.fetch = async () => new Response("", { status: 200 });

  try {
    const paths = getRuntimePaths(repo);
    writeGracefulRuntimeContract(repo, 41_129);
    mkdirSync(paths.pidsDir, { recursive: true });
    const pidFile = join(paths.pidsDir, "server.pid");
    writeFileSync(pidFile, "700002\n");

    await agentDown(repo, {
      serverGraceMs: 10,
      isProcessAlive: () => true,
      now: () => clock,
      sleep: async (durationMs) => { clock += durationMs; },
      stop: async (pid, signal) => {
        forceStops += 1;
        assert.equal(pid, 700002);
        assert.equal(signal, "SIGTERM");
      },
    });

    assert.equal(forceStops, 1);
    assert.equal(existsSync(pidFile), false);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(repo, { recursive: true, force: true });
  }
});

test("agentDown stops the web process before the server process", async () => {
  const repo = makeRepo();
  const originalFetch = globalThis.fetch;
  const stops = [];
  let clock = 0;
  globalThis.fetch = async () => new Response("", { status: 200 });

  try {
    const paths = getRuntimePaths(repo);
    writeGracefulRuntimeContract(repo, 41_131);
    mkdirSync(paths.pidsDir, { recursive: true });
    writeFileSync(join(paths.pidsDir, "server.pid"), "700003\n");
    writeFileSync(join(paths.pidsDir, "web.pid"), "700004\n");

    await agentDown(repo, {
      serverGraceMs: 10,
      isProcessAlive: () => true,
      now: () => clock,
      sleep: async (durationMs) => { clock += durationMs; },
      stop: async (pid) => { stops.push(pid); },
    });

    assert.deepEqual(stops, [700004, 700003]);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(repo, { recursive: true, force: true });
  }
});

test("agentDown retains the server PID file until forced termination settles", async () => {
  const repo = makeRepo();
  const originalFetch = globalThis.fetch;
  let releaseStop;
  let stopStarted = false;
  let clock = 0;
  const stopCompletion = new Promise((resolvePromise) => { releaseStop = resolvePromise; });
  globalThis.fetch = async () => new Response("", { status: 200 });

  try {
    const paths = getRuntimePaths(repo);
    writeGracefulRuntimeContract(repo, 41_133);
    mkdirSync(paths.pidsDir, { recursive: true });
    const pidFile = join(paths.pidsDir, "server.pid");
    writeFileSync(pidFile, "700005\n");

    const stopping = agentDown(repo, {
      serverGraceMs: 10,
      isProcessAlive: () => true,
      now: () => clock,
      sleep: async (durationMs) => { clock += durationMs; },
      stop: async () => {
        stopStarted = true;
        await stopCompletion;
      },
    });

    await waitUntil(() => stopStarted, {
      timeoutMs: 250,
      intervalMs: 5,
      message: "forced server termination did not start",
    });
    assert.equal(existsSync(pidFile), true);

    releaseStop();
    await stopping;
    assert.equal(existsSync(pidFile), false);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(repo, { recursive: true, force: true });
  }
});

test("agentDown still cleans PID files when ports.json is malformed", async () => {
  const repo = makeRepo();
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  globalThis.fetch = async () => {
    throw new Error("fetch must not run for malformed ports.json");
  };
  console.warn = () => {};

  try {
    const paths = getRuntimePaths(repo);
    mkdirSync(paths.devDir, { recursive: true });
    mkdirSync(paths.pidsDir, { recursive: true });
    writeFileSync(paths.portsFile, "{not json");
    writeFileSync(join(paths.pidsDir, "server.pid"), "999998\n");

    await agentDown(repo, { stop: async () => {} });

    assert.equal(existsSync(join(paths.pidsDir, "server.pid")), false);
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    rmSync(repo, { recursive: true, force: true });
  }
});

test("agentUp removes stale PID files before launching server and web processes", async () => {
  const repo = makeRepo();
  let spawnAttempted = false;
  const restoreHooks = setAgentUpTestHooks({
    stopRecordedRuntimePids: async (receivedRepo) => {
      rmSync(join(getRuntimePaths(receivedRepo).pidsDir, "server.pid"), { force: true });
    },
    seedFixtureRepo: () => join(repo, ".dev", "fixture-repo"),
    computeAvailablePorts: async () => ({ serverPort: 41_223, webPort: 41_224 }),
    getElectronBinary: () => process.execPath,
    rebuildServerDevBundle: async () => {},
    spawnLogged: (_command, _args, options) => {
      spawnAttempted = true;
      assert.equal(existsSync(join(getRuntimePaths(repo).pidsDir, "server.pid")), false);
      assert.match(options.env.BETTER_SQLITE3_BINDING, /better_sqlite3\.electron\.node$/);
      throw new Error("stop before real launch");
    },
  });

  try {
    const paths = getRuntimePaths(repo);
    mkdirSync(paths.pidsDir, { recursive: true });
    writeFileSync(join(paths.pidsDir, "server.pid"), "999998\n");

    await assert.rejects(() => agentUp(repo), /stop before real launch/);

    assert.equal(spawnAttempted, true);
    assert.equal(existsSync(join(paths.pidsDir, "server.pid")), false);
  } finally {
    restoreHooks();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("agentUp hides the console window for runtime child processes", async () => {
  const repo = makeRepo();
  const spawnOptions = [];
  const restoreHooks = setAgentUpTestHooks({
    stopRecordedRuntimePids: async () => {},
    seedFixtureRepo: () => join(repo, ".dev", "fixture-repo"),
    computeAvailablePorts: async () => ({ serverPort: 41_227, webPort: 41_228 }),
    getElectronBinary: () => process.execPath,
    rebuildServerDevBundle: async () => {},
    spawnLogged: (_command, _args, options) => {
      spawnOptions.push(options);
      throw new Error("stop before real launch");
    },
  });

  try {
    await assert.rejects(() => agentUp(repo), /stop before real launch/);
    assert.equal(spawnOptions.length, 1);
    assert.equal(spawnOptions[0].windowsHide, true);
  } finally {
    restoreHooks();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("agentReset deletes only .dev/db between shutdown and restart", async () => {
  const repo = makeRepo();
  try {
    const calls = [];
    const paths = getRuntimePaths(repo);
    mkdirSync(paths.dbDir, { recursive: true });
    mkdirSync(paths.logsDir, { recursive: true });
    mkdirSync(paths.pidsDir, { recursive: true });
    writeFileSync(join(paths.dbDir, "app.sqlite"), "");
    writeFileSync(join(paths.logsDir, "server.log"), "keep\n");
    writeFileSync(join(paths.pidsDir, "web.pid"), "999999\n");

    await agentReset(repo, {
      down: async (receivedRepo) => calls.push(["down", receivedRepo]),
      up: async (receivedRepo) => calls.push(["up", receivedRepo]),
    });

    assert.deepEqual(calls, [
      ["down", repo],
      ["up", repo],
    ]);
    assert.equal(existsSync(paths.dbDir), false);
    assert.equal(readFileSync(join(paths.logsDir, "server.log"), "utf8"), "keep\n");
    assert.equal(readFileSync(join(paths.pidsDir, "web.pid"), "utf8"), "999999\n");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("PID records remain until owned termination completes", async () => {
  const repo = makeRepo();
  let releaseTermination;
  let terminationStarted = false;
  const termination = new Promise((resolve) => {
    releaseTermination = resolve;
  });

  try {
    const paths = getRuntimePaths(repo);
    mkdirSync(paths.pidsDir, { recursive: true });
    const pidFile = join(paths.pidsDir, "server.pid");
    writeFileSync(pidFile, "999998\n");

    const stopping = stopRecordedPidFile(pidFile, {
      repoRoot: repo,
      stop: async () => {
        terminationStarted = true;
        await termination;
      },
    });

    await waitUntil(() => terminationStarted, {
      timeoutMs: 5_000,
      intervalMs: 5,
      message: "owned termination did not start",
    });
    assert.equal(existsSync(pidFile), true);

    releaseTermination();
    await stopping;
    assert.equal(existsSync(pidFile), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("PID records remain when owned termination fails", async () => {
  const repo = makeRepo();
  try {
    const paths = getRuntimePaths(repo);
    mkdirSync(paths.pidsDir, { recursive: true });
    const pidFile = join(paths.pidsDir, "server.pid");
    writeFileSync(pidFile, "999998\n");

    await assert.rejects(
      () => stopRecordedPidFile(pidFile, {
        repoRoot: repo,
        stop: async () => {
          throw new Error("permission denied");
        },
      }),
      /permission denied/,
    );
    assert.equal(existsSync(pidFile), true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("agentDown waits for owned termination before returning", async () => {
  const repo = makeRepo();
  let releaseTermination;
  let terminationStarted = false;
  const termination = new Promise((resolve) => {
    releaseTermination = resolve;
  });

  try {
    const paths = getRuntimePaths(repo);
    mkdirSync(paths.pidsDir, { recursive: true });
    const pidFile = join(paths.pidsDir, "server.pid");
    writeFileSync(pidFile, "999998\n");

    const stopping = agentDown(repo, {
      stop: async () => {
        terminationStarted = true;
        await termination;
      },
    });

    await waitUntil(() => terminationStarted, {
      timeoutMs: 5_000,
      intervalMs: 5,
      message: "owned shutdown did not start",
    });
    assert.equal(existsSync(pidFile), true);

    releaseTermination();
    await stopping;
    assert.equal(existsSync(pidFile), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("agentReset does not start replacement before shutdown completes", async () => {
  const repo = makeRepo();
  let releaseShutdown;
  let shutdownStarted = false;
  const shutdown = new Promise((resolve) => {
    releaseShutdown = resolve;
  });

  try {
    const paths = getRuntimePaths(repo);
    mkdirSync(paths.dbDir, { recursive: true });
    writeFileSync(join(paths.dbDir, "app.sqlite"), "keep\n");

    const resetting = agentReset(repo, {
      down: async () => {
        shutdownStarted = true;
        await shutdown;
      },
      up: async () => {
        assert.equal(existsSync(paths.dbDir), false);
      },
    });

    await waitUntil(() => shutdownStarted, {
      timeoutMs: 5_000,
      intervalMs: 5,
      message: "shutdown did not start",
    });
    assert.equal(existsSync(paths.dbDir), true);

    releaseShutdown();
    await resetting;
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("dev web single-instance flag preserves explicit false legacy mode", () => {
  assert.equal(resolveDevSingleInstanceFlag("false"), false);
  assert.equal(resolveDevSingleInstanceFlag("0"), false);
  assert.equal(resolveDevSingleInstanceFlag("no"), false);
  assert.equal(resolveDevSingleInstanceFlag("off"), false);
});

test("dev:server SIGTERM stops the Electron server without a Vite reference error", { timeout: 75_000 }, async () => {
  const child = spawn(process.execPath, ["scripts/dev-web.mjs", "--server-only"], {
    cwd: resolve(process.cwd()),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });

  try {
    const port = await waitForServerPort(() => output);
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.ok, true);

    child.kill("SIGTERM");
    await once(child, "exit");

    await waitForServerStop(port);
    assert.doesNotMatch(errors, /ReferenceError.*vite/i);
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
});

test("server stop polling does not treat a self-caused probe timeout as stopped", { timeout: 2_000 }, async () => {
  const originalFetch = globalThis.fetch;
  let probes = 0;
  globalThis.fetch = async (_url, { signal }) => {
    probes += 1;
    await new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        const error = new Error("probe timed out");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    });
  };

  try {
    await assert.rejects(
      () => waitForServerStop(41_999, { timeoutMs: 120, intervalMs: 5, probeTimeoutMs: 20 }),
      /dev:server still responds on port 41999 after SIGTERM/,
    );
    assert.ok(probes >= 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/** Waits for dev-web to report the server-only health port. */
async function waitForServerPort(readOutput) {
  return waitUntil(() => {
    const match = /Server ready on port (\d+)/.exec(readOutput());
    if (match) return Number(match[1]);
    return false;
  }, {
    timeoutMs: 30_000,
    intervalMs: 100,
    message: () => `dev:server did not become ready: ${readOutput()}`,
  });
}

/** Waits for the server-only child to release its health endpoint. */
async function waitForServerStop(
  port,
  { timeoutMs = 5_000, intervalMs = 100, probeTimeoutMs = 1_000 } = {},
) {
  return waitUntil(async () => {
    const controller = new AbortController();
    const probeTimer = setTimeout(() => controller.abort(), probeTimeoutMs);
    try {
      await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
      return false;
    } catch (error) {
      if (controller.signal.aborted) return false;
      return error?.code === "ECONNREFUSED"
        || error?.cause?.code === "ECONNREFUSED"
        || /unable to connect/i.test(error?.message ?? "");
    } finally {
      clearTimeout(probeTimer);
    }
  }, {
    timeoutMs,
    intervalMs,
    message: () => `dev:server still responds on port ${port} after SIGTERM`,
  });
}

/** Polls a bounded condition and returns its first truthy value. */
async function waitUntil(predicate, { timeoutMs, intervalMs, message }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  }
  throw new Error(typeof message === "function" ? message() : message);
}

/**
 * Creates a minimal git repository for runtime lifecycle tests.
 *
 * @returns {string}
 */
function makeRepo() {
  const dir = mkdtempSync(resolve(tmpdir(), "runtime-lifecycle-"));
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  writeFileSync(join(dir, ".gitignore"), ".dev/\n");
  return dir;
}

/** Writes a valid runtime contract for graceful shutdown tests. */
function writeGracefulRuntimeContract(repo, serverPort) {
  writePortsFile(buildPortsContract({
    repoRoot: repo,
    serverPort,
    webPort: serverPort + 1,
    instanceToken: "instance-token-abc1234567890abc1234567890",
    worktreeIdentity: repo,
    seedLogin: {
      email: "agent@seed.local",
      token: "seed-token",
      authHeader: "Bearer seed-token",
      cookieName: "mcode-auth",
    },
  }), repo);
}
