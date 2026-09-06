/** Tests for the detached runtime readiness command. */
import * as NodeAssertStrict from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHTTP from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import { agentReady } from "../agent-ready.mjs";
import { MANAGED_DESKTOP_SESSION_FILE } from "../managed-desktop.mjs";
import { buildPortsContract, getRuntimePaths, writePortsFile } from "../runtime-contract.mjs";

NodeTest.test("agentReady polls contract health and app URLs until both respond", async () => {
  const repo = makeRepo();
  let healthRequests = 0;
  let appRequests = 0;
  const health = await startServer((_request, response) => {
    healthRequests += 1;
    response.writeHead(healthRequests < 2 ? 503 : 200).end();
  });
  const app = await startServer((_request, response) => {
    appRequests += 1;
    response.writeHead(appRequests < 3 ? 503 : 200).end();
  });

  try {
    writeContract(repo, health.port, app.port);
    const result = await agentReady(repo, { timeoutMs: 1_000, httpOptions: { intervalMs: 5, probeTimeoutMs: 50 } });

    NodeAssertStrict.default.deepEqual(result, { desktop: false });
    NodeAssertStrict.default.ok(healthRequests >= 2, "health URL was polled from the contract");
    NodeAssertStrict.default.ok(appRequests >= 3, "app URL was polled from the contract");
  } finally {
    await closeServer(health.server);
    await closeServer(app.server);
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("agentReady fails at the deadline when a contract endpoint never becomes ready", async () => {
  const repo = makeRepo();
  const health = await startServer((_request, response) => response.writeHead(503).end());
  const app = await startServer((_request, response) => response.writeHead(200).end());

  try {
    writeContract(repo, health.port, app.port);
    await NodeAssertStrict.default.rejects(
      () => agentReady(repo, { timeoutMs: 60, httpOptions: { intervalMs: 5, probeTimeoutMs: 20 } }),
      /server health did not become reachable/,
    );
  } finally {
    await closeServer(health.server);
    await closeServer(app.server);
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("agentReady verifies the optional managed desktop CDP endpoint and exact app page", async () => {
  const repo = makeRepo();
  const health = await startServer((_request, response) => response.writeHead(200).end());
  const app = await startServer((_request, response) => response.writeHead(200).end());
  const desktop = await startServer((request, response) => {
    if (request.url === "/json/version") {
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(validCdpVersion(desktop.port)));
      return;
    }
    if (request.url === "/json/list") {
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify([
        { type: "page", url: `http://127.0.0.1:${app.port}` },
      ]));
      return;
    }
    response.writeHead(404).end();
  });

  try {
    const contract = writeContract(repo, health.port, app.port);
    const desktopProcess = startOwnedProcess(repo, desktop.port);
    const sessionFile = NodePath.join(getRuntimePaths(repo).devDir, MANAGED_DESKTOP_SESSION_FILE);
    NodeFS.writeFileSync(sessionFile, `${JSON.stringify({
      status: "running",
      repoRoot: repo,
      appUrlPrefix: contract.appUrl,
      debugPort: desktop.port,
      endpoint: `http://127.0.0.1:${desktop.port}`,
      pid: desktopProcess.pid,
      executablePath: process.execPath,
    })}\n`);

    try {
      const result = await agentReady(repo, {
        timeoutMs: 1_000,
        httpOptions: { intervalMs: 5, probeTimeoutMs: 50 },
        desktopOptions: { intervalMs: 5, probeTimeoutMs: 50 },
      });

      NodeAssertStrict.default.deepEqual(result, { desktop: true });
    } finally {
      stopOwnedProcess(desktopProcess);
    }
  } finally {
    await closeServer(health.server);
    await closeServer(app.server);
    await closeServer(desktop.server);
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("agentReady rejects a desktop session whose PID command is not owned", async () => {
  const repo = makeRepo();
  const desktopProcess = startOwnedProcess(repo, 43_001);
  try {
    const contract = writeContract(repo, 43_002, 43_003);
    const sessionFile = NodePath.join(getRuntimePaths(repo).devDir, MANAGED_DESKTOP_SESSION_FILE);
    NodeFS.writeFileSync(sessionFile, `${JSON.stringify({
      status: "running",
      repoRoot: repo,
      appUrlPrefix: contract.appUrl,
      debugPort: 43_001,
      endpoint: "http://127.0.0.1:43001",
      pid: desktopProcess.pid,
      executablePath: NodePath.join(repo, "not-owned-electron"),
    })}\n`);

    await NodeAssertStrict.default.rejects(() => agentReady(repo), /Managed desktop session belongs to a different worktree or app/);
  } finally {
    stopOwnedProcess(desktopProcess);
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("agentReady rejects linked runtime paths without reading external contracts", async (test) => {
  const repo = makeRepo();
  const external = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "agent-ready-external-"));
  NodeFS.writeFileSync(NodePath.join(external, "sentinel"), "preserve");
  try {
    try {
      NodeFS.symlinkSync(external, NodePath.join(repo, ".dev"), "junction");
    } catch (error) {
      test.skip(`Links are unavailable: ${error.code}`);
      return;
    }
    await NodeAssertStrict.default.rejects(() => agentReady(repo), /runtime directory must not be a link/);
    NodeAssertStrict.default.equal(NodeFS.readFileSync(NodePath.join(external, "sentinel"), "utf8"), "preserve");
  } finally {
    NodeFS.rmSync(repo, { recursive: true, force: true });
    NodeFS.rmSync(external, { recursive: true, force: true });
  }
});

NodeTest.test("agentReady rejects a linked ports file without reading the target", async (test) => {
  const repo = makeRepo();
  const external = NodePath.join(NodeOS.tmpdir(), `agent-ready-contract-${Date.now()}.json`);
  NodeFS.writeFileSync(external, "external contract");
  try {
    NodeFS.mkdirSync(NodePath.join(repo, ".dev"));
    try {
      NodeFS.symlinkSync(external, NodePath.join(repo, ".dev", "ports.json"), "file");
    } catch (error) {
      test.skip(`Links are unavailable: ${error.code}`);
      return;
    }
    await NodeAssertStrict.default.rejects(() => agentReady(repo), /runtime contract must not be a link/);
    NodeAssertStrict.default.equal(NodeFS.readFileSync(external, "utf8"), "external contract");
  } finally {
    NodeFS.rmSync(repo, { recursive: true, force: true });
    NodeFS.rmSync(external, { force: true });
  }
});

NodeTest.test("agentReady compares worktree paths with platform case rules", async () => {
  const repo = makeRepo();
  const health = await startServer((_request, response) => response.writeHead(200).end());
  const app = await startServer((_request, response) => response.writeHead(200).end());
  try {
    writeContract(repo, health.port, app.port, repo.toUpperCase());
    if (process.platform === "win32") {
      await agentReady(repo, { httpOptions: { intervalMs: 5, probeTimeoutMs: 50 } });
    } else {
      await NodeAssertStrict.default.rejects(() => agentReady(repo), /different worktree/);
    }
  } finally {
    await closeServer(health.server);
    await closeServer(app.server);
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

function writeContract(repo, serverPort, webPort, worktreeIdentity = repo) {
  const contract = buildPortsContract({
    repoRoot: repo,
    serverPort,
    webPort,
    instanceToken: "a".repeat(64),
    worktreeIdentity,
    seedLogin: {
      email: "agent@seed.local",
      token: "test-token",
      authHeader: "Bearer test-token",
      cookieName: "mcode-auth",
    },
  });
  writePortsFile(contract, repo);
  return contract;
}

function validCdpVersion(port) {
  return {
    Browser: "Electron/37.3.1",
    "Protocol-Version": "1.3",
    webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/session`,
  };
}

function startOwnedProcess(repo, port) {
  const script = NodePath.join(repo, "owned-desktop.mjs");
  NodeFS.writeFileSync(script, "setTimeout(() => {}, 30000);\n");
  return NodeChildProcess.spawn(process.execPath, [script, `--remote-debugging-port=${port}`], {
    detached: false,
    stdio: "ignore",
    windowsHide: true,
  });
}

function stopOwnedProcess(child) {
  if (child?.pid && child.exitCode === null) child.kill();
}

function makeRepo() {
  const repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "agent-ready-"));
  NodeFS.writeFileSync(NodePath.join(repo, ".gitignore"), ".dev/\n");
  return repo;
}

async function startServer(handler) {
  const server = NodeHTTP.createServer(handler);
  await new Promise((resolveStart, rejectStart) => {
    server.once("error", rejectStart);
    server.listen(0, "127.0.0.1", resolveStart);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not expose a TCP port");
  return { server, port: address.port };
}

async function closeServer(server) {
  await new Promise((resolveClose) => server.close(resolveClose));
}
