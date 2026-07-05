#!/usr/bin/env node
/**
 * Seeds the deterministic agent runtime fixture git repository.
 */
import { spawnSync } from "node:child_process";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

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

  rmSync(fixtureDir, { recursive: true, force: true });
  mkdirSync(fixtureDir, { recursive: true });

  git(fixtureDir, ["init", "-q", "-b", "main"]);
  git(fixtureDir, ["config", "user.email", "agent-runtime@example.invalid"]);
  git(fixtureDir, ["config", "user.name", "Agent Runtime Fixture"]);
  git(fixtureDir, ["config", "commit.gpgsign", "false"]);

  writeFileSync(join(fixtureDir, "README.md"), "# Fixture repo\n");
  writeFileSync(join(fixtureDir, "agent.txt"), "base\n");
  git(fixtureDir, ["add", "."]);
  git(fixtureDir, ["commit", "-q", "-m", "chore: seed fixture repo"]);

  writeFileSync(join(fixtureDir, "agent.txt"), "runtime base\n");
  git(fixtureDir, ["add", "agent.txt"]);
  git(fixtureDir, ["commit", "-q", "-m", "feat: add runtime baseline"]);

  git(fixtureDir, ["checkout", "-q", "-b", "conflict/agent-runtime"]);
  writeFileSync(join(fixtureDir, "agent.txt"), "conflict branch value\n");
  git(fixtureDir, ["add", "agent.txt"]);
  git(fixtureDir, ["commit", "-q", "-m", "test: add conflict branch edit"]);

  git(fixtureDir, ["checkout", "-q", "main"]);
  writeFileSync(join(fixtureDir, "agent.txt"), "main branch value\n");
  git(fixtureDir, ["add", "agent.txt"]);
  git(fixtureDir, ["commit", "-q", "-m", "feat: update main runtime value"]);

  git(fixtureDir, ["checkout", "-q", "-b", "feature/agent-runtime"]);
  writeFileSync(join(fixtureDir, "feature.txt"), "feature branch fixture\n");
  git(fixtureDir, ["add", "feature.txt"]);
  git(fixtureDir, ["commit", "-q", "-m", "feat: add agent runtime fixture"]);

  git(fixtureDir, ["checkout", "-q", "main"]);
  return fixtureDir;
}

/**
 * Runs git inside the fixture repository.
 *
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string}
 */
function git(cwd, args) {
  const result = spawnSync("git", [
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.hooksPath=NUL",
    ...args,
  ], {
    cwd,
    encoding: "utf8",
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
