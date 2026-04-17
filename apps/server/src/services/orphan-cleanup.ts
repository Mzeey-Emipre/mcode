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

/**
 * Known process names for the mcode server binary.
 * Checked case-insensitively via substring match.
 */
const KNOWN_SERVER_PROCESS_NAMES = ["node", "bun"];

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
    if (typeof lock.pid !== "number" || !Number.isInteger(lock.pid) || lock.pid <= 0 || lock.pid === currentPid) return;

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
    // When the name cannot be determined (e.g., no /proc on macOS), we proceed
    // since the lock-file PID validation already narrows the attack surface.
    const processName = getProcessName(lock.pid);
    if (processName !== null) {
      const lower = processName.toLowerCase();
      const isKnownServer = KNOWN_SERVER_PROCESS_NAMES.some((n) => lower.includes(n));
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
