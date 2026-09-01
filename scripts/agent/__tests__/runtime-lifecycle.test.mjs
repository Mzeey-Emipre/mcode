/**
 * Tests for agent runtime start/stop lifecycle helpers.
 */
import * as NodeTest from "node:test";
import * as NodeAssertStrict from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeEvents from "node:events";

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

NodeTest.test("agentDown posts shutdown with seedLogin.authHeader and cleans only .dev/pids", async () => {
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
    NodeFS.mkdirSync(paths.pidsDir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(paths.pidsDir, "server.pid"), "999998\n");
    NodeFS.writeFileSync(NodePath.join(paths.pidsDir, "web.pid"), "999999\n");
    const outsidePid = NodePath.join(paths.devDir, "web.pid");
    NodeFS.writeFileSync(outsidePid, "999997\n");

    await agentDown(repo, { stop: async () => {} });

    NodeAssertStrict.default.equal(fetchCalls.length, 1);
    NodeAssertStrict.default.equal(fetchCalls[0].url, "http://127.0.0.1:41123/shutdown");
    NodeAssertStrict.default.equal(fetchCalls[0].init.method, "POST");
    NodeAssertStrict.default.equal(fetchCalls[0].init.headers.Authorization, "Bearer seed-token");
    NodeAssertStrict.default.equal(NodeFS.existsSync(NodePath.join(paths.pidsDir, "server.pid")), false);
    NodeAssertStrict.default.equal(NodeFS.existsSync(NodePath.join(paths.pidsDir, "web.pid")), false);
    NodeAssertStrict.default.equal(NodeFS.readFileSync(outsidePid, "utf8"), "999997\n");
  } finally {
    globalThis.fetch = originalFetch;
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("agentDown falls back to PID cleanup when the shutdown request never settles", { timeout: 1_000 }, async () => {
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
    NodeFS.mkdirSync(paths.pidsDir, { recursive: true });
    const pidFile = NodePath.join(paths.pidsDir, "server.pid");
    NodeFS.writeFileSync(pidFile, "999998\n");

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

    NodeAssertStrict.default.equal(NodeFS.existsSync(pidFile), false);
  } finally {
    globalThis.fetch = originalFetch;
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("agentDown does not force-stop a server that exits gracefully", async () => {
  const repo = makeRepo();
  const originalFetch = globalThis.fetch;
  let forceStops = 0;
  globalThis.fetch = async () => new Response("", { status: 200 });

  try {
    const paths = getRuntimePaths(repo);
    writeGracefulRuntimeContract(repo, 41_127);
    NodeFS.mkdirSync(paths.pidsDir, { recursive: true });
    const pidFile = NodePath.join(paths.pidsDir, "server.pid");
    NodeFS.writeFileSync(pidFile, "700001\n");

    await agentDown(repo, {
      serverGraceMs: 10,
      isProcessAlive: () => false,
      now: () => 0,
      sleep: async () => {},
      stop: async () => { forceStops += 1; },
    });

    NodeAssertStrict.default.equal(forceStops, 0);
    NodeAssertStrict.default.equal(NodeFS.existsSync(pidFile), false);
  } finally {
    globalThis.fetch = originalFetch;
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("agentDown force-stops a server that ignores graceful shutdown", async () => {
  const repo = makeRepo();
  const originalFetch = globalThis.fetch;
  let forceStops = 0;
  let clock = 0;
  globalThis.fetch = async () => new Response("", { status: 200 });

  try {
    const paths = getRuntimePaths(repo);
    writeGracefulRuntimeContract(repo, 41_129);
    NodeFS.mkdirSync(paths.pidsDir, { recursive: true });
    const pidFile = NodePath.join(paths.pidsDir, "server.pid");
    NodeFS.writeFileSync(pidFile, "700002\n");

    await agentDown(repo, {
      serverGraceMs: 10,
      isProcessAlive: () => true,
      now: () => clock,
      sleep: async (durationMs) => { clock += durationMs; },
      stop: async (pid, signal) => {
        forceStops += 1;
        NodeAssertStrict.default.equal(pid, 700002);
        NodeAssertStrict.default.equal(signal, "SIGTERM");
      },
    });

    NodeAssertStrict.default.equal(forceStops, 1);
    NodeAssertStrict.default.equal(NodeFS.existsSync(pidFile), false);
  } finally {
    globalThis.fetch = originalFetch;
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("agentDown stops the web process before the server process", async () => {
  const repo = makeRepo();
  const originalFetch = globalThis.fetch;
  const stops = [];
  let clock = 0;
  globalThis.fetch = async () => new Response("", { status: 200 });

  try {
    const paths = getRuntimePaths(repo);
    writeGracefulRuntimeContract(repo, 41_131);
    NodeFS.mkdirSync(paths.pidsDir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(paths.pidsDir, "server.pid"), "700003\n");
    NodeFS.writeFileSync(NodePath.join(paths.pidsDir, "web.pid"), "700004\n");

    await agentDown(repo, {
      serverGraceMs: 10,
      isProcessAlive: () => true,
      now: () => clock,
      sleep: async (durationMs) => { clock += durationMs; },
      stop: async (pid) => { stops.push(pid); },
    });

    NodeAssertStrict.default.deepEqual(stops, [700004, 700003]);
  } finally {
    globalThis.fetch = originalFetch;
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("agentDown retains the server PID file until forced termination settles", async () => {
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
    NodeFS.mkdirSync(paths.pidsDir, { recursive: true });
    const pidFile = NodePath.join(paths.pidsDir, "server.pid");
    NodeFS.writeFileSync(pidFile, "700005\n");

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
    NodeAssertStrict.default.equal(NodeFS.existsSync(pidFile), true);

    releaseStop();
    await stopping;
    NodeAssertStrict.default.equal(NodeFS.existsSync(pidFile), false);
  } finally {
    globalThis.fetch = originalFetch;
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("agentDown still cleans PID files when ports.json is malformed", async () => {
  const repo = makeRepo();
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  globalThis.fetch = async () => {
    throw new Error("fetch must not run for malformed ports.json");
  };
  console.warn = () => {};

  try {
    const paths = getRuntimePaths(repo);
    NodeFS.mkdirSync(paths.devDir, { recursive: true });
    NodeFS.mkdirSync(paths.pidsDir, { recursive: true });
    NodeFS.writeFileSync(paths.portsFile, "{not json");
    NodeFS.writeFileSync(NodePath.join(paths.pidsDir, "server.pid"), "999998\n");

    await agentDown(repo, { stop: async () => {} });

    NodeAssertStrict.default.equal(NodeFS.existsSync(NodePath.join(paths.pidsDir, "server.pid")), false);
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("agentUp removes stale PID files before launching server and web processes", async () => {
  const repo = makeRepo();
  let spawnAttempted = false;
  const restoreHooks = setAgentUpTestHooks({
    stopRecordedRuntimePids: async (receivedRepo) => {
      NodeFS.rmSync(NodePath.join(getRuntimePaths(receivedRepo).pidsDir, "server.pid"), { force: true });
    },
    seedFixtureRepo: () => NodePath.join(repo, ".dev", "fixture-repo"),
    computeAvailablePorts: async () => ({ serverPort: 41_223, webPort: 41_224 }),
    getElectronBinary: () => process.execPath,
    rebuildServerDevBundle: async () => {},
    spawnLogged: (_command, _args, options) => {
      spawnAttempted = true;
      NodeAssertStrict.default.equal(NodeFS.existsSync(NodePath.join(getRuntimePaths(repo).pidsDir, "server.pid")), false);
      NodeAssertStrict.default.match(options.env.BETTER_SQLITE3_BINDING, /better_sqlite3\.electron\.node$/);
      throw new Error("stop before real launch");
    },
  });

  try {
    const paths = getRuntimePaths(repo);
    NodeFS.mkdirSync(paths.pidsDir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(paths.pidsDir, "server.pid"), "999998\n");

    await NodeAssertStrict.default.rejects(() => agentUp(repo), /stop before real launch/);

    NodeAssertStrict.default.equal(spawnAttempted, true);
    NodeAssertStrict.default.equal(NodeFS.existsSync(NodePath.join(paths.pidsDir, "server.pid")), false);
  } finally {
    restoreHooks();
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("agentUp seeds the database after it stops the prior runtime", async () => {
  const repo = makeRepo();
  const events = [];
  const restoreHooks = setAgentUpTestHooks({
    stopRecordedRuntimePids: async () => { events.push("stopped"); },
    seedDatabaseForStartup: ({ repoRoot }) => {
      NodeAssertStrict.default.equal(repoRoot, repo);
      events.push("seeded");
    },
    seedFixtureRepo: () => NodePath.join(repo, ".dev", "fixture-repo"),
    computeAvailablePorts: async () => ({ serverPort: 41_229, webPort: 41_230 }),
    getElectronBinary: () => {
      NodeAssertStrict.default.deepEqual(events, ["stopped", "seeded"]);
      return null;
    },
  });

  try {
    await NodeAssertStrict.default.rejects(() => agentUp(repo), /Electron binary not found/);
  } finally {
    restoreHooks();
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("agentUp prepares fresh runtime directories before recording child PIDs", async () => {
  const repo = makeRepo();
  const paths = getRuntimePaths(repo);
  const runtimeDirectories = [
    paths.dbDir,
    paths.logsDir,
    paths.pidsDir,
    paths.playwrightScratchDir,
    paths.electronDir,
  ];
  const originalFetch = globalThis.fetch;
  let spawnCalls = 0;
  const restoreHooks = setAgentUpTestHooks({
    stopRecordedRuntimePids: async () => {},
    seedFixtureRepo: () => NodePath.join(repo, ".dev", "fixture-repo"),
    computeAvailablePorts: async () => ({ serverPort: 41_225, webPort: 41_226 }),
    getElectronBinary: () => process.execPath,
    rebuildServerDevBundle: async () => {},
    spawnLogged: () => {
      for (const directory of runtimeDirectories) {
        NodeAssertStrict.default.equal(
          NodeFS.existsSync(directory),
          true,
          `agentUp must create ${directory} before it starts runtime processes`,
        );
      }
      spawnCalls += 1;
      return { pid: 80_000 + spawnCalls };
    },
  });
  globalThis.fetch = async () => new Response("", { status: 200 });
  process.argv.push("--quiet");

  try {
    await agentUp(repo);

    NodeAssertStrict.default.equal(spawnCalls, 2);
    NodeAssertStrict.default.equal(NodeFS.readFileSync(NodePath.join(paths.pidsDir, "server.pid"), "utf8"), "80001\n");
    NodeAssertStrict.default.equal(NodeFS.readFileSync(NodePath.join(paths.pidsDir, "web.pid"), "utf8"), "80002\n");
  } finally {
    process.argv.pop();
    globalThis.fetch = originalFetch;
    restoreHooks();
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("agentUp hides the console window for runtime child processes", async () => {
  const repo = makeRepo();
  const spawnOptions = [];
  const restoreHooks = setAgentUpTestHooks({
    stopRecordedRuntimePids: async () => {},
    seedFixtureRepo: () => NodePath.join(repo, ".dev", "fixture-repo"),
    computeAvailablePorts: async () => ({ serverPort: 41_227, webPort: 41_228 }),
    getElectronBinary: () => process.execPath,
    rebuildServerDevBundle: async () => {},
    spawnLogged: (_command, _args, options) => {
      spawnOptions.push(options);
      throw new Error("stop before real launch");
    },
  });

  try {
    await NodeAssertStrict.default.rejects(() => agentUp(repo), /stop before real launch/);
    NodeAssertStrict.default.equal(spawnOptions.length, 1);
    NodeAssertStrict.default.equal(spawnOptions[0].windowsHide, true);
  } finally {
    restoreHooks();
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("agentReset deletes only .dev/db between shutdown and restart", async () => {
  const repo = makeRepo();
  try {
    const calls = [];
    const paths = getRuntimePaths(repo);
    NodeFS.mkdirSync(paths.dbDir, { recursive: true });
    NodeFS.mkdirSync(paths.logsDir, { recursive: true });
    NodeFS.mkdirSync(paths.pidsDir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(paths.dbDir, "app.sqlite"), "");
    NodeFS.writeFileSync(NodePath.join(paths.logsDir, "server.log"), "keep\n");
    NodeFS.writeFileSync(NodePath.join(paths.pidsDir, "web.pid"), "999999\n");

    await agentReset(repo, {
      down: async (receivedRepo) => calls.push(["down", receivedRepo]),
      up: async (receivedRepo) => calls.push(["up", receivedRepo]),
    });

    NodeAssertStrict.default.deepEqual(calls, [
      ["down", repo],
      ["up", repo],
    ]);
    NodeAssertStrict.default.equal(NodeFS.existsSync(paths.dbDir), false);
    NodeAssertStrict.default.equal(NodeFS.readFileSync(NodePath.join(paths.logsDir, "server.log"), "utf8"), "keep\n");
    NodeAssertStrict.default.equal(NodeFS.readFileSync(NodePath.join(paths.pidsDir, "web.pid"), "utf8"), "999999\n");
  } finally {
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("PID records remain until owned termination completes", async () => {
  const repo = makeRepo();
  let releaseTermination;
  let terminationStarted = false;
  const termination = new Promise((resolve) => {
    releaseTermination = resolve;
  });

  try {
    const paths = getRuntimePaths(repo);
    NodeFS.mkdirSync(paths.pidsDir, { recursive: true });
    const pidFile = NodePath.join(paths.pidsDir, "server.pid");
    NodeFS.writeFileSync(pidFile, "999998\n");

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
    NodeAssertStrict.default.equal(NodeFS.existsSync(pidFile), true);

    releaseTermination();
    await stopping;
    NodeAssertStrict.default.equal(NodeFS.existsSync(pidFile), false);
  } finally {
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("PID records remain when owned termination fails", async () => {
  const repo = makeRepo();
  try {
    const paths = getRuntimePaths(repo);
    NodeFS.mkdirSync(paths.pidsDir, { recursive: true });
    const pidFile = NodePath.join(paths.pidsDir, "server.pid");
    NodeFS.writeFileSync(pidFile, "999998\n");

    await NodeAssertStrict.default.rejects(
      () => stopRecordedPidFile(pidFile, {
        repoRoot: repo,
        stop: async () => {
          throw new Error("permission denied");
        },
      }),
      /permission denied/,
    );
    NodeAssertStrict.default.equal(NodeFS.existsSync(pidFile), true);
  } finally {
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("agentDown waits for owned termination before returning", async () => {
  const repo = makeRepo();
  let releaseTermination;
  let terminationStarted = false;
  const termination = new Promise((resolve) => {
    releaseTermination = resolve;
  });

  try {
    const paths = getRuntimePaths(repo);
    NodeFS.mkdirSync(paths.pidsDir, { recursive: true });
    const pidFile = NodePath.join(paths.pidsDir, "server.pid");
    NodeFS.writeFileSync(pidFile, "999998\n");

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
    NodeAssertStrict.default.equal(NodeFS.existsSync(pidFile), true);

    releaseTermination();
    await stopping;
    NodeAssertStrict.default.equal(NodeFS.existsSync(pidFile), false);
  } finally {
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("agentReset does not start replacement before shutdown completes", async () => {
  const repo = makeRepo();
  let releaseShutdown;
  let shutdownStarted = false;
  const shutdown = new Promise((resolve) => {
    releaseShutdown = resolve;
  });

  try {
    const paths = getRuntimePaths(repo);
    NodeFS.mkdirSync(paths.dbDir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(paths.dbDir, "app.sqlite"), "keep\n");

    const resetting = agentReset(repo, {
      down: async () => {
        shutdownStarted = true;
        await shutdown;
      },
      up: async () => {
        NodeAssertStrict.default.equal(NodeFS.existsSync(paths.dbDir), false);
      },
    });

    await waitUntil(() => shutdownStarted, {
      timeoutMs: 5_000,
      intervalMs: 5,
      message: "shutdown did not start",
    });
    NodeAssertStrict.default.equal(NodeFS.existsSync(paths.dbDir), true);

    releaseShutdown();
    await resetting;
  } finally {
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("dev web single-instance flag preserves explicit false legacy mode", () => {
  NodeAssertStrict.default.equal(resolveDevSingleInstanceFlag("false"), false);
  NodeAssertStrict.default.equal(resolveDevSingleInstanceFlag("0"), false);
  NodeAssertStrict.default.equal(resolveDevSingleInstanceFlag("no"), false);
  NodeAssertStrict.default.equal(resolveDevSingleInstanceFlag("off"), false);
});

NodeTest.test("dev:server SIGTERM stops the Electron server without a Vite reference error", { timeout: 75_000 }, async () => {
  const child = NodeChildProcess.spawn(process.execPath, ["scripts/dev-web.mjs", "--server-only"], {
    cwd: NodePath.resolve(process.cwd()),
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
    NodeAssertStrict.default.equal(health.ok, true);

    child.kill("SIGTERM");
    await NodeEvents.once(child, "exit");

    await waitForServerStop(port);
    NodeAssertStrict.default.doesNotMatch(errors, /ReferenceError.*vite/i);
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
});

NodeTest.test("server stop polling does not treat a self-caused probe timeout as stopped", { timeout: 2_000 }, async () => {
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
    await NodeAssertStrict.default.rejects(
      () => waitForServerStop(41_999, { timeoutMs: 120, intervalMs: 5, probeTimeoutMs: 20 }),
      /dev:server still responds on port 41999 after SIGTERM/,
    );
    NodeAssertStrict.default.ok(probes >= 1);
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
  const dir = NodeFS.mkdtempSync(NodePath.resolve(NodeOS.tmpdir(), "runtime-lifecycle-"));
  NodeFS.mkdirSync(dir, { recursive: true });
  NodeChildProcess.execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  NodeFS.writeFileSync(NodePath.join(dir, ".gitignore"), ".dev/\n");
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
