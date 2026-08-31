/**
 * Platform-aware process tree termination for dev orchestration scripts.
 *
 * On Windows, child.kill() only terminates the direct subprocess (e.g. bun),
 * leaving grandchildren (e.g. the Vite server spawned by bun) as orphans that
 * continue holding their network ports across dev sessions.
 */

import * as NodeChildProcess from "node:child_process";

/** Max wait for taskkill to propagate through a deep process tree. */
export const TASKKILL_TIMEOUT_MS = 5_000;

/** Grace period between the soft and hard POSIX process-group signals. */
export const PROCESS_GROUP_GRACE_MS = 500;

/**
 * Kill a child process and its entire process tree.
 *
 * @param {import("node:child_process").ChildProcess | null | undefined} child
 * @param {{ graceMs?: number, useProcessGroup?: boolean }} [options]
 * @returns {Promise<void> | undefined}
 */
export function killProcessTree(child, options) {
  if (!child?.pid) return;
  return killPidTree(child.pid, "SIGTERM", { ...options, child });
}

/**
 * Kill a process ID and its entire process tree.
 *
 * @param {number} pid
 * @param {NodeJS.Signals} [signal]
 * @param {{ graceMs?: number, useProcessGroup?: boolean, child?: import("node:child_process").ChildProcess }} [options]
 * @returns {Promise<void> | undefined}
 */
export function killPidTree(
  pid,
  signal = "SIGTERM",
  { graceMs = PROCESS_GROUP_GRACE_MS, useProcessGroup = false, child } = {},
) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`Invalid PID: ${pid}`);
  }

  if (process.platform === "win32") {
    NodeChildProcess.spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], {
      stdio: "ignore",
      timeout: TASKKILL_TIMEOUT_MS,
    });
    return;
  }

  return terminatePosixProcess(pid, signal, graceMs, useProcessGroup, child);
}

/**
 * Signal a detached POSIX process group, then hard-kill any members that ignore
 * the graceful signal. A non-detached child falls back to its direct PID when
 * no group exists for that PID.
 *
 * @param {number} pid
 * @param {NodeJS.Signals} signal
 * @param {number} graceMs
 * @param {boolean} useProcessGroup
 * @param {import("node:child_process").ChildProcess | undefined} child
 * @returns {Promise<void>}
 */
async function terminatePosixProcess(pid, signal, graceMs, useProcessGroup, child) {
  if (child && isChildExited(child)) return;
  signalPosixProcess(pid, signal, useProcessGroup);
  if (graceMs <= 0) return;

  await waitForChildExitOrTimeout(child, graceMs);
  if (child && isChildExited(child)) return;
  if (!isProcessAlive(pid, useProcessGroup)) return;
  signalPosixProcess(pid, "SIGKILL", useProcessGroup);
}

/** Waits for a child to exit, or for the graceful termination window to end. */
function waitForChildExitOrTimeout(child, graceMs) {
  if (!child?.once) return new Promise((resolve) => setTimeout(resolve, graceMs));
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off?.("exit", finish);
      resolve();
    };
    timer = setTimeout(finish, graceMs);
    child.once("exit", finish);
    if (isChildExited(child)) finish();
  });
}

/** Returns whether a child has already reported an exit status or signal. */
function isChildExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * Signals a process group when requested. A missing group means ownership ended,
 * so it must not fall back to a potentially reused direct PID.
 *
 * @param {number} pid
 * @param {NodeJS.Signals} signal
 * @param {boolean} useProcessGroup
 */
function signalPosixProcess(pid, signal, useProcessGroup) {
  if (useProcessGroup) {
    try {
      process.kill(-pid, signal);
      return;
    } catch (error) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
  }

  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

/**
 * Checks process or process-group liveness immediately before hard kill.
 *
 * @param {number} pid
 * @param {boolean} useProcessGroup
 * @returns {boolean}
 */
function isProcessAlive(pid, useProcessGroup) {
  try {
    process.kill(useProcessGroup ? -pid : pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return true;
  }
}
