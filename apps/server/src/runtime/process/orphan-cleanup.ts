/**
 * Orphaned server process cleanup.
 * Reads the lock file on startup to detect a previous server instance that
 * did not shut down gracefully, and kills its process tree before the new
 * server starts. This prevents zombie SDK subprocesses from consuming API
 * credits after an unclean shutdown.
 */

import { existsSync, readFileSync } from "fs";
import { execSync } from "child_process";
import type { PtyPidRegistry } from "../../features/terminal/host/pty-pid-registry.js";

/** Subset of the lock file contents we care about for orphan detection. */
interface LockFile {
  pid?: number;
}

/** Minimal logger interface required by killOrphanedServer. */
interface MinLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Exact basenames (case-insensitive) that identify a server binary.
 * Using exact match avoids false positives on names like "nodemon" or
 * "code-node-helper" that would pass a substring check.
 */
const KNOWN_SERVER_BASENAMES = new Set(["node", "node.exe", "bun", "bun.exe"]);

/**
 * Reads the process image name for a PID using platform-specific tools.
 * Returns null if the name cannot be determined (e.g., /proc unavailable).
 * Used as the default for `OrphanCleanupDeps.getProcessName`.
 */
function defaultGetProcessName(pid: number): string | null {
  try {
    if (process.platform === "win32") {
      // tasklist /FO CSV outputs: "node.exe","1234","Console","1","5,192 K"
      const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, {
        timeout: 3000,
        encoding: "utf-8",
      } as Parameters<typeof execSync>[1]);
      const match = /^"([^"]+)"/.exec(String(out).trim());
      return match ? match[1] : null;
    } else {
      // /proc/pid/comm is the fastest path on Linux.
      return readFileSync(`/proc/${pid}/comm`, "utf-8").trim();
    }
  } catch {
    return null;
  }
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
  execSync?: (cmd: string, opts?: { stdio?: "ignore"; timeout?: number }) => Buffer | string;
  /**
   * Returns the process image name for the given PID, or null if the name
   * cannot be determined. Used to verify the PID belongs to a server process
   * before killing, guarding against PID reuse (TOCTOU).
   * Defaults to a platform-specific implementation using tasklist / /proc.
   */
  getProcessName?: (pid: number) => string | null;
  /** Current process PID. Defaults to process.pid. */
  currentPid?: number;
  /** Current platform string. Defaults to process.platform. */
  platform?: NodeJS.Platform;
}

/** Injectable dependencies for {@link reapOrphanedPtys}. */
export interface ReapOrphanedPtysDeps {
  processKill?: (pid: number, signal: number | string) => void;
  execSync?: (cmd: string, opts?: { stdio?: "ignore"; timeout?: number }) => Buffer | string;
  getProcessName?: (pid: number) => string | null;
  /** Current platform string. Defaults to process.platform. */
  platform?: NodeJS.Platform;
}

/**
 * Reap any PTY processes left alive from a previous server crash.
 *
 * Reads the PID registry file written by the previous server run, then for
 * each entry checks whether the process is still alive and whether the image
 * name still matches the recorded shell binary (PID reuse guard). Matching
 * processes are killed immediately — these are orphaned shells, not a graceful
 * shutdown scenario.
 */
export function reapOrphanedPtys(
  registry: PtyPidRegistry,
  logger: MinLogger,
  deps: ReapOrphanedPtysDeps = {},
): void {
  const {
    processKill = (pid, signal) => process.kill(pid, signal as never),
    execSync: execSyncFn = (cmd, opts) => execSync(cmd, opts),
    getProcessName = defaultGetProcessName,
    platform = process.platform,
  } = deps;

  const stale = registry.loadStale();
  if (stale.length === 0) return;

  for (const entry of stale) {
    try {
      processKill(entry.pid, 0);
    } catch {
      continue; // Already dead
    }

    // Guard against the catastrophic kill(-1, SIGKILL) path: on Unix,
    // -entry.pid with pid=1 would signal every process the user can reach.
    if (entry.pid <= 1) {
      logger.warn("Skipping orphaned PTY with unsafe PID", { ptyId: entry.ptyId, pid: entry.pid });
      continue;
    }

    const currentName = getProcessName(entry.pid);
    if (currentName === null) {
      // Cannot verify identity (e.g. no /proc on this platform). Skip to avoid
      // killing an unrelated process that reused the PID.
      logger.warn("Cannot verify orphaned PTY process identity; skipping kill", {
        ptyId: entry.ptyId,
        pid: entry.pid,
      });
      continue;
    }
    const basename = currentName.toLowerCase().split(/[\\/]/).pop() ?? "";
    const recorded = entry.imageName.toLowerCase().split(/[\\/]/).pop() ?? "";
    if (basename !== recorded) {
      logger.warn("Orphaned PTY PID belongs to a different process; skipping kill", {
        ptyId: entry.ptyId,
        pid: entry.pid,
        recordedName: entry.imageName,
        currentName,
      });
      continue;
    }

    logger.debug("Reaping orphaned PTY process from previous crash", {
      ptyId: entry.ptyId,
      pid: entry.pid,
      imageName: entry.imageName,
    });

    let killSucceeded = false;
    if (platform === "win32") {
      try {
        execSyncFn(`taskkill /T /F /PID ${entry.pid}`, { stdio: "ignore", timeout: 5000 });
        killSucceeded = true;
      } catch (killErr) {
        const e = killErr as NodeJS.ErrnoException & { code?: string | number; stderr?: string };
        const alreadyGone =
          (typeof e.code === "number" && e.code === 128) ||
          (typeof e.stderr === "string" && /not found/i.test(e.stderr));
        if (alreadyGone) {
          killSucceeded = true;
        } else {
          logger.warn("Failed to kill orphaned PTY process tree", {
            ptyId: entry.ptyId,
            pid: entry.pid,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    } else {
      try {
        processKill(-entry.pid, "SIGKILL");
        killSucceeded = true;
      } catch (groupErr) {
        if ((groupErr as NodeJS.ErrnoException)?.code === "ESRCH") {
          killSucceeded = true;
        } else {
          // Group kill failed (e.g. EPERM) — fall through to direct kill.
          try {
            processKill(entry.pid, "SIGKILL");
            killSucceeded = true;
          } catch (directErr) {
            if ((directErr as NodeJS.ErrnoException)?.code === "ESRCH") {
              killSucceeded = true;
            } else {
              logger.warn("Failed to kill orphaned PTY process", {
                ptyId: entry.ptyId,
                pid: entry.pid,
                error: directErr instanceof Error ? directErr.message : String(directErr),
              });
            }
          }
        }
      }
    }

    if (killSucceeded) {
      logger.warn("Reaped orphaned PTY process from previous crash", {
        ptyId: entry.ptyId,
        pid: entry.pid,
        imageName: entry.imageName,
      });
    }
  }
}

/**
 * Kill any orphaned server process from a previous unclean shutdown.
 * Reads the lock file to find the old PID, verifies the image name matches
 * a known server binary to guard against PID reuse, then kills the process
 * tree. No-ops if there is no lock file, the PID matches the current process,
 * or the process is already dead.
 */
export function killOrphanedServer(deps: OrphanCleanupDeps): void {
  const {
    lockFilePath,
    logger,
    processKill = (pid, signal) => process.kill(pid, signal as never),
    execSync: execSyncFn = (cmd, opts) => execSync(cmd, opts),
    getProcessName = defaultGetProcessName,
    currentPid = process.pid,
    platform = process.platform,
  } = deps;

  try {
    if (!existsSync(lockFilePath)) return;

    const raw = readFileSync(lockFilePath, "utf-8");
    const lock = JSON.parse(raw) as LockFile;
    // Reject PID 1 explicitly: kill(-1, SIGTERM) signals every process owned
    // by the calling user, which is catastrophic.
    if (typeof lock.pid !== "number" || !Number.isInteger(lock.pid) || lock.pid <= 1 || lock.pid === currentPid) return;

    // Check if the old process is still alive by sending signal 0.
    try {
      processKill(lock.pid, 0);
    } catch {
      // Process is already dead; nothing to clean up.
      return;
    }

    // Verify the process image name matches a known server binary before
    // killing. This guards against PID reuse: if the OS recycled the PID to an
    // unrelated process between the liveness check and the kill, we skip.
    const processName = getProcessName(lock.pid);
    const identityVerified = processName !== null;
    if (identityVerified) {
      const basename = processName.toLowerCase().split(/[\\/]/).pop() ?? "";
      const isKnownServer = KNOWN_SERVER_BASENAMES.has(basename);
      if (!isKnownServer) {
        logger.warn("Orphaned lock PID does not belong to a known server process; skipping kill", {
          pid: lock.pid,
          name: processName,
        });
        return;
      }
    }

    logger.warn("Found orphaned server process, killing", { pid: lock.pid });

    if (platform === "win32") {
      // /T kills the process tree, /F forces termination. Timeout prevents
      // blocking server startup if taskkill hangs on a deep process tree.
      try {
        execSyncFn(`taskkill /T /F /PID ${lock.pid}`, { stdio: "ignore", timeout: 5000 });
      } catch {
        // Process may have exited between the liveness check and the kill.
      }
    } else if (identityVerified) {
      // Identity confirmed: safe to kill the process group to catch SDK children.
      try {
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
    } else {
      // Identity unknown (e.g. no /proc on macOS): only kill the specific
      // process, never the group, to avoid collateral damage on recycled PIDs.
      logger.warn("Could not verify process identity; killing single process only", { pid: lock.pid });
      try {
        processKill(lock.pid, "SIGTERM");
      } catch {
        // Already dead.
      }
    }
  } catch (err) {
    logger.warn("Failed to clean up orphaned server", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
