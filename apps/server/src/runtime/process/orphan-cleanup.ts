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

type StalePtyEntry = ReturnType<PtyPidRegistry["loadStale"]>[number];

interface ReapContext {
  processKill: (pid: number, signal: number | string) => void;
  execSync: NonNullable<ReapOrphanedPtysDeps["execSync"]>;
  getProcessName: NonNullable<ReapOrphanedPtysDeps["getProcessName"]>;
  platform: NodeJS.Platform;
}

/** Creates the process dependencies used while reaping stale PTYs. */
function createReapContext(deps: ReapOrphanedPtysDeps): ReapContext {
  return {
    processKill: deps.processKill ?? ((pid, signal) => process.kill(pid, signal as never)),
    execSync: deps.execSync ?? ((cmd, opts) => execSync(cmd, opts)),
    getProcessName: deps.getProcessName ?? defaultGetProcessName,
    platform: deps.platform ?? process.platform,
  };
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
  const context = createReapContext(deps);

  const stale = registry.loadStale();
  if (stale.length === 0) return;

  for (const entry of stale) reapOrphanedPty(entry, logger, context);
}

/** Reaps one verified PTY left by a crashed server. */
function reapOrphanedPty(entry: StalePtyEntry, logger: MinLogger, context: ReapContext): void {
  if (!isProcessAlive(entry.pid, context.processKill)) return;
  if (!hasSafePtyPid(entry, logger)) return;
  if (!matchesRecordedPtyImage(entry, logger, context.getProcessName)) return;

  logger.debug("Reaping orphaned PTY process from previous crash", {
    ptyId: entry.ptyId,
    pid: entry.pid,
    imageName: entry.imageName,
  });
  if (!killOrphanedPty(entry, logger, context)) return;

  logger.warn("Reaped orphaned PTY process from previous crash", {
    ptyId: entry.ptyId,
    pid: entry.pid,
    imageName: entry.imageName,
  });
}

/** Checks whether a PID still accepts signal zero. */
function isProcessAlive(pid: number, processKill: ReapContext["processKill"]): boolean {
  try {
    processKill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Rejects PID values that could turn a group kill into a broad signal. */
function hasSafePtyPid(entry: StalePtyEntry, logger: MinLogger): boolean {
  if (entry.pid > 1) return true;
  logger.warn("Skipping orphaned PTY with unsafe PID", { ptyId: entry.ptyId, pid: entry.pid });
  return false;
}

/** Confirms that the live process still has the shell image stored in the registry. */
function matchesRecordedPtyImage(
  entry: StalePtyEntry,
  logger: MinLogger,
  getProcessName: ReapContext["getProcessName"],
): boolean {
  const currentName = getProcessName(entry.pid);
  if (currentName === null) {
    logger.warn("Cannot verify orphaned PTY process identity; skipping kill", { ptyId: entry.ptyId, pid: entry.pid });
    return false;
  }
  if (processBasename(currentName) === processBasename(entry.imageName)) return true;

  logger.warn("Orphaned PTY PID belongs to a different process; skipping kill", {
    ptyId: entry.ptyId,
    pid: entry.pid,
    recordedName: entry.imageName,
    currentName,
  });
  return false;
}

/** Returns a normalized process image basename. */
function processBasename(imageName: string): string {
  return imageName.toLowerCase().split(/[\\/]/).pop() ?? "";
}

/** Kills an orphaned PTY with platform-specific tree containment. */
function killOrphanedPty(entry: StalePtyEntry, logger: MinLogger, context: ReapContext): boolean {
  return context.platform === "win32"
    ? killWindowsOrphanedPty(entry, logger, context.execSync)
    : killUnixOrphanedPty(entry, logger, context.processKill);
}

/** Kills a Windows PTY tree and treats a disappeared process as success. */
function killWindowsOrphanedPty(
  entry: StalePtyEntry,
  logger: MinLogger,
  execSyncFn: ReapContext["execSync"],
): boolean {
  try {
    execSyncFn(`taskkill /T /F /PID ${entry.pid}`, { stdio: "ignore", timeout: 5000 });
    return true;
  } catch (error) {
    if (isWindowsProcessGone(error)) return true;
    logger.warn("Failed to kill orphaned PTY process tree", {
      ptyId: entry.ptyId,
      pid: entry.pid,
      error: errorMessage(error),
    });
    return false;
  }
}

/** Checks for taskkill's already-gone responses. */
function isWindowsProcessGone(error: unknown): boolean {
  const value = error as NodeJS.ErrnoException & { code?: string | number; stderr?: string };
  return (typeof value.code === "number" && value.code === 128) || (typeof value.stderr === "string" && /not found/i.test(value.stderr));
}

/** Kills a Unix PTY group, then the process when it lacks a process group. */
function killUnixOrphanedPty(
  entry: StalePtyEntry,
  logger: MinLogger,
  processKill: ReapContext["processKill"],
): boolean {
  try {
    processKill(-entry.pid, "SIGKILL");
    return true;
  } catch (groupError) {
    if (isMissingProcess(groupError)) return true;
  }
  return killUnixPtyDirectly(entry, logger, processKill);
}

/** Kills the PTY process when its process group could not be signalled. */
function killUnixPtyDirectly(
  entry: StalePtyEntry,
  logger: MinLogger,
  processKill: ReapContext["processKill"],
): boolean {
  try {
    processKill(entry.pid, "SIGKILL");
    return true;
  } catch (error) {
    if (isMissingProcess(error)) return true;
    logger.warn("Failed to kill orphaned PTY process", {
      ptyId: entry.ptyId,
      pid: entry.pid,
      error: errorMessage(error),
    });
    return false;
  }
}

/** Checks for a missing POSIX process. */
function isMissingProcess(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ESRCH";
}

/** Formats an unknown thrown value for structured logging. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Kill any orphaned server process from a previous unclean shutdown.
 * Reads the lock file to find the old PID, verifies the image name matches
 * a known server binary to guard against PID reuse, then kills the process
 * tree. No-ops if there is no lock file, the PID matches the current process,
 * or the process is already dead.
 */
export function killOrphanedServer(deps: OrphanCleanupDeps): void {
  const context = createServerCleanupContext(deps);

  try {
    const pid = readOrphanedServerPid(deps.lockFilePath, context.currentPid);
    if (pid === null || !isProcessAlive(pid, context.processKill)) return;

    const identity = getServerProcessIdentity(pid, context.getProcessName);
    if (identity.kind === "unrecognized") {
      deps.logger.warn("Orphaned lock PID does not belong to a known server process; skipping kill", {
        pid,
        name: identity.name,
      });
      return;
    }

    deps.logger.warn("Found orphaned server process, killing", { pid });
    killOrphanedServerProcess(pid, identity, deps.logger, context);
  } catch (error) {
    deps.logger.warn("Failed to clean up orphaned server", {
      error: errorMessage(error),
    });
  }
}

interface ServerCleanupContext {
  processKill: (pid: number, signal: number | string) => void;
  execSync: NonNullable<OrphanCleanupDeps["execSync"]>;
  getProcessName: NonNullable<OrphanCleanupDeps["getProcessName"]>;
  currentPid: number;
  platform: NodeJS.Platform;
}

type ServerProcessIdentity = { kind: "verified" } | { kind: "unknown" } | { kind: "unrecognized"; name: string };

/** Creates the process dependencies used while clearing an orphaned server. */
function createServerCleanupContext(deps: OrphanCleanupDeps): ServerCleanupContext {
  return {
    processKill: deps.processKill ?? ((pid, signal) => process.kill(pid, signal as never)),
    execSync: deps.execSync ?? ((cmd, opts) => execSync(cmd, opts)),
    getProcessName: deps.getProcessName ?? defaultGetProcessName,
    currentPid: deps.currentPid ?? process.pid,
    platform: deps.platform ?? process.platform,
  };
}

/** Reads and validates the previous server PID from the lock file. */
function readOrphanedServerPid(lockFilePath: string, currentPid: number): number | null {
  if (!existsSync(lockFilePath)) return null;
  const lock = JSON.parse(readFileSync(lockFilePath, "utf-8")) as LockFile;
  if (typeof lock.pid !== "number" || !Number.isInteger(lock.pid) || lock.pid <= 1 || lock.pid === currentPid) return null;
  return lock.pid;
}

/** Classifies the live process before a destructive signal is sent. */
function getServerProcessIdentity(
  pid: number,
  getProcessName: ServerCleanupContext["getProcessName"],
): ServerProcessIdentity {
  const name = getProcessName(pid);
  if (name === null) return { kind: "unknown" };
  return KNOWN_SERVER_BASENAMES.has(processBasename(name)) ? { kind: "verified" } : { kind: "unrecognized", name };
}

/** Kills the previous server with the broadest safe containment for its identity. */
function killOrphanedServerProcess(
  pid: number,
  identity: ServerProcessIdentity,
  logger: MinLogger,
  context: ServerCleanupContext,
): void {
  if (context.platform === "win32") {
    killWindowsServerTree(pid, context.execSync);
    return;
  }
  if (identity.kind === "verified") {
    killVerifiedUnixServer(pid, context.processKill);
    return;
  }
  logger.warn("Could not verify process identity; killing single process only", { pid });
  killProcessSilently(pid, context.processKill);
}

/** Kills a Windows server process tree after its identity check. */
function killWindowsServerTree(pid: number, execSyncFn: ServerCleanupContext["execSync"]): void {
  try {
    execSyncFn(`taskkill /T /F /PID ${pid}`, { stdio: "ignore", timeout: 5000 });
  } catch {
    // The process can exit after its liveness check.
  }
}

/** Kills a verified Unix server group, then the root process as a fallback. */
function killVerifiedUnixServer(pid: number, processKill: ServerCleanupContext["processKill"]): void {
  try {
    processKill(-pid, "SIGTERM");
  } catch {
    killProcessSilently(pid, processKill);
  }
}

/** Sends SIGTERM to one process and ignores an already-exited process. */
function killProcessSilently(pid: number, processKill: ServerCleanupContext["processKill"]): void {
  try {
    processKill(pid, "SIGTERM");
  } catch {
    // The process can exit after its liveness check.
  }
}
