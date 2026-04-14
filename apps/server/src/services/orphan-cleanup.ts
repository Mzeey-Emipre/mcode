/**
 * Orphaned server process cleanup.
 * Reads the lock file on startup to detect a previous server instance that
 * did not shut down gracefully, and kills its process tree before the new
 * server starts. This prevents zombie SDK subprocesses from consuming API
 * credits after an unclean shutdown.
 */

import { existsSync, readFileSync } from "fs";
import { execSync } from "child_process";

/** Subset of the lock file contents we care about for orphan detection. */
interface LockFile {
  pid?: number;
}

/** Minimal logger interface required by killOrphanedServer. */
interface MinLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
}

/** Dependencies injected into killOrphanedServer to make it unit-testable. */
export interface OrphanCleanupDeps {
  /** Absolute path to the server lock file. */
  lockFilePath: string;
  /** Logger instance. */
  logger: MinLogger;
  /**
   * Checks whether a process is alive by sending signal 0.
   * Throws if the process does not exist.
   * Defaults to process.kill.
   */
  processKill?: (pid: number, signal: number | string) => void;
  /**
   * Runs a shell command synchronously.
   * Defaults to execSync from child_process.
   */
  execSync?: (cmd: string, opts?: { stdio?: "ignore" }) => Buffer | string;
  /** Current process PID. Defaults to process.pid. */
  currentPid?: number;
  /** Current platform string. Defaults to process.platform. */
  platform?: NodeJS.Platform;
}

/**
 * Kill any orphaned server process from a previous unclean shutdown.
 * Reads the lock file to find the old PID and sends a kill signal to its
 * process tree. No-ops if there is no lock file, the PID matches the current
 * process, or the process is already dead.
 */
export function killOrphanedServer(deps: OrphanCleanupDeps): void {
  const {
    lockFilePath,
    logger,
    processKill = (pid, signal) => process.kill(pid, signal as never),
    execSync: execSyncFn = (cmd, opts) => execSync(cmd, opts),
    currentPid = process.pid,
    platform = process.platform,
  } = deps;

  try {
    if (!existsSync(lockFilePath)) return;

    const raw = readFileSync(lockFilePath, "utf-8");
    const lock = JSON.parse(raw) as LockFile;
    if (typeof lock.pid !== "number" || !Number.isInteger(lock.pid) || lock.pid <= 0 || lock.pid === currentPid) return;

    // Check if the old process is still alive by sending signal 0.
    try {
      processKill(lock.pid, 0);
    } catch {
      // Process is already dead; nothing to clean up.
      return;
    }

    logger.warn("Found orphaned server process, killing", { pid: lock.pid });

    if (platform === "win32") {
      // /T kills the process tree, /F forces termination.
      try {
        execSyncFn(`taskkill /T /F /PID ${lock.pid}`, { stdio: "ignore" });
      } catch {
        // Process may have exited between the liveness check and the kill.
      }
    } else {
      try {
        // Kill the process group to catch child SDK subprocesses.
        processKill(-lock.pid, "SIGTERM");
      } catch {
        // Fallback: kill just the named process if process-group kill fails
        // (e.g. the old server was not a process group leader).
        try {
          processKill(lock.pid, "SIGTERM");
        } catch {
          // Already dead.
        }
      }
    }
  } catch (err) {
    logger.warn("Failed to clean up orphaned server", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
