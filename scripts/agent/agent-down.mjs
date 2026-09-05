#!/usr/bin/env bun
/**
 * Stops only the processes recorded for the per-worktree agent runtime.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  getRuntimePaths,
  readPortsFile,
  resolveRepoRoot,
} from "./runtime-contract.mjs";
import { parsePidFile, stopRecordedPidFile } from "./runtime-processes.mjs";
import { stopManagedDesktop } from "./managed-desktop.mjs";

/**
 * Stops the agent runtime processes recorded under `.dev/pids`.
 *
 * @param {string} [repoRoot]
 * @param {{ stop?: (pid: number, signal: NodeJS.Signals) => Promise<void> | void }} [options]
 * @returns {Promise<void>}
 */
export async function agentDown(repoRoot = resolveRepoRoot(), options = {}) {
  const contract = readPortsFileForShutdown(repoRoot);
  const gracefulShutdownRequested = Boolean(contract?.seedLogin?.token);
  if (contract?.seedLogin?.token) {
    try {
      await fetchWithTimeout(`http://127.0.0.1:${contract.serverPort}/shutdown`, {
        method: "POST",
        headers: { Authorization: contract.seedLogin.authHeader },
      }, options.shutdownTimeoutMs ?? 5_000);
    } catch {
      // Fall through to PID-based cleanup; the server may already be stopped.
    }
  }

  await stopRecordedRuntimePids(repoRoot, {
    ...options,
    gracefulShutdownRequested,
  });
}

/**
 * Sends a shutdown request without allowing an unavailable server to block
 * ownership cleanup in `.dev/pids`.
 *
 * @param {string} url
 * @param {RequestInit} init
 * @param {number} timeoutMs
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, init, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Invalid shutdown timeout: ${timeoutMs}`);
  }
  const controller = new AbortController();
  let timeoutTimer;
  const timeout = new Promise((_, reject) => {
    timeoutTimer = setTimeout(() => {
      controller.abort();
      const error = new Error(`Shutdown request timed out after ${timeoutMs}ms`);
      error.code = "MCODE_SHUTDOWN_TIMEOUT";
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      fetch(url, { ...init, signal: controller.signal }),
      timeout,
    ]);
  } finally {
    clearTimeout(timeoutTimer);
  }
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
  if (!NodeFS.existsSync(paths.pidsDir)) return;
  const pidFiles = NodeFS.readdirSync(paths.pidsDir)
    .filter((name) => name.endsWith(".pid"))
    .sort()
    .reverse();

  for (const name of pidFiles) {
    const pidFile = NodePath.join(paths.pidsDir, name);
    try {
      await stopRuntimePidFile(name, pidFile, repoRoot, options);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        console.warn(`[agent:down] ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

async function stopRuntimePidFile(name, pidFile, repoRoot, options) {
  if (name === "server.pid") {
    return stopRecordedServerPidFile(pidFile, repoRoot, options);
  }
  if (name === "desktop.pid") {
    return stopRecordedDesktopPidFile(pidFile, repoRoot, options);
  }
  return stopRecordedPidFile(pidFile, { repoRoot, stop: options.stop });
}

/** Stops the validated managed desktop tree before removing its PID file. */
export async function stopRecordedDesktopPidFile(pidFile, repoRoot, options = {}) {
  const result = stopManagedDesktop(repoRoot);
  if (result.status === "not-running") {
    return stopRecordedPidFile(pidFile, { repoRoot, stop: options.stop });
  }
  NodeFS.rmSync(pidFile);
}

/**
 * Lets the server's authenticated shutdown finish before force-stopping it.
 *
 * @param {string} pidFile
 * @param {string} repoRoot
 * @param {{ stop?: (pid: number, signal: NodeJS.Signals) => Promise<void> | void, shutdownGraceMs?: number, serverGraceMs?: number, isProcessAlive?: (pid: number) => boolean, sleep?: (ms: number) => Promise<void>, now?: () => number, gracefulShutdownRequested?: boolean }} options
 * @returns {Promise<void>}
 */
async function stopRecordedServerPidFile(pidFile, repoRoot, options) {
  if (!options.gracefulShutdownRequested) {
    await stopRecordedPidFile(pidFile, { repoRoot, stop: options.stop });
    return;
  }
  const graceMs = options.serverGraceMs ?? options.shutdownGraceMs ?? 10_000;
  const isProcessAlive = options.isProcessAlive ?? isPidAlive;
  const pid = parsePidFile(pidFile);
  const stopped = await waitForProcessExit(pid, graceMs, {
    isProcessAlive,
    sleep: options.sleep,
    now: options.now,
  });
  if (stopped) {
    NodeFS.rmSync(pidFile);
    return;
  }
  await stopRecordedPidFile(pidFile, { repoRoot, stop: options.stop });
}

/**
 * Waits for a process to disappear without consulting process names or ports.
 *
 * @param {number} pid
 * @param {number} timeoutMs
 * @param {{ isProcessAlive: (pid: number) => boolean, sleep?: (ms: number) => Promise<void>, now?: () => number }} options
 * @returns {Promise<boolean>}
 */
async function waitForProcessExit(pid, timeoutMs, { isProcessAlive, sleep = delay, now = Date.now }) {
  const deadline = now() + timeoutMs;
  if (!isProcessAlive(pid)) return true;
  while (now() < deadline) {
    await sleep(Math.min(100, Math.max(1, deadline - now())));
    if (!isProcessAlive(pid)) return true;
  }
  return !isProcessAlive(pid);
}

/** Returns whether a PID currently refers to a live process. */
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

/** Resolves after the requested delay. */
function delay(timeoutMs) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, timeoutMs));
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  const repoRoot = process.argv[2] ? NodePath.resolve(process.argv[2]) : resolveRepoRoot();
  await agentDown(repoRoot);
}
