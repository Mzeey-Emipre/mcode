#!/usr/bin/env bun
/**
 * Seeds the deterministic agent runtime fixture git repository.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  assertInsideDevDir,
  ensureRuntimeRoot,
  getRuntimePaths,
  resolveRepoRoot,
} from "./runtime-contract.mjs";

/**
 * Rebuilds `.dev/fixture-repo` with deterministic branches and conflicts.
 *
 * @param {string} [repoRoot]
 * @returns {string}
 */
export function seedFixtureRepo(repoRoot = resolveRepoRoot()) {
  const paths = ensureRuntimeRoot(repoRoot);
  const fixtureDir = paths.fixtureRepoDir;
  assertInsideDevDir(fixtureDir, paths.devDir);

  NodeFS.rmSync(fixtureDir, { recursive: true, force: true });
  NodeFS.mkdirSync(fixtureDir, { recursive: true });

  git(fixtureDir, ["init", "-q", "-b", "main"]);
  git(fixtureDir, ["config", "user.email", "agent-runtime@example.invalid"]);
  git(fixtureDir, ["config", "user.name", "Agent Runtime Fixture"]);
  git(fixtureDir, ["config", "commit.gpgsign", "false"]);
  git(fixtureDir, ["fast-import", "--quiet"], fixtureHistory());
  git(fixtureDir, ["checkout", "-q", "main"]);
  return fixtureDir;
}

/** Returns whether the fixture is an independent repository at its exact runtime path. */
export function isFixtureRepo(repoRoot = resolveRepoRoot()) {
  const fixtureDir = getRuntimePaths(repoRoot).fixtureRepoDir;
  try {
    if (NodeFS.lstatSync(fixtureDir).isSymbolicLink()) return false;
    const gitDir = NodePath.join(fixtureDir, ".git");
    const gitDirStats = NodeFS.lstatSync(gitDir);
    if (gitDirStats.isSymbolicLink() || !gitDirStats.isDirectory()) return false;
    const result = NodeChildProcess.spawnSync("git", ["rev-parse", "--show-toplevel", "--git-common-dir"], {
      cwd: fixtureDir,
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status !== 0) return false;
    const [topLevel, commonDir] = result.stdout.trim().split(/\r?\n/);
    return isExactPath(topLevel, fixtureDir)
      && isPathInside(NodePath.resolve(fixtureDir, commonDir), fixtureDir);
  } catch {
    return false;
  }
}

function isExactPath(candidate, expected) {
  return NodeFS.realpathSync.native(candidate).toLowerCase()
    === NodeFS.realpathSync.native(expected).toLowerCase();
}

function isPathInside(candidate, parent) {
  const resolvedCandidate = NodeFS.realpathSync.native(candidate).toLowerCase();
  const resolvedParent = NodeFS.realpathSync.native(parent).toLowerCase();
  const prefix = resolvedParent.endsWith(NodePath.sep) ? resolvedParent : `${resolvedParent}${NodePath.sep}`;
  return resolvedCandidate === resolvedParent || resolvedCandidate.startsWith(prefix);
}

function fixtureHistory() {
  const identity = `Agent Runtime Fixture <agent-runtime@example.invalid> ${Math.floor(Date.now() / 1_000)} +0000`;
  return [
    fastImportCommit({
      branch: "main",
      mark: 1,
      message: "chore: seed fixture repo",
      files: [
        ["README.md", "# Fixture repo\n"],
        ["agent.txt", "base\n"],
      ],
      identity,
    }),
    fastImportCommit({
      branch: "main",
      mark: 2,
      parent: 1,
      message: "feat: add runtime baseline",
      files: [["agent.txt", "runtime base\n"]],
      identity,
    }),
    fastImportCommit({
      branch: "conflict/agent-runtime",
      mark: 3,
      parent: 2,
      message: "test: add conflict branch edit",
      files: [["agent.txt", "conflict branch value\n"]],
      identity,
    }),
    fastImportCommit({
      branch: "main",
      mark: 4,
      parent: 2,
      message: "feat: update main runtime value",
      files: [["agent.txt", "main branch value\n"]],
      identity,
    }),
    fastImportCommit({
      branch: "feature/agent-runtime",
      mark: 5,
      parent: 4,
      message: "feat: add agent runtime fixture",
      files: [["feature.txt", "feature branch fixture\n"]],
      identity,
    }),
    "done\n",
  ].join("");
}

function fastImportCommit({ branch, mark, parent, message, files, identity }) {
  return [
    `commit refs/heads/${branch}\n`,
    `mark :${mark}\n`,
    `author ${identity}\n`,
    `committer ${identity}\n`,
    fastImportData(`${message}\n`),
    parent ? `from :${parent}\n` : "",
    ...files.map(([path, contents]) => `M 100644 inline ${path}\n${fastImportData(contents)}`),
  ].join("");
}

function fastImportData(value) {
  return `data ${Buffer.byteLength(value)}\n${value}`;
}

/**
 * Runs git inside the fixture repository.
 *
 * @param {string} cwd
 * @param {string[]} args
 * @param {string} [input]
 * @returns {string}
 */
function git(cwd, args, input) {
  const result = NodeChildProcess.spawnSync("git", [
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.hooksPath=NUL",
    "-c",
    "commit.gpgsign=false",
    ...args,
  ], {
    cwd,
    encoding: "utf8",
    input,
    timeout: 60_000,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_EDITOR: "true",
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed with ${result.status}: ${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout;
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  const repoRoot = process.argv[2] ? NodePath.resolve(process.argv[2]) : resolveRepoRoot();
  console.log(seedFixtureRepo(repoRoot));
}
