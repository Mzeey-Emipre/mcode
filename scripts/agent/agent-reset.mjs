#!/usr/bin/env bun
/**
 * Rebuilds the disposable agent runtime database after stopping runtime processes.
 */
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { agentDown } from "./agent-down.mjs";
import { agentUp } from "./agent-up.mjs";
import { refreshRuntimeDatabase } from "./agent-setup.mjs";
import { resolveRepoRoot } from "./runtime-contract.mjs";

/**
 * Stops the runtime, refreshes its local database snapshot, and restarts it.
 *
 * @param {string} [repoRoot]
 * @param {{ down?: typeof agentDown, up?: typeof agentUp, refreshDatabase?: typeof refreshRuntimeDatabase }} [options]
 * @returns {Promise<void>}
 */
export async function agentReset(repoRoot = resolveRepoRoot(), options = {}) {
  const down = options.down ?? agentDown;
  const up = options.up ?? agentUp;
  const refreshDatabase = options.refreshDatabase ?? refreshRuntimeDatabase;
  await down(repoRoot);
  refreshDatabase(repoRoot);
  await up(repoRoot);
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  const repoRoot = process.argv[2] ? NodePath.resolve(process.argv[2]) : resolveRepoRoot();
  await agentReset(repoRoot);
}
