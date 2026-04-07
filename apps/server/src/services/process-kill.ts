/**
 * Platform-aware process tree termination.
 * On Windows, uses taskkill /T /F to kill the entire tree.
 * On Unix, sends SIGKILL to the process group.
 * Never throws - logs warnings on failure (process may already be dead).
 */

import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { logger } from "@mcode/shared";

const execFile = promisify(execFileCb);

// 5 s gives taskkill enough time to propagate through a deep process tree
// without blocking server shutdown or the cleanup worker's retry loop.
const TASKKILL_TIMEOUT_MS = 5_000;

/**
 * Kill an entire process tree rooted at the given PID.
 * Best-effort: never throws. The process may already be dead.
 */
export async function killProcessTree(pid: number): Promise<void> {
  try {
    if (process.platform === "win32") {
      await execFile("taskkill", ["/T", "/F", "/PID", String(pid)], {
        timeout: TASKKILL_TIMEOUT_MS,
      });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch (err) {
    logger.warn("killProcessTree: process may already be dead", {
      pid,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
