/**
 * Tests for agent runtime start/stop lifecycle helpers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

import { agentDown } from "../agent-down.mjs";
import { agentUp, setAgentUpTestHooks } from "../agent-up.mjs";
import { agentReset } from "../agent-reset.mjs";
import {
  buildPortsContract,
  getRuntimePaths,
  writePortsFile,
} from "../runtime-contract.mjs";
import { resolveDevSingleInstanceFlag } from "../single-instance-flag.mjs";

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

    await agentDown(repo);

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

    await agentDown(repo);

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
    seedFixtureRepo: () => join(repo, ".dev", "fixture-repo"),
    computeAvailablePorts: async () => ({ serverPort: 41_223, webPort: 41_224 }),
    getElectronBinary: () => process.execPath,
    rebuildServerDevBundle: async () => {},
    spawnLogged: () => {
      spawnAttempted = true;
      assert.equal(existsSync(join(getRuntimePaths(repo).pidsDir, "server.pid")), false);
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

test("dev web single-instance flag preserves explicit false legacy mode", () => {
  assert.equal(resolveDevSingleInstanceFlag("false"), false);
  assert.equal(resolveDevSingleInstanceFlag("0"), false);
  assert.equal(resolveDevSingleInstanceFlag("no"), false);
  assert.equal(resolveDevSingleInstanceFlag("off"), false);
});

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
