/** Tests workspace CLI entry containment in the Electron Node wrapper. */
import * as NodeAssertStrict from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeTest from "node:test";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  ELECTRON_PROCESS_TIMEOUT_MS,
  runElectronProcess,
} from "../../run-electron-node.mjs";

const wrapper = "scripts/run-electron-node.mjs";
const options = {
  cwd: process.cwd(),
  encoding: "utf8",
  timeout: 60_000,
};
const testOptions = { timeout: 75_000 };

NodeTest.test("Electron adapter uses the bounded verification phase timeout", () => {
  NodeAssertStrict.default.ok(ELECTRON_PROCESS_TIMEOUT_MS > 0);
  NodeAssertStrict.default.ok(ELECTRON_PROCESS_TIMEOUT_MS <= 10 * 60 * 1_000);
});

function runWorkspaceCli(entryFile) {
  return NodeChildProcess.spawnSync(
    process.execPath,
    [wrapper, "--workspace-cli", "better-sqlite3", entryFile],
    options,
  );
}

function runElectronNode(...args) {
  return NodeChildProcess.spawnSync(process.execPath, [wrapper, ...args], options);
}

function descendantChildCode() {
  return [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    "const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    "writeFileSync(process.env.MCODE_TEST_DESCENDANT_FILE, String(descendant.pid));",
    "setInterval(() => {}, 1000);",
  ].join("\n");
}

async function waitForDescendantFile(descendantFile) {
  const deadline = Date.now() + 5_000;
  while (!NodeFS.existsSync(descendantFile) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  NodeAssertStrict.default.equal(NodeFS.existsSync(descendantFile), true, "descendant PID file was never written");
}

async function waitForProcessToStop(pid) {
  const deadline = Date.now() + 5_000;
  let alive = true;
  while (alive && Date.now() < deadline) {
    alive = await processIsAlive(pid);
  }
  NodeAssertStrict.default.equal(alive, false, `descendant ${pid} survived cleanup`);
}

async function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    await new Promise((resolve) => setTimeout(resolve, 25));
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function assertDescendantStopped(descendantPid) {
  if (process.platform === "win32") {
    const alive = NodeChildProcess.spawnSync("tasklist", ["/FI", `PID eq ${descendantPid}`], { encoding: "utf8" });
    NodeAssertStrict.default.doesNotMatch(alive.stdout, new RegExp(`\\b${descendantPid}\\b`));
    return;
  }
  await waitForProcessToStop(descendantPid);
}

NodeTest.test("Electron Node forwards output and preserves exit status", testOptions, () => {
  const result = runElectronNode(
    "-e",
    "console.log('electron-stdout'); console.error('electron-stderr'); process.exitCode = 7;",
  );

  NodeAssertStrict.default.equal(result.error, undefined);
  NodeAssertStrict.default.equal(result.status, 7, result.stderr);
  NodeAssertStrict.default.equal(result.stdout, "electron-stdout\n");
  NodeAssertStrict.default.equal(result.stderr, "electron-stderr\n");
});

NodeTest.test("workspace CLI accepts a nested package entry", testOptions, () => {
  const result = runWorkspaceCli("lib/index.js");

  NodeAssertStrict.default.equal(result.error, undefined);
  NodeAssertStrict.default.equal(result.status, 0, result.stderr);
});

NodeTest.test("workspace CLI preserves missing-entry errors", testOptions, () => {
  const result = runWorkspaceCli("missing-entry.mjs");

  NodeAssertStrict.default.equal(result.error, undefined);
  NodeAssertStrict.default.equal(result.status, 1);
  NodeAssertStrict.default.match(result.stderr, /Workspace CLI entry not found/);
});

NodeTest.test("workspace CLI rejects entries outside the package directory", testOptions, () => {
  const result = runWorkspaceCli("../package.json");

  NodeAssertStrict.default.equal(result.error, undefined);
  NodeAssertStrict.default.equal(result.status, 1);
  NodeAssertStrict.default.match(result.stderr, /Workspace CLI entry must stay inside its package directory/);
});

NodeTest.test("Electron timeout terminates a detached descendant group", { timeout: 10_000 }, async () => {
  const tempDirectory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-electron-process-"));
  const descendantFile = NodePath.join(tempDirectory, "descendant.pid");
  const childCode = descendantChildCode();

  try {
    const started = runElectronProcess(process.execPath, ["-e", childCode], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MCODE_TEST_DESCENDANT_FILE: descendantFile,
      },
      timeoutMs: 2_000,
    });

    await waitForDescendantFile(descendantFile);
    const result = await started;

    NodeAssertStrict.default.equal(result.timedOut, true);
    NodeAssertStrict.default.equal(result.status, 1);

    const descendantPid = Number.parseInt(NodeFS.readFileSync(descendantFile, "utf8"), 10);
    NodeAssertStrict.default.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
    await assertDescendantStopped(descendantPid);
  } finally {
    NodeFS.rmSync(tempDirectory, { recursive: true, force: true });
  }
});

if (process.platform !== "win32") {
  NodeTest.test("Electron adapter forwards parent signals to its owned detached tree", { timeout: 15_000 }, async () => {
    await verifyForwardedSignal();
  });
}

async function verifyForwardedSignal() {
    const tempDirectory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-electron-signal-"));
    const descendantFile = NodePath.join(tempDirectory, "descendant.pid");
  const childCode = descendantChildCode();
  const wrapperChild = NodeChildProcess.spawn(
    process.execPath,
    [wrapper, "-e", childCode],
    {
      cwd: process.cwd(),
      env: { ...process.env, MCODE_TEST_DESCENDANT_FILE: descendantFile },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  try {
    await waitForDescendantFile(descendantFile);
    const descendantPid = Number.parseInt(NodeFS.readFileSync(descendantFile, "utf8"), 10);
    NodeAssertStrict.default.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);

    const exited = NodeEvents.once(wrapperChild, "exit");
    NodeAssertStrict.default.equal(wrapperChild.kill("SIGTERM"), true);
    const [status, signal] = await exited;
    NodeAssertStrict.default.equal(status, 1);
    NodeAssertStrict.default.equal(signal, null);

    await waitForProcessToStop(descendantPid);
  } finally {
    if (wrapperChild.exitCode === null && wrapperChild.signalCode === null) wrapperChild.kill("SIGKILL");
    NodeFS.rmSync(tempDirectory, { recursive: true, force: true });
  }
}
