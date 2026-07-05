#!/usr/bin/env node
/**
 * Manages runtime process PID files under the `.dev` directory.
 */
import { readFileSync, rmSync } from "node:fs";
import { basename, resolve } from "node:path";

import {
  assertInsideDevDir,
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
  const raw = readFileSync(pidFilePath, "utf8").trim();
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
 * @param {{ repoRoot?: string, signal?: NodeJS.Signals }} [options]
 */
export function stopRecordedPidFile(pidFilePath, options = {}) {
  const repoRoot = options.repoRoot ?? resolveRepoRoot();
  const { devDir } = getRuntimePaths(repoRoot);
  const resolvedPidFile = resolve(pidFilePath);
  assertInsideDevDir(resolvedPidFile, devDir);
  if (!/^[a-z0-9.-]+\.pid$/i.test(basename(resolvedPidFile))) {
    throw new Error(`Invalid PID file name: ${pidFilePath}`);
  }

  const pid = parsePidFile(resolvedPidFile);
  stopPid(pid, options.signal ?? "SIGTERM");
  rmSync(resolvedPidFile);
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
  killPidTree(pid, signal);
}
