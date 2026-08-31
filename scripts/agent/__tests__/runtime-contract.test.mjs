/**
 * Tests for the per-worktree runtime filesystem and port contract.
 */
import * as NodeTest from "node:test";
import * as NodeAssertStrict from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  buildPortsContract,
  buildRuntimeStateEnv,
  computeAvailablePorts,
  computeDeterministicPort,
  ensureRuntimeRoot,
  generateInstanceToken,
  getRuntimePaths,
  readPortsFile,
  writePortsFile,
} from "../runtime-contract.mjs";
import { parsePidFile } from "../runtime-processes.mjs";

NodeTest.test("runtime paths stay under .dev and require .dev to be ignored", () => {
  const repo = makeRepo({ gitignore: "node_modules/\n.dev/\n" });
  try {
    const paths = ensureRuntimeRoot(repo);
    NodeAssertStrict.default.equal(paths.devDir, NodePath.join(repo, ".dev"));
    NodeAssertStrict.default.equal(paths.portsFile, NodePath.join(repo, ".dev", "ports.json"));
    NodeAssertStrict.default.equal(paths.dbPath, NodePath.join(repo, ".dev", "db", "app.sqlite"));
    NodeAssertStrict.default.equal(paths.logsDir, NodePath.join(repo, ".dev", "logs"));
    NodeAssertStrict.default.equal(paths.pidsDir, NodePath.join(repo, ".dev", "pids"));
    NodeAssertStrict.default.equal(paths.playwrightScratchDir, NodePath.join(repo, ".dev", "playwright-scratch"));
    NodeAssertStrict.default.equal(paths.electronDir, NodePath.join(repo, ".dev", "electron"));
  } finally {
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("runtime state env points dev commands at the worktree-local agent state", () => {
  const repo = makeRepo({ gitignore: ".dev/\n" });
  try {
    const env = buildRuntimeStateEnv(repo, { MCODE_AGENT_FIXTURE_REPO: "fixture" });

    NodeAssertStrict.default.equal(env.MCODE_AGENT_RUNTIME, "1");
    NodeAssertStrict.default.equal(env.MCODE_DATA_DIR, NodePath.join(repo, ".dev"));
    NodeAssertStrict.default.equal(env.MCODE_DB_PATH, NodePath.join(repo, ".dev", "db", "app.sqlite"));
    NodeAssertStrict.default.equal(env.MCODE_ELECTRON_USER_DATA_DIR, NodePath.join(repo, ".dev", "electron"));
    NodeAssertStrict.default.equal(env.MCODE_AGENT_FIXTURE_REPO, "fixture");
  } finally {
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("runtime creation fails when .dev is not ignored", () => {
  const repo = makeRepo({ gitignore: "node_modules/\n" });
  try {
    NodeAssertStrict.default.throws(
      () => ensureRuntimeRoot(repo),
      /\.gitignore must ignore \.dev\//,
    );
  } finally {
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("deterministic ports derive from canonical lowercase realpath modulo 1000", () => {
  const repo = makeRepo({ gitignore: ".dev/\n" });
  try {
    const canonical = NodeChildProcess.execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    const first = computeDeterministicPort(repo);
    const second = computeDeterministicPort(canonical.toUpperCase());
    NodeAssertStrict.default.equal(first, second);
    if (process.platform === "win32") {
      NodeAssertStrict.default.equal(first, computeDeterministicPort(NodePath.win32.toNamespacedPath(canonical)));
    }
    NodeAssertStrict.default.ok(first >= 41_000 && first < 42_000);
  } finally {
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("available port assignment increments after the deterministic start on collision", async () => {
  const repo = makeRepo({ gitignore: ".dev/\n" });
  const start = computeDeterministicPort(repo);
  const server = await occupy(start);
  try {
    const ports = await computeAvailablePorts(repo);
    NodeAssertStrict.default.equal(ports.serverPort, start + 1);
    NodeAssertStrict.default.equal(ports.webPort, start + 2);
  } finally {
    server.close();
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("ports.json round trips validated runtime ports", () => {
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
    NodeAssertStrict.default.match(NodeFS.readFileSync(paths.portsFile, "utf8"), /"serverPort": 41111/);
    NodeAssertStrict.default.deepEqual(readPortsFile(repo), contract);
    if (process.platform !== "win32") {
      NodeAssertStrict.default.equal(NodeFS.statSync(paths.portsFile).mode & 0o777, 0o600);
    }
  } finally {
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("instance tokens are generated with crypto randomness", () => {
  const first = generateInstanceToken();
  const second = generateInstanceToken();

  NodeAssertStrict.default.match(first, /^[a-f0-9]{64}$/);
  NodeAssertStrict.default.match(second, /^[a-f0-9]{64}$/);
  NodeAssertStrict.default.notEqual(first, second);
});

NodeTest.test("ports.json requires top-level instance token and worktree identity", () => {
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

    NodeAssertStrict.default.throws(
      () => writePortsFile({ ...contract, instanceToken: "" }, repo),
      /instanceToken/,
    );
    NodeAssertStrict.default.throws(
      () => writePortsFile({ ...contract, worktreeIdentity: "" }, repo),
      /worktreeIdentity/,
    );
  } finally {
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});

NodeTest.test("PID files parse only positive integer PIDs", () => {
  const dir = NodeFS.mkdtempSync(NodePath.resolve(NodeOS.tmpdir(), "runtime-pid-"));
  try {
    const valid = NodePath.join(dir, "web.pid");
    NodeFS.writeFileSync(valid, "12345\n");
    NodeAssertStrict.default.equal(parsePidFile(valid), 12_345);

    for (const [name, value] of Object.entries({
      zero: "0\n",
      negative: "-1\n",
      decimal: "12.5\n",
      words: "abc\n",
      compound: "123\n456\n",
      unsafe: `${Number.MAX_SAFE_INTEGER + 1}\n`,
    })) {
      const file = NodePath.join(dir, `${name}.pid`);
      NodeFS.writeFileSync(file, value);
      NodeAssertStrict.default.throws(() => parsePidFile(file), /Invalid PID file/);
    }
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Creates a minimal git repository for runtime helper tests.
 *
 * @param {{ gitignore: string }} options
 * @returns {string}
 */
function makeRepo(options) {
  const dir = NodeFS.mkdtempSync(NodePath.resolve(NodeOS.tmpdir(), "runtime-contract-"));
  NodeFS.mkdirSync(dir, { recursive: true });
  NodeChildProcess.execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  NodeFS.writeFileSync(NodePath.join(dir, ".gitignore"), options.gitignore);
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
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolveServer(server));
  });
}
