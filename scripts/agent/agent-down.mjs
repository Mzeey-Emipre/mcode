#!/usr/bin/env bun
/**
 * Stops only the processes recorded for the per-worktree agent runtime.
 */
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  getRuntimePaths,
  readPortsFile,
  resolveRepoRoot,
} from "./runtime-contract.mjs";
import { stopRecordedPidFile } from "./runtime-processes.mjs";

/**
 * Stops the agent runtime processes recorded under `.dev/pids`.
 *
 * @param {string} [repoRoot]
 * @param {{ stop?: (pid: number, signal: NodeJS.Signals) => Promise<void> | void }} [options]
 * @returns {Promise<void>}
 */
export async function agentDown(repoRoot = resolveRepoRoot(), options = {}) {
  const contract = readPortsFileForShutdown(repoRoot);
  if (contract?.seedLogin?.token) {
    try {
      await fetch(`http://127.0.0.1:${contract.serverPort}/shutdown`, {
        method: "POST",
        headers: { Authorization: contract.seedLogin.authHeader },
      });
    } catch {
      // Fall through to PID-based cleanup; the server may already be stopped.
    }
  }

  await stopRecordedRuntimePids(repoRoot, options);
}

/**
 * Reads ports.json for graceful shutdown without blocking PID cleanup.
 *
 * @param {string} repoRoot
 * @returns {import("./runtime-contract.mjs").AgentRuntimePorts | null}
 */
function readPortsFileForShutdown(repoRoot) {
  try {
    return readPortsFile(repoRoot);
  } catch (error) {
    console.warn(`[agent:down] Ignoring invalid ports.json: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Stops only runtime PID files recorded under this worktree's `.dev/pids`.
 *
 * @param {string} [repoRoot]
 * @param {{ stop?: (pid: number, signal: NodeJS.Signals) => Promise<void> | void }} [options]
 * @returns {Promise<void>}
 */
export async function stopRecordedRuntimePids(repoRoot = resolveRepoRoot(), options = {}) {
  const paths = getRuntimePaths(repoRoot);
  if (!existsSync(paths.pidsDir)) return;
  const pidFiles = readdirSync(paths.pidsDir)
    .filter((name) => name.endsWith(".pid"))
    .sort()
    .reverse();

  for (const name of pidFiles) {
    const pidFile = join(paths.pidsDir, name);
    try {
      await stopRecordedPidFile(pidFile, { repoRoot, stop: options.stop });
    } catch (error) {
      if (error?.code !== "ENOENT") {
        console.warn(`[agent:down] ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repoRoot = process.argv[2] ? resolve(process.argv[2]) : resolveRepoRoot();
  await agentDown(repoRoot);
}
