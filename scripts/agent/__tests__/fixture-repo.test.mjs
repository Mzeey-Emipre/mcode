/**
 * Tests for the deterministic agent runtime fixture repository.
 */
import * as NodeTest from "node:test";
import * as NodeAssertStrict from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { seedFixtureRepo } from "../fixture-repo.mjs";

NodeTest.test("fixture repo seeds expected branches and real merge conflict", () => {
  const repo = makeHostRepo();
  try {
    const fixture = seedFixtureRepo(repo);
    const branches = git(fixture, ["branch", "--format=%(refname:short)"])
      .split(/\r?\n/)
      .filter(Boolean)
      .sort();
    NodeAssertStrict.default.deepEqual(branches, [
      "conflict/agent-runtime",
      "feature/agent-runtime",
      "main",
    ]);

    const commitCount = Number(git(fixture, ["rev-list", "--all", "--count"]).trim());
    NodeAssertStrict.default.equal(commitCount, 5);

    git(fixture, ["checkout", "-q", "main"]);
    const merge = gitResult(fixture, ["merge", "--no-edit", "conflict/agent-runtime"]);
    NodeAssertStrict.default.notEqual(merge.status, 0, merge.stdout + merge.stderr);

    const conflicted = git(fixture, ["diff", "--name-only", "--diff-filter=U"])
      .split(/\r?\n/)
      .filter(Boolean);
    NodeAssertStrict.default.deepEqual(conflicted, ["agent.txt"]);
    git(fixture, ["merge", "--abort"]);
  } finally {
    removeTree(repo);
  }
});

NodeTest.test("fixture seeding is idempotent inside .dev fixture directory", () => {
  const repo = makeHostRepo();
  try {
    const first = seedFixtureRepo(repo);
    const second = seedFixtureRepo(repo);
    NodeAssertStrict.default.equal(second, first);
    NodeAssertStrict.default.equal(git(second, ["status", "--short"]), "");
  } finally {
    removeTree(repo);
  }
});

/**
 * Creates a host repo whose `.dev` directory is ignored.
 *
 * @returns {string}
 */
function makeHostRepo() {
  const dir = NodeFS.mkdtempSync(NodePath.resolve(NodeOS.tmpdir(), "fixture-host-"));
  NodeChildProcess.execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  NodeFS.writeFileSync(NodePath.join(dir, ".gitignore"), ".dev/\n");
  return dir;
}

/**
 * Runs git in a repository and returns stdout.
 *
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string}
 */
function git(cwd, args) {
  return NodeChildProcess.execFileSync("git", gitArgs(args), gitOptions(cwd));
}

/**
 * Runs git in a repository and returns the completed process.
 *
 * @param {string} cwd
 * @param {string[]} args
 * @returns {import("node:child_process").SpawnSyncReturns<string>}
 */
function gitResult(cwd, args) {
  return NodeChildProcess.spawnSync("git", gitArgs(args), gitOptions(cwd));
}

/**
 * Returns bounded noninteractive git arguments.
 *
 * @param {string[]} args
 * @returns {string[]}
 */
function gitArgs(args) {
  return [
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.hooksPath=NUL",
    ...args,
  ];
}

/**
 * Returns bounded noninteractive git process options.
 *
 * @param {string} cwd
 * @returns {import("node:child_process").SpawnSyncOptionsWithStringEncoding}
 */
function gitOptions(cwd) {
  return {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_EDITOR: "true",
    },
  };
}

/**
 * Removes a temporary repository, retrying around short-lived Windows git handles.
 *
 * @param {string} dir
 */
function removeTree(dir) {
  try {
    NodeFS.rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: process.platform === "win32" ? 10 : 0,
      retryDelay: 100,
    });
  } catch (error) {
    if (process.platform !== "win32" || error?.code !== "EPERM") {
      throw error;
    }
    console.warn(`[fixture-repo.test] Could not remove temp repo ${dir}: ${error.message}`);
  }
}
