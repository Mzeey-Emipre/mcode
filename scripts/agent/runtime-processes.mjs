#!/usr/bin/env bun
/**
 * Manages runtime process PID files under the `.dev` directory.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  assertInsideDevDir,
  assertRuntimeFileSafe,
  getRuntimePaths,
  resolveRepoRoot,
} from "./runtime-contract.mjs";
import { killPidTree } from "../kill-process-tree.mjs";

/**
 * Parses a PID file that must contain exactly one positive integer PID.
 *
 * @param {string} pidFilePath
 * @returns {number}
 */
export function parsePidFile(pidFilePath) {
  const raw = NodeFS.readFileSync(pidFilePath, "utf8").trim();
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`Invalid PID file ${pidFilePath}: expected a positive integer`);
  }
  const pid = Number(raw);
  if (!Number.isSafeInteger(pid)) {
    throw new Error(`Invalid PID file ${pidFilePath}: PID is too large`);
  }
  return pid;
}

/**
 * Sends a signal to the PID recorded in one runtime PID file and removes it.
 *
 * @param {string} pidFilePath
 * @param {{ repoRoot?: string, signal?: NodeJS.Signals, stop?: typeof stopPid }} [options]
 */
export async function stopRecordedPidFile(pidFilePath, options = {}) {
  const repoRoot = options.repoRoot ?? resolveRepoRoot();
  const { devDir } = getRuntimePaths(repoRoot);
  const resolvedPidFile = NodePath.resolve(pidFilePath);
  assertInsideDevDir(resolvedPidFile, devDir);
  if (!/^[a-z0-9.-]+\.pid$/i.test(NodePath.basename(resolvedPidFile))) {
    throw new Error(`Invalid PID file name: ${pidFilePath}`);
  }

  assertRuntimeFileSafe(resolvedPidFile, "runtime PID file");

  const pid = parsePidFile(resolvedPidFile);
  const stop = options.stop ?? stopPid;
  await stop(pid, options.signal ?? "SIGTERM");
  NodeFS.rmSync(resolvedPidFile);
}

/**
 * Stops one recorded PID without consulting process names or network ports.
 *
 * @param {number} pid
 * @param {NodeJS.Signals} signal
 */
export function stopPid(pid, signal = "SIGTERM") {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`Invalid PID: ${pid}`);
  }
  return killPidTree(pid, signal, { useProcessGroup: process.platform !== "win32" });
}
