/**
 * Platform-aware process tree termination for dev orchestration scripts.
 *
 * On Windows, child.kill() only terminates the direct subprocess (e.g. bun),
 * leaving grandchildren (e.g. the Vite server spawned by bun) as orphans that
 * continue holding their network ports across dev sessions.
 */

import { spawnSync } from "node:child_process";

/** Max wait for taskkill to propagate through a deep process tree. */
export const TASKKILL_TIMEOUT_MS = 5_000;

/**
 * Kill a child process and its entire process tree.
 *
 * @param {import("node:child_process").ChildProcess | null | undefined} child
 */
export function killProcessTree(child) {
  if (!child?.pid) return;
  killPidTree(child.pid);
}

/**
 * Kill a process ID and its entire process tree.
 *
 * @param {number} pid
 * @param {NodeJS.Signals} [signal]
 */
export function killPidTree(pid, signal = "SIGTERM") {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`Invalid PID: ${pid}`);
  }

  if (process.platform === "win32") {
    spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], {
      stdio: "ignore",
      timeout: TASKKILL_TIMEOUT_MS,
    });
    return;
  }

  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}
