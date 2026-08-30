#!/usr/bin/env bun
/**
 * Seeds the deterministic agent runtime fixture git repository.
 */
import { spawnSync } from "node:child_process";
import { rmSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertInsideDevDir,
  ensureRuntimeRoot,
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

  rmSync(fixtureDir, { recursive: true, force: true });
  mkdirSync(fixtureDir, { recursive: true });

  git(fixtureDir, ["init", "-q", "-b", "main"]);
  git(fixtureDir, ["config", "user.email", "agent-runtime@example.invalid"]);
  git(fixtureDir, ["config", "user.name", "Agent Runtime Fixture"]);
  git(fixtureDir, ["config", "commit.gpgsign", "false"]);
  git(fixtureDir, ["fast-import", "--quiet"], fixtureHistory());
  git(fixtureDir, ["checkout", "-q", "main"]);
  return fixtureDir;
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
  const result = spawnSync("git", [
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repoRoot = process.argv[2] ? resolve(process.argv[2]) : resolveRepoRoot();
  console.log(seedFixtureRepo(repoRoot));
}
