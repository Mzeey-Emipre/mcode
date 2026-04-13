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
 * Returns true when the error indicates the process was already gone.
 * These are expected when killProcessTree is called after the PTY shell has
 * already exited (e.g. the cleanup pass after pty.kill()).
 */
function isProcessGoneError(err: unknown): boolean {
  const e = err as NodeJS.ErrnoException & { code?: string | number; stderr?: string };
  // Unix: ESRCH = no such process
  if (e.code === "ESRCH") return true;
  // Windows: taskkill exits with code 128 when the PID is not found
  if (typeof e.code === "number" && e.code === 128) return true;
  if (typeof e.stderr === "string" && /not found/i.test(e.stderr)) return true;
  return false;
}

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
      // Guard against pid <= 0: process.kill(0) would kill the server's own group.
      if (pid > 0) {
        process.kill(-pid, "SIGKILL");
      }
    }
  } catch (err) {
    if (isProcessGoneError(err)) {
      // Expected when the process already exited (e.g. cleanup pass after pty.kill()).
      logger.debug("killProcessTree: process already gone", { pid });
    } else {
      logger.warn("killProcessTree: unexpected error killing process tree", {
        pid,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
