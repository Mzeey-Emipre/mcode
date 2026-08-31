#!/usr/bin/env bun
/**
 * Rebuilds the disposable agent runtime database after stopping runtime processes.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { agentDown } from "./agent-down.mjs";
import { agentUp } from "./agent-up.mjs";
import { ensureDependencies } from "./ensure-dependencies.mjs";
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
  NodeFS.rmSync(paths.dbDir, { recursive: true, force: true });
  await up(repoRoot);
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  const repoRoot = process.argv[2] ? NodePath.resolve(process.argv[2]) : resolveRepoRoot();
  ensureDependencies({ repoRoot });
  await agentReset(repoRoot);
}
