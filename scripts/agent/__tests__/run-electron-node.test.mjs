/** Tests workspace CLI entry containment in the Electron Node wrapper. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("Electron adapter uses the bounded verification phase timeout", () => {
  assert.ok(ELECTRON_PROCESS_TIMEOUT_MS > 0);
  assert.ok(ELECTRON_PROCESS_TIMEOUT_MS <= 10 * 60 * 1_000);
});

function runWorkspaceCli(entryFile) {
  return spawnSync(
    process.execPath,
    [wrapper, "--workspace-cli", "better-sqlite3", entryFile],
    options,
  );
}

function runElectronNode(...args) {
  return spawnSync(process.execPath, [wrapper, ...args], options);
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
  while (!existsSync(descendantFile) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(existsSync(descendantFile), true, "descendant PID file was never written");
}

async function waitForProcessToStop(pid) {
  const deadline = Date.now() + 5_000;
  let alive = true;
  while (alive && Date.now() < deadline) {
    alive = await processIsAlive(pid);
  }
  assert.equal(alive, false, `descendant ${pid} survived cleanup`);
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
    const alive = spawnSync("tasklist", ["/FI", `PID eq ${descendantPid}`], { encoding: "utf8" });
    assert.doesNotMatch(alive.stdout, new RegExp(`\\b${descendantPid}\\b`));
    return;
  }
  await waitForProcessToStop(descendantPid);
}

test("Electron Node forwards output and preserves exit status", testOptions, () => {
  const result = runElectronNode(
    "-e",
    "console.log('electron-stdout'); console.error('electron-stderr'); process.exitCode = 7;",
  );

  assert.equal(result.error, undefined);
  assert.equal(result.status, 7, result.stderr);
  assert.equal(result.stdout, "electron-stdout\n");
  assert.equal(result.stderr, "electron-stderr\n");
});

test("workspace CLI accepts a nested package entry", testOptions, () => {
  const result = runWorkspaceCli("lib/index.js");

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});

test("workspace CLI preserves missing-entry errors", testOptions, () => {
  const result = runWorkspaceCli("missing-entry.mjs");

  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Workspace CLI entry not found/);
});

test("workspace CLI rejects entries outside the package directory", testOptions, () => {
  const result = runWorkspaceCli("../package.json");

  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Workspace CLI entry must stay inside its package directory/);
});

test("Electron timeout terminates a detached descendant group", { timeout: 10_000 }, async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), "mcode-electron-process-"));
  const descendantFile = join(tempDirectory, "descendant.pid");
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

    assert.equal(result.timedOut, true);
    assert.equal(result.status, 1);

    const descendantPid = Number.parseInt(readFileSync(descendantFile, "utf8"), 10);
    assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
    await assertDescendantStopped(descendantPid);
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

if (process.platform !== "win32") {
  test("Electron adapter forwards parent signals to its owned detached tree", { timeout: 15_000 }, async () => {
    await verifyForwardedSignal();
  });
}

async function verifyForwardedSignal() {
    const tempDirectory = mkdtempSync(join(tmpdir(), "mcode-electron-signal-"));
    const descendantFile = join(tempDirectory, "descendant.pid");
  const childCode = descendantChildCode();
  const wrapperChild = spawn(
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
    const descendantPid = Number.parseInt(readFileSync(descendantFile, "utf8"), 10);
    assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);

    const exited = once(wrapperChild, "exit");
    assert.equal(wrapperChild.kill("SIGTERM"), true);
    const [status, signal] = await exited;
    assert.equal(status, 1);
    assert.equal(signal, null);

    await waitForProcessToStop(descendantPid);
  } finally {
    if (wrapperChild.exitCode === null && wrapperChild.signalCode === null) wrapperChild.kill("SIGKILL");
    rmSync(tempDirectory, { recursive: true, force: true });
  }
}
