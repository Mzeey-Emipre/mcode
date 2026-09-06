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

import { agentDown, stopRecordedDesktopPidFile } from "../agent-down.mjs";
import { agentUp, parseAgentUpOptions, setAgentUpTestHooks, waitForDesktopPage } from "../agent-up.mjs";
import { agentReset } from "../agent-reset.mjs";
import { agentSetup, setAgentSetupTestHooks } from "../agent-setup.mjs";
import { seedFixtureRepo } from "../fixture-repo.mjs";
import { markRuntimeDatabase } from "../runtime-database.mjs";
import {
  buildPortsContract,
  getRuntimePaths,
  readPortsFile,
  writePortsFile,
} from "../runtime-contract.mjs";
import { resolveDevSingleInstanceFlag } from "../single-instance-flag.mjs";
import { stopRecordedPidFile } from "../runtime-processes.mjs";
import { startElectron } from "../../../.agents/skills/electorn-live-testing/scripts/start-electron.mjs";

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
    computeAvailablePorts: async () => ({ serverPort: 41_223, webPort: 41_224 }),
    getElectronBinary: () => process.execPath,
    getElectronBinding: () => "/fake/better_sqlite3.electron.node",
    spawnLogged: (_command, _args, options) => {
      spawnAttempted = true;
      NodeAssertStrict.default.equal(NodeFS.existsSync(NodePath.join(getRuntimePaths(repo).pidsDir, "server.pid")), false);
      NodeAssertStrict.default.match(options.env.BETTER_SQLITE3_BINDING, /better_sqlite3\.electron\.node$/);
      throw new Error("stop before real launch");
    },
  });

  try {
    provisionRuntime(repo);
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

NodeTest.test("agentUp preserves the database after it stops the prior runtime", async () => {
  const repo = makeRepo();
  const events = [];
  const restoreHooks = setAgentUpTestHooks({
    stopRecordedRuntimePids: async () => { events.push("stopped"); },
    computeAvailablePorts: async () => ({ serverPort: 41_229, webPort: 41_230 }),
    getElectronBinary: () => {
      NodeAssertStrict.default.deepEqual(events, ["stopped"]);
      return null;
    },
  });

  try {
    provisionRuntime(repo);
    await NodeAssertStrict.default.rejects(() => agentUp(repo), /Electron binary not found/);
  } finally {
    restoreHooks();
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("agentUp fails fast when the runtime is not provisioned", async () => {
  const repo = makeRepo();
  try {
    await NodeAssertStrict.default.rejects(
      () => agentUp(repo),
      /Agent runtime is not provisioned.*agent:setup/,
    );
  } finally {
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("agentUp defaults to returning without health checks", async () => {
  const repo = makeRepo();
  const paths = getRuntimePaths(repo);
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  const restoreHooks = setAgentUpTestHooks({
    stopRecordedRuntimePids: async () => {},
    computeAvailablePorts: async () => ({ serverPort: 41_227, webPort: 41_228 }),
    getElectronBinary: () => process.execPath,
    getElectronBinding: () => "/fake/better_sqlite3.electron.node",
    spawnLogged: () => ({ pid: 80_100 }),
  });
  globalThis.fetch = async () => {
    fetchCalled = true;
    return new Response("", { status: 200 });
  };
  process.argv.push("--quiet");

  try {
    provisionRuntime(repo);
    const contract = await agentUp(repo);

    NodeAssertStrict.default.equal(fetchCalled, false, "default startup does not fetch readiness endpoints");
    NodeAssertStrict.default.equal(NodeFS.existsSync(paths.portsFile), true);
    NodeAssertStrict.default.equal(contract.serverPort, 41_227);
    NodeAssertStrict.default.equal(contract.webPort, 41_228);
    NodeAssertStrict.default.equal(NodeFS.readFileSync(NodePath.join(paths.pidsDir, "server.pid"), "utf8"), "80100\n");
    NodeAssertStrict.default.equal(NodeFS.readFileSync(NodePath.join(paths.pidsDir, "web.pid"), "utf8"), "80100\n");
  } finally {
    process.argv.pop();
    globalThis.fetch = originalFetch;
    restoreHooks();
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("agentUp prints a redacted startup summary and persists credentials", async () => {
  const repo = makeRepo();
  const originalWrite = process.stdout.write;
  let output = "";
  let quiet = false;
  const restoreHooks = setAgentUpTestHooks({
    stopRecordedRuntimePids: async () => {},
    computeAvailablePorts: async () => ({ serverPort: 41_241, webPort: 41_242 }),
    getElectronBinary: () => process.execPath,
    getElectronBinding: () => "/fake/better_sqlite3.electron.node",
    spawnLogged: () => ({ pid: 80_101 }),
  });
  process.stdout.write = (chunk, callback) => {
    output += String(chunk);
    callback?.();
    return true;
  };

  try {
    provisionRuntime(repo);
    const contract = await agentUp(repo);
    const summary = JSON.parse(output);
    const persisted = readPortsFile(repo);

    NodeAssertStrict.default.deepEqual(summary, {
      healthUrl: contract.healthUrl,
      appUrl: contract.appUrl,
      worktreeIdentity: contract.worktreeIdentity,
      contractPath: ".dev/ports.json",
    });
    NodeAssertStrict.default.doesNotMatch(output, /token|authHeader|instanceToken/i);
    NodeAssertStrict.default.match(persisted.seedLogin.authHeader, /^Bearer /);
    NodeAssertStrict.default.equal(persisted.instanceToken, contract.instanceToken);

    output = "";
    process.argv.push("--quiet");
    quiet = true;
    await agentUp(repo);
    NodeAssertStrict.default.equal(output, "");
  } finally {
    if (quiet) process.argv.pop();
    process.stdout.write = originalWrite;
    restoreHooks();
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("agentUp CLI options require --wait for blocking startup", () => {
  NodeAssertStrict.default.deepEqual(parseAgentUpOptions([]), { desktop: false, wait: false });
  NodeAssertStrict.default.deepEqual(parseAgentUpOptions(["--desktop"]), { desktop: true, wait: false });
  NodeAssertStrict.default.deepEqual(parseAgentUpOptions(["--wait"]), { desktop: false, wait: true });
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
    computeAvailablePorts: async () => ({ serverPort: 41_225, webPort: 41_226 }),
    getElectronBinary: () => process.execPath,
    getElectronBinding: () => "/fake/better_sqlite3.electron.node",
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
    provisionRuntime(repo);
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

NodeTest.test("agentUp --desktop waits for the managed Electron app and records its owned PID", async () => {
  const repo = makeRepo();
  const paths = getRuntimePaths(repo);
  const originalFetch = globalThis.fetch;
  let desktopStarted = false;
  let desktopPageProbes = 0;
  const restoreHooks = setAgentUpTestHooks({
    stopRecordedRuntimePids: async () => {},
    computeAvailablePorts: async () => ({ serverPort: 41_251, webPort: 41_252 }),
    getElectronBinary: () => process.execPath,
    getElectronBinding: () => "/fake/better_sqlite3.electron.node",
    spawnLogged: () => ({ pid: 81_000 }),
    startManagedDesktop: (receivedRepo, electronBin) => {
      NodeAssertStrict.default.equal(receivedRepo, repo);
      NodeAssertStrict.default.equal(electronBin, process.execPath);
      desktopStarted = true;
      return { endpoint: "http://127.0.0.1:43001", pid: 81_001 };
    },
  });
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/json/list")) {
      desktopPageProbes += 1;
      return new Response(JSON.stringify([
        {
          type: "page",
          url: desktopPageProbes < 3
            ? "http://127.0.0.1:41252-not-the-app/"
            : "http://127.0.0.1:41252/?ready=1",
        },
      ]));
    }
    return new Response("", { status: 200 });
  };
  process.argv.push("--quiet");

  try {
    provisionRuntime(repo);
    await agentUp(repo, { desktop: true, wait: true });

    NodeAssertStrict.default.equal(desktopStarted, true);
    NodeAssertStrict.default.equal(desktopPageProbes, 3);
    NodeAssertStrict.default.equal(
      NodeFS.readFileSync(NodePath.join(paths.pidsDir, "desktop.pid"), "utf8"),
      "81001\n",
    );
  } finally {
    process.argv.pop();
    globalThis.fetch = originalFetch;
    restoreHooks();
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("agentUp --desktop defaults to no CDP readiness wait", async () => {
  const repo = makeRepo();
  let pageWaited = false;
  const restoreHooks = setAgentUpTestHooks({
    stopRecordedRuntimePids: async () => {},
    computeAvailablePorts: async () => ({ serverPort: 41_257, webPort: 41_258 }),
    getElectronBinary: () => process.execPath,
    getElectronBinding: () => "/fake/better_sqlite3.electron.node",
    spawnLogged: () => ({ pid: 81_020 }),
    startManagedDesktop: () => ({ endpoint: "http://127.0.0.1:43003", pid: 81_021 }),
    waitForDesktopPage: async () => { pageWaited = true; },
  });
  try {
    provisionRuntime(repo);
    await agentUp(repo, { desktop: true });
    NodeAssertStrict.default.equal(pageWaited, false);
  } finally {
    restoreHooks();
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("waitForDesktopPage bounds stalled CDP probes and rejects a different app path", async () => {
  let aborts = 0;
  const fetchImpl = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => {
      aborts += 1;
      reject(new DOMException("aborted", "AbortError"));
    }, { once: true });
  });

  await NodeAssertStrict.default.rejects(
    () => waitForDesktopPage("http://127.0.0.1:43001", "http://127.0.0.1:41252/app", {
      fetchImpl,
      intervalMs: 1,
      probeTimeoutMs: 10,
      timeoutMs: 40,
    }),
    /Electron did not open the managed app URL within 40ms/,
  );
  NodeAssertStrict.default.ok(aborts >= 1);

  await waitForDesktopPage("http://127.0.0.1:43001", "http://127.0.0.1:41252/app", {
    fetchImpl: async () => new Response(JSON.stringify([
      { type: "page", url: "http://127.0.0.1:41252/app-preview" },
      { type: "page", url: "http://127.0.0.1:41252/app?ready=1" },
    ])),
    timeoutMs: 40,
  });
});

NodeTest.test("agentUp removes the desktop PID after managed page readiness fails", { timeout: 10_000 }, async () => {
  const repo = makeRepo();
  const paths = getRuntimePaths(repo);
  const originalFetch = globalThis.fetch;
  const children = [];
  const spawnChild = () => {
    const child = NodeChildProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    children.push(child);
    return { pid: child.pid };
  };
  const restoreHooks = setAgentUpTestHooks({
    stopRecordedRuntimePids: async () => {},
    computeAvailablePorts: async () => ({ serverPort: 41_253, webPort: 41_254 }),
    getElectronBinary: () => process.execPath,
    getElectronBinding: () => "/fake/better_sqlite3.electron.node",
    spawnLogged: spawnChild,
    startManagedDesktop: () => ({ ...spawnChild(), endpoint: "http://127.0.0.1:43002" }),
    stopManagedDesktop: () => ({ status: "stopped" }),
    waitForDesktopPage: async () => { throw new Error("managed app page did not load"); },
  });
  globalThis.fetch = async () => new Response("", { status: 200 });
  process.argv.push("--quiet");

  try {
    provisionRuntime(repo);
    await NodeAssertStrict.default.rejects(
      () => agentUp(repo, { desktop: true, wait: true }),
      /managed app page did not load/,
    );
    NodeAssertStrict.default.equal(NodeFS.existsSync(NodePath.join(paths.pidsDir, "desktop.pid")), false);
  } finally {
    process.argv.pop();
    globalThis.fetch = originalFetch;
    restoreHooks();
    for (const child of children) {
      if (child.exitCode === null) child.kill("SIGTERM");
    }
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("agentUp hides the console window for runtime child processes", async () => {
  const repo = makeRepo();
  const spawnOptions = [];
  const restoreHooks = setAgentUpTestHooks({
    stopRecordedRuntimePids: async () => {},
    computeAvailablePorts: async () => ({ serverPort: 41_227, webPort: 41_228 }),
    getElectronBinary: () => process.execPath,
    getElectronBinding: () => "/fake/better_sqlite3.electron.node",
    spawnLogged: (_command, _args, options) => {
      spawnOptions.push(options);
      throw new Error("stop before real launch");
    },
  });

  try {
    provisionRuntime(repo);
    await NodeAssertStrict.default.rejects(() => agentUp(repo), /stop before real launch/);
    NodeAssertStrict.default.equal(spawnOptions.length, 1);
    NodeAssertStrict.default.equal(spawnOptions[0].windowsHide, true);
  } finally {
    restoreHooks();
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("agentReset refreshes the local database snapshot before it starts the real runtime transition", async () => {
  const repo = makeRepo();
  try {
    const paths = getRuntimePaths(repo);
    NodeFS.mkdirSync(paths.dbDir, { recursive: true });
    NodeFS.writeFileSync(paths.dbPath, "old database\n");
    const calls = [];
    await agentReset(repo, {
      down: async () => calls.push("down"),
      refreshDatabase: (receivedRepo) => {
        NodeAssertStrict.default.equal(receivedRepo, repo);
        NodeFS.writeFileSync(paths.dbPath, "snapshot\n");
        calls.push("snapshot");
      },
      up: async () => {
        NodeAssertStrict.default.equal(NodeFS.readFileSync(paths.dbPath, "utf8"), "snapshot\n");
        calls.push("up");
      },
    });
    NodeAssertStrict.default.deepEqual(calls, ["down", "snapshot", "up"]);
  } finally {
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("agentSetup snapshots the database before fixture and bundle work", async () => {
  const repo = makeRepo();
  const calls = [];
  const restoreHooks = setAgentSetupTestHooks({
    seedDatabase: ({ repoRoot, target }) => {
      NodeAssertStrict.default.equal(repoRoot, repo);
      NodeAssertStrict.default.equal(target, getRuntimePaths(repo).dbPath);
      calls.push("snapshot");
    },
    markRuntimeDatabase: (repoRoot) => { NodeAssertStrict.default.equal(repoRoot, repo); calls.push("mark"); },
    seedFixtureRepo: (repoRoot) => {
      NodeAssertStrict.default.equal(repoRoot, repo);
      calls.push("fixture");
      return getRuntimePaths(repo).fixtureRepoDir;
    },
    rebuildServerDevBundle: async ({ repoRoot }) => {
      NodeAssertStrict.default.equal(repoRoot, repo);
      calls.push("bundle");
    },
    buildDesktopMain: async (repoRoot) => {
      NodeAssertStrict.default.equal(repoRoot, repo);
      calls.push("desktop");
    },
  });

  try {
    await agentSetup(repo);
    NodeAssertStrict.default.deepEqual(calls, ["snapshot", "mark", "fixture", "bundle", "desktop"]);
  } finally {
    restoreHooks();
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("agentSetup refuses to replace a database while owned runtime PID evidence exists", async () => {
  const repo = makeRepo();
  const paths = getRuntimePaths(repo);
  NodeFS.mkdirSync(paths.pidsDir, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(paths.pidsDir, "server.pid"), "12345\n");
  const restoreHooks = setAgentSetupTestHooks({
    seedDatabase: () => { throw new Error("setup replaced the database while the runtime was active"); },
  });
  try {
    await NodeAssertStrict.default.rejects(() => agentSetup(repo), /Stop the agent runtime/);
  } finally {
    restoreHooks();
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("agentSetup rejects linked runtime state before inspecting PID or session records", async (context) => {
  const repo = makeRepo();
  const external = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "runtime-setup-linked-"));
  const sentinel = NodePath.join(external, "sentinel");
  NodeFS.mkdirSync(NodePath.join(external, "pids"));
  NodeFS.writeFileSync(NodePath.join(external, "pids", "server.pid"), "999999\n");
  NodeFS.writeFileSync(NodePath.join(external, "electron-agent-runtime.json"), "{}\n");
  NodeFS.writeFileSync(sentinel, "external\n");
  let snapshotted = false;
  const restoreHooks = setAgentSetupTestHooks({ seedDatabase: () => { snapshotted = true; } });
  try {
    try {
      NodeFS.symlinkSync(external, NodePath.join(repo, ".dev"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      context.skip(`links unavailable: ${error.message}`);
      return;
    }
    await NodeAssertStrict.default.rejects(() => agentSetup(repo), /runtime directory must not be a link/);
    NodeAssertStrict.default.equal(snapshotted, false);
    NodeAssertStrict.default.equal(NodeFS.readFileSync(sentinel, "utf8"), "external\n");
  } finally {
    restoreHooks();
    NodeFS.rmSync(repo, { recursive: true, force: true });
    NodeFS.rmSync(external, { recursive: true, force: true });
  }
});

NodeTest.test("agentUp rejects linked runtime directories before launching children", async (context) => {
  const repo = makeRepo();
  const external = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "runtime-up-linked-"));
  const sentinel = NodePath.join(external, "sentinel");
  NodeFS.writeFileSync(sentinel, "external\n");
  let spawned = false;
  const restoreHooks = setAgentUpTestHooks({ spawnLogged: () => { spawned = true; } });
  try {
    NodeFS.mkdirSync(NodePath.join(repo, ".dev"));
    try {
      NodeFS.symlinkSync(external, NodePath.join(repo, ".dev", "logs"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      context.skip(`links unavailable: ${error.message}`);
      return;
    }
    await NodeAssertStrict.default.rejects(() => agentUp(repo), /runtime directory must not be a link/);
    NodeAssertStrict.default.equal(spawned, false);
    NodeAssertStrict.default.equal(NodeFS.readFileSync(sentinel, "utf8"), "external\n");
  } finally {
    restoreHooks();
    NodeFS.rmSync(repo, { recursive: true, force: true });
    NodeFS.rmSync(external, { recursive: true, force: true });
  }
});

NodeTest.test("agentUp rejects a linked runtime root before creating runtime state", async (context) => {
  const repo = makeRepo();
  const external = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "runtime-up-root-linked-"));
  const sentinel = NodePath.join(external, "sentinel");
  NodeFS.writeFileSync(sentinel, "external\n");
  try {
    try {
      NodeFS.symlinkSync(external, NodePath.join(repo, ".dev"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      context.skip(`links unavailable: ${error.message}`);
      return;
    }
    await NodeAssertStrict.default.rejects(() => agentUp(repo), /runtime directory must not be a link/);
    NodeAssertStrict.default.equal(NodeFS.readFileSync(sentinel, "utf8"), "external\n");
  } finally {
    NodeFS.rmSync(repo, { recursive: true, force: true });
    NodeFS.rmSync(external, { recursive: true, force: true });
  }
});

NodeTest.test("agentDown rejects linked runtime records without reading or stopping external state", async (context) => {
  const repo = makeRepo();
  const external = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "runtime-down-linked-"));
  const sentinel = NodePath.join(external, "server.pid");
  NodeFS.writeFileSync(sentinel, "999999\n");
  let stopped = false;
  try {
    const paths = getRuntimePaths(repo);
    NodeFS.mkdirSync(paths.pidsDir, { recursive: true });
    try {
      NodeFS.symlinkSync(sentinel, NodePath.join(paths.pidsDir, "server.pid"), "file");
    } catch (error) {
      context.skip(`links unavailable: ${error.message}`);
      return;
    }
    await NodeAssertStrict.default.rejects(() => agentDown(repo, { stop: () => { stopped = true; } }), /runtime PID file must not be a link/);
    NodeAssertStrict.default.equal(stopped, false);
    NodeAssertStrict.default.equal(NodeFS.readFileSync(sentinel, "utf8"), "999999\n");
  } finally {
    NodeFS.rmSync(repo, { recursive: true, force: true });
    NodeFS.rmSync(external, { recursive: true, force: true });
  }
});

NodeTest.test("agentDown rejects a linked runtime root before reading external contracts", async (context) => {
  const repo = makeRepo();
  const external = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "runtime-down-root-linked-"));
  const sentinel = NodePath.join(external, "ports.json");
  NodeFS.writeFileSync(sentinel, "external\n");
  try {
    try {
      NodeFS.symlinkSync(external, NodePath.join(repo, ".dev"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      context.skip(`links unavailable: ${error.message}`);
      return;
    }
    await NodeAssertStrict.default.rejects(() => agentDown(repo), /runtime directory must not be a link/);
    NodeAssertStrict.default.equal(NodeFS.readFileSync(sentinel, "utf8"), "external\n");
  } finally {
    NodeFS.rmSync(repo, { recursive: true, force: true });
    NodeFS.rmSync(external, { recursive: true, force: true });
  }
});

NodeTest.test("agentUp cleans the managed desktop session when desktop PID registration fails", async () => {
  const repo = makeRepo();
  let desktopStopped = false;
  const restoreHooks = setAgentUpTestHooks({
    stopRecordedRuntimePids: async () => {},
    computeAvailablePorts: async () => ({ serverPort: 41_271, webPort: 41_272 }),
    getElectronBinary: () => process.execPath,
    getElectronBinding: () => "/fake/better_sqlite3.electron.node",
    spawnLogged: () => ({ pid: 81_071 }),
    startManagedDesktop: () => {
      NodeFS.writeFileSync(NodePath.join(getRuntimePaths(repo).devDir, "electron-agent-runtime.json"), "session\n");
      return { endpoint: "http://127.0.0.1:43007", pid: 81_073 };
    },
    stopManagedDesktop: async () => {
      desktopStopped = true;
      NodeFS.rmSync(NodePath.join(getRuntimePaths(repo).devDir, "electron-agent-runtime.json"));
      return { status: "stopped" };
    },
    writePid: (_paths, name, pid) => {
      if (name === "desktop") throw new Error("cannot record desktop PID");
      return NodePath.join(getRuntimePaths(repo).pidsDir, `${name}-${pid}.pid`);
    },
  });
  try {
    provisionRuntime(repo);
    await NodeAssertStrict.default.rejects(() => agentUp(repo, { desktop: true }), /cannot record desktop PID/);
    NodeAssertStrict.default.equal(desktopStopped, true);
    NodeAssertStrict.default.equal(NodeFS.existsSync(NodePath.join(getRuntimePaths(repo).devDir, "electron-agent-runtime.json")), false);
  } finally {
    restoreHooks();
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("agentUp rejects a linked managed desktop user-data directory before spawning", async (context) => {
  const repo = makeRepo();
  const paths = getRuntimePaths(repo);
  const external = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "runtime-desktop-linked-"));
  const sentinel = NodePath.join(external, "sentinel");
  NodeFS.writeFileSync(sentinel, "external\n");
  let spawned = false;
  const restoreHooks = setAgentUpTestHooks({ spawnLogged: () => { spawned = true; } });
  try {
    NodeFS.mkdirSync(paths.devDir, { recursive: true });
    try {
      NodeFS.symlinkSync(external, NodePath.join(paths.devDir, "electron-agent-runtime"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      context.skip(`links unavailable: ${error.message}`);
      return;
    }
    await NodeAssertStrict.default.rejects(() => agentUp(repo, { desktop: true }), /managed desktop user-data directory must not be a link/);
    NodeAssertStrict.default.equal(spawned, false);
    NodeAssertStrict.default.equal(NodeFS.readFileSync(sentinel, "utf8"), "external\n");
  } finally {
    restoreHooks();
    NodeFS.rmSync(repo, { recursive: true, force: true });
    NodeFS.rmSync(external, { recursive: true, force: true });
  }
});

NodeTest.test("agentUp stops the captured server when server PID persistence fails", async () => {
  const repo = makeRepo();
  const stopped = [];
  const restoreHooks = setAgentUpTestHooks({
    stopRecordedRuntimePids: async () => {},
    computeAvailablePorts: async () => ({ serverPort: 41_281, webPort: 41_282 }),
    getElectronBinary: () => process.execPath,
    getElectronBinding: () => "/fake/better_sqlite3.electron.node",
    spawnLogged: () => ({ pid: 81_081 }),
    writePid: () => { throw new Error("cannot record server PID"); },
    stopPid: async (pid) => { stopped.push(pid); },
  });
  try {
    provisionRuntime(repo);
    await NodeAssertStrict.default.rejects(() => agentUp(repo), /cannot record server PID/);
    NodeAssertStrict.default.deepEqual(stopped, [81_081]);
  } finally {
    restoreHooks();
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("agentUp stops captured web and server processes when web PID persistence fails", async () => {
  const repo = makeRepo();
  const stopped = [];
  let spawned = 0;
  const restoreHooks = setAgentUpTestHooks({
    stopRecordedRuntimePids: async () => {},
    computeAvailablePorts: async () => ({ serverPort: 41_283, webPort: 41_284 }),
    getElectronBinary: () => process.execPath,
    getElectronBinding: () => "/fake/better_sqlite3.electron.node",
    spawnLogged: () => ({ pid: spawned++ === 0 ? 81_083 : 81_084 }),
    writePid: (_paths, name) => {
      if (name === "web") throw new Error("cannot record web PID");
      return NodePath.join(getRuntimePaths(repo).pidsDir, "server.pid");
    },
    stopPid: async (pid) => { stopped.push(pid); },
  });
  try {
    provisionRuntime(repo);
    await NodeAssertStrict.default.rejects(() => agentUp(repo), /cannot record web PID/);
    NodeAssertStrict.default.deepEqual(stopped, [81_084, 81_083]);
  } finally {
    restoreHooks();
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("agentUp falls back to the captured desktop PID when managed cleanup rejects", async () => {
  const repo = makeRepo();
  const paths = getRuntimePaths(repo);
  const stopped = [];
  let spawned = 0;
  const restoreHooks = setAgentUpTestHooks({
    stopRecordedRuntimePids: async () => {},
    computeAvailablePorts: async () => ({ serverPort: 41_285, webPort: 41_286 }),
    getElectronBinary: () => process.execPath,
    getElectronBinding: () => "/fake/better_sqlite3.electron.node",
    spawnLogged: () => ({ pid: spawned++ === 0 ? 81_085 : 81_086 }),
    startManagedDesktop: () => {
      NodeFS.writeFileSync(NodePath.join(paths.devDir, "electron-agent-runtime.json"), "session\n");
      return { endpoint: "http://127.0.0.1:43008", pid: 81_087 };
    },
    stopManagedDesktop: async () => { throw new Error("managed desktop cleanup failed"); },
    writePid: (_paths, name, pid) => {
      if (name === "desktop") throw new Error("cannot record desktop PID");
      const file = NodePath.join(paths.pidsDir, `${name}.pid`);
      NodeFS.writeFileSync(file, `${pid}\n`);
      return file;
    },
    stopPid: async (pid) => { stopped.push(pid); },
  });
  try {
    provisionRuntime(repo);
    let error;
    try {
      await agentUp(repo, { desktop: true });
    } catch (caught) {
      error = caught;
    }
    NodeAssertStrict.default.match(error.message, /cannot record desktop PID/);
    NodeAssertStrict.default.deepEqual(stopped, [81_087, 81_086, 81_085]);
    NodeAssertStrict.default.equal(NodeFS.existsSync(NodePath.join(paths.devDir, "electron-agent-runtime.json")), false);
    NodeAssertStrict.default.equal(NodeFS.existsSync(NodePath.join(paths.pidsDir, "server.pid")), false);
    NodeAssertStrict.default.equal(NodeFS.existsSync(NodePath.join(paths.pidsDir, "web.pid")), false);
  } finally {
    restoreHooks();
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("agentUp retains the desktop session when managed and captured cleanup both fail", async () => {
  const repo = makeRepo();
  const paths = getRuntimePaths(repo);
  const restoreHooks = setAgentUpTestHooks({
    stopRecordedRuntimePids: async () => {},
    computeAvailablePorts: async () => ({ serverPort: 41_287, webPort: 41_288 }),
    getElectronBinary: () => process.execPath,
    getElectronBinding: () => "/fake/better_sqlite3.electron.node",
    spawnLogged: (() => { let pid = 81_088; return () => ({ pid: pid++ }); })(),
    startManagedDesktop: () => {
      NodeFS.writeFileSync(NodePath.join(paths.devDir, "electron-agent-runtime.json"), "session\n");
      return { endpoint: "http://127.0.0.1:43009", pid: 81_090 };
    },
    stopManagedDesktop: async () => { throw new Error("managed desktop cleanup failed"); },
    writePid: (_paths, name, pid) => {
      if (name === "desktop") throw new Error("cannot record desktop PID");
      const file = NodePath.join(paths.pidsDir, `${name}.pid`);
      NodeFS.writeFileSync(file, `${pid}\n`);
      return file;
    },
    stopPid: async (pid) => {
      if (pid === 81_090) throw new Error("captured desktop cleanup failed");
    },
  });
  try {
    provisionRuntime(repo);
    await NodeAssertStrict.default.rejects(() => agentUp(repo, { desktop: true }), /cannot record desktop PID/);
    NodeAssertStrict.default.equal(NodeFS.existsSync(NodePath.join(paths.devDir, "electron-agent-runtime.json")), true);
  } finally {
    restoreHooks();
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("agentUp stops the captured desktop PID when managed cleanup reports not-running", async () => {
  const repo = makeRepo();
  const paths = getRuntimePaths(repo);
  const stopped = [];
  const restoreHooks = setAgentUpTestHooks({
    stopRecordedRuntimePids: async () => {},
    computeAvailablePorts: async () => ({ serverPort: 41_289, webPort: 41_290 }),
    getElectronBinary: () => process.execPath,
    getElectronBinding: () => "/fake/better_sqlite3.electron.node",
    spawnLogged: (() => { let pid = 81_091; return () => ({ pid: pid++ }); })(),
    startManagedDesktop: () => {
      NodeFS.writeFileSync(NodePath.join(paths.devDir, "electron-agent-runtime.json"), "session\n");
      return { endpoint: "http://127.0.0.1:43010", pid: 81_093 };
    },
    stopManagedDesktop: async () => ({ status: "not-running" }),
    writePid: (_paths, name, pid) => {
      if (name === "desktop") throw new Error("cannot record desktop PID");
      const file = NodePath.join(paths.pidsDir, `${name}.pid`);
      NodeFS.writeFileSync(file, `${pid}\n`);
      return file;
    },
    stopPid: async (pid) => { stopped.push(pid); },
  });
  try {
    provisionRuntime(repo);
    await NodeAssertStrict.default.rejects(() => agentUp(repo, { desktop: true }), /cannot record desktop PID/);
    NodeAssertStrict.default.equal(stopped[0], 81_093);
    NodeAssertStrict.default.equal(NodeFS.existsSync(NodePath.join(paths.devDir, "electron-agent-runtime.json")), false);
  } finally {
    restoreHooks();
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("startElectron rejects linked user-data paths before Electron resolution", async (context) => {
  const repo = makeRepo();
  const paths = getRuntimePaths(repo);
  const external = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "runtime-electron-helper-linked-"));
  const sentinel = NodePath.join(external, "sentinel");
  NodeFS.mkdirSync(NodePath.join(repo, "scripts", "agent"), { recursive: true });
  NodeFS.copyFileSync(NodePath.resolve(process.cwd(), "scripts", "agent", "runtime-contract.mjs"), NodePath.join(repo, "scripts", "agent", "runtime-contract.mjs"));
  NodeFS.writeFileSync(sentinel, "external\n");
  try {
    writeGracefulRuntimeContract(repo, 41_291);
    try {
      NodeFS.symlinkSync(external, NodePath.join(paths.devDir, "electron-agent-runtime"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      context.skip(`links unavailable: ${error.message}`);
      return;
    }
    await NodeAssertStrict.default.rejects(
      () => startElectron(repo, { sessionFileName: "electron-agent-runtime.json", waitForDebugger: false }),
      /managed desktop user-data directory must not be a link/,
    );
    NodeFS.rmSync(NodePath.join(paths.devDir, "electron-agent-runtime"));
    NodeFS.mkdirSync(NodePath.join(paths.devDir, "electron-agent-runtime"));
    NodeFS.symlinkSync(external, NodePath.join(paths.devDir, "electron-agent-runtime", "runtime"), process.platform === "win32" ? "junction" : "dir");
    await NodeAssertStrict.default.rejects(
      () => startElectron(repo, { sessionFileName: "electron-agent-runtime.json", waitForDebugger: false }),
      /managed desktop runtime directory must not be a link/,
    );
    NodeAssertStrict.default.equal(NodeFS.readFileSync(sentinel, "utf8"), "external\n");
  } finally {
    NodeFS.rmSync(repo, { recursive: true, force: true });
    NodeFS.rmSync(external, { recursive: true, force: true });
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

NodeTest.test("desktop PID remains until the managed desktop process tree stops", async () => {
  const repo = makeRepo();
  const pidFile = NodePath.join(getRuntimePaths(repo).pidsDir, "desktop.pid");
  NodeFS.mkdirSync(NodePath.dirname(pidFile), { recursive: true });
  NodeFS.writeFileSync(pidFile, "999998\n");
  let releaseStop;
  const stopped = new Promise((resolve) => { releaseStop = resolve; });
  try {
    const stopping = stopRecordedDesktopPidFile(pidFile, repo, {
      stopManagedDesktop: async () => {
        await stopped;
        return { status: "stopped" };
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    NodeAssertStrict.default.equal(NodeFS.existsSync(pidFile), true);
    releaseStop();
    await stopping;
    NodeAssertStrict.default.equal(NodeFS.existsSync(pidFile), false);
  } finally {
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("desktop PID remains when managed desktop cleanup rejects", async () => {
  const repo = makeRepo();
  const paths = getRuntimePaths(repo);
  NodeFS.mkdirSync(paths.pidsDir, { recursive: true });
  const pidFile = NodePath.join(paths.pidsDir, "desktop.pid");
  NodeFS.writeFileSync(pidFile, "999998\n");
  try {
    await NodeAssertStrict.default.rejects(
      () => stopRecordedDesktopPidFile(pidFile, repo, {
        stopManagedDesktop: async () => { throw new Error("desktop stop failed"); },
      }),
      /desktop stop failed/,
    );
    NodeAssertStrict.default.equal(NodeFS.existsSync(pidFile), true);
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
      refreshDatabase: () => NodeFS.writeFileSync(paths.dbPath, "snapshot\n"),
      up: async () => {
        NodeAssertStrict.default.equal(NodeFS.existsSync(paths.dbPath), true);
        NodeAssertStrict.default.equal(NodeFS.readFileSync(paths.dbPath, "utf8"), "snapshot\n");
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

/**
 * Creates the minimal provisioned state that agentUp expects.
 *
 * @param {string} repo
 */
function provisionRuntime(repo) {
  const paths = getRuntimePaths(repo);
  NodeFS.mkdirSync(paths.dbDir, { recursive: true });
  NodeFS.writeFileSync(paths.dbPath, "test database\n");
  markRuntimeDatabase(repo);
  seedFixtureRepo(repo);
  const serverBundle = NodePath.resolve(repo, "apps", "desktop", "dist", "server", "server.cjs");
  NodeFS.mkdirSync(NodePath.dirname(serverBundle), { recursive: true });
  NodeFS.writeFileSync(serverBundle, "// bundle\n");
  const desktopMain = NodePath.resolve(repo, "apps", "desktop", "dist", "main", "main.cjs");
  NodeFS.mkdirSync(NodePath.dirname(desktopMain), { recursive: true });
  NodeFS.writeFileSync(desktopMain, "// desktop main\n");
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
