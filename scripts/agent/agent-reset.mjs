#!/usr/bin/env bun
/**
 * Rebuilds the disposable agent runtime database after stopping runtime processes.
 */
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { agentDown } from "./agent-down.mjs";
import { agentUp } from "./agent-up.mjs";
import { getRuntimePaths, resolveRepoRoot } from "./runtime-contract.mjs";

/**
 * Stops the runtime and deletes only the disposable `.dev/db` directory.
 *
 * @param {string} [repoRoot]
 * @param {{ down?: typeof agentDown, up?: typeof agentUp }} [options]
 * @returns {Promise<void>}
 */
export async function agentReset(repoRoot = resolveRepoRoot(), options = {}) {
  const down = options.down ?? agentDown;
  const up = options.up ?? agentUp;
  await down(repoRoot);
  const paths = getRuntimePaths(repoRoot);
  rmSync(paths.dbDir, { recursive: true, force: true });
  await up(repoRoot);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repoRoot = process.argv[2] ? resolve(process.argv[2]) : resolveRepoRoot();
  await agentReset(repoRoot);
}
