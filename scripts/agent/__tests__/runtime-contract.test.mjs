/**
 * Tests for the per-worktree runtime filesystem and port contract.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  buildPortsContract,
  computeAvailablePorts,
  computeDeterministicPort,
  ensureRuntimeRoot,
  generateInstanceToken,
  getRuntimePaths,
  readPortsFile,
  writePortsFile,
} from "../runtime-contract.mjs";
import { parsePidFile } from "../runtime-processes.mjs";

test("runtime paths stay under .dev and require .dev to be ignored", () => {
  const repo = makeRepo({ gitignore: "node_modules/\n.dev/\n" });
  try {
    const paths = ensureRuntimeRoot(repo);
    assert.equal(paths.devDir, join(repo, ".dev"));
    assert.equal(paths.portsFile, join(repo, ".dev", "ports.json"));
    assert.equal(paths.dbPath, join(repo, ".dev", "db", "app.sqlite"));
    assert.equal(paths.logsDir, join(repo, ".dev", "logs"));
    assert.equal(paths.pidsDir, join(repo, ".dev", "pids"));
    assert.equal(paths.playwrightScratchDir, join(repo, ".dev", "playwright-scratch"));
    assert.equal(paths.electronDir, join(repo, ".dev", "electron"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("runtime creation fails when .dev is not ignored", () => {
  const repo = makeRepo({ gitignore: "node_modules/\n" });
  try {
    assert.throws(
      () => ensureRuntimeRoot(repo),
      /\.gitignore must ignore \.dev\//,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("deterministic ports derive from canonical lowercase realpath modulo 1000", () => {
  const repo = makeRepo({ gitignore: ".dev/\n" });
  try {
    const canonical = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    const first = computeDeterministicPort(repo);
    const second = computeDeterministicPort(canonical.toUpperCase());
    assert.equal(first, second);
    assert.ok(first >= 41_000 && first < 42_000);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("available port assignment increments after the deterministic start on collision", async () => {
  const repo = makeRepo({ gitignore: ".dev/\n" });
  const start = computeDeterministicPort(repo);
  const server = await occupy(start);
  try {
    const ports = await computeAvailablePorts(repo);
    assert.equal(ports.serverPort, start + 1);
    assert.equal(ports.webPort, start + 2);
  } finally {
    server.close();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("ports.json round trips validated runtime ports", () => {
  const repo = makeRepo({ gitignore: ".dev/\n" });
  try {
    const contract = buildPortsContract({
      repoRoot: repo,
      serverPort: 41_111,
      webPort: 41_112,
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
    const paths = getRuntimePaths(repo);
    assert.match(readFileSync(paths.portsFile, "utf8"), /"serverPort": 41111/);
    assert.deepEqual(readPortsFile(repo), contract);
    if (process.platform !== "win32") {
      assert.equal(statSync(paths.portsFile).mode & 0o777, 0o600);
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("instance tokens are generated with crypto randomness", () => {
  const first = generateInstanceToken();
  const second = generateInstanceToken();

  assert.match(first, /^[a-f0-9]{64}$/);
  assert.match(second, /^[a-f0-9]{64}$/);
  assert.notEqual(first, second);
});

test("ports.json requires top-level instance token and worktree identity", () => {
  const repo = makeRepo({ gitignore: ".dev/\n" });
  try {
    const contract = buildPortsContract({
      repoRoot: repo,
      serverPort: 41_111,
      webPort: 41_112,
      instanceToken: "instance-token-abc1234567890abc1234567890",
      worktreeIdentity: repo,
      seedLogin: {
        email: "agent@seed.local",
        token: "seed-token",
        authHeader: "Bearer seed-token",
        cookieName: "mcode-auth",
      },
    });

    assert.throws(
      () => writePortsFile({ ...contract, instanceToken: "" }, repo),
      /instanceToken/,
    );
    assert.throws(
      () => writePortsFile({ ...contract, worktreeIdentity: "" }, repo),
      /worktreeIdentity/,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("PID files parse only positive integer PIDs", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "runtime-pid-"));
  try {
    const valid = join(dir, "web.pid");
    writeFileSync(valid, "12345\n");
    assert.equal(parsePidFile(valid), 12_345);

    for (const [name, value] of Object.entries({
      zero: "0\n",
      negative: "-1\n",
      decimal: "12.5\n",
      words: "abc\n",
      compound: "123\n456\n",
      unsafe: `${Number.MAX_SAFE_INTEGER + 1}\n`,
    })) {
      const file = join(dir, `${name}.pid`);
      writeFileSync(file, value);
      assert.throws(() => parsePidFile(file), /Invalid PID file/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Creates a minimal git repository for runtime helper tests.
 *
 * @param {{ gitignore: string }} options
 * @returns {string}
 */
function makeRepo(options) {
  const dir = mkdtempSync(resolve(tmpdir(), "runtime-contract-"));
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  writeFileSync(join(dir, ".gitignore"), options.gitignore);
  return dir;
}

/**
 * Binds a TCP socket so the runtime port probe sees the port as unavailable.
 *
 * @param {number} port
 * @returns {Promise<import("node:net").Server>}
 */
function occupy(port) {
  return new Promise((resolveServer, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolveServer(server));
  });
}
