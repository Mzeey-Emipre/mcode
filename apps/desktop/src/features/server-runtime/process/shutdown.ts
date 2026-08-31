import { execFileSync, type ChildProcess } from "child_process";
import { existsSync, readFileSync } from "fs";
import {
  isPortInRange,
  isProcessAlive,
  isProcessGroupAlive,
  isServerLock,
  isNoSuchProcessError,
  removeServerLockIfUnchanged,
  sameOwnedServerIdentity,
  delay,
  type OwnedServerIdentity,
  type ServerLock,
} from "./lock.js";

/** Inputs for stopping the server described by the current lock file. */
export interface StopServerOptions {
  lockPath: string;
  portMin: number;
  portMax: number;
  ownedIdentity: OwnedServerIdentity | null;
  ownedProcess: NodeChildProcess.ChildProcess | null;
  /** Platform selected by the Electron composition root. */
  platform: NodeJS.Platform;
}

/** Outcome details that let the manager update its owned-server state. */
export interface StopServerResult {
  clearOwnedIdentity: boolean;
}

/** Gracefully stop the in-band lock holder and force-kill only an owned process. */
export async function stopServerHeldByLock(
  options: StopServerOptions,
): Promise<StopServerResult> {
  const lockResult = readLockForShutdown(options);
  if (lockResult.kind !== "lock") return lockResult;
  if (doesNotOwnExpectedLock(lockResult.lock, options.ownedIdentity)) {
    return { clearOwnedIdentity: true };
  }
  await requestGracefulShutdown(lockResult.lock);
  const processAlive = await waitForProcessTreeExit(
    lockResult.lock.pid,
    options.platform,
  );
  const forceResult = await forceStopOwnedProcessIfNeeded(
    lockResult.lock,
    processAlive,
    options,
  );
  if (forceResult.lostOwnership) return { clearOwnedIdentity: true };
  return removeUnchangedLock(lockResult.lock, options.lockPath);
}

/** Lock parsing result for an updater shutdown request. */
type ShutdownLockResult =
  | { kind: "lock"; lock: ServerLock }
  | { kind: "foreign"; clearOwnedIdentity: false }
  | { kind: "missing"; clearOwnedIdentity: true };

/** Read a valid in-band lock before any health probe or process action. */
function readLockForShutdown(options: StopServerOptions): ShutdownLockResult {
  if (!existsSync(options.lockPath)) {
    return { kind: "missing", clearOwnedIdentity: true };
  }
  const parsedLock = readRawLockForShutdown(options.lockPath);
  if (parsedLock === null) return { kind: "missing", clearOwnedIdentity: true };
  if (isForeignPortLock(parsedLock, options.portMin, options.portMax)) {
    return { kind: "foreign", clearOwnedIdentity: false };
  }
  if (!isServerLock(parsedLock)) {
    throw new Error(`Invalid server lock file ${options.lockPath}`);
  }
  return { kind: "lock", lock: parsedLock };
}

/** Read a raw lock file and preserve meaningful filesystem errors. */
function readRawLockForShutdown(lockPath: string): unknown {
  try {
    return JSON.parse(readFileSync(lockPath, "utf-8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return null;
    }
    throw new Error(`Unable to read server lock file ${lockPath}`, {
      cause: error,
    });
  }
}

/** Return whether a malformed lock still names a different desktop-mode port. */
function isForeignPortLock(
  value: unknown,
  portMin: number,
  portMax: number,
): boolean {
  if (!value || typeof value !== "object") return false;
  const port = (value as { port?: unknown }).port;
  return (
    typeof port === "number" &&
    Number.isFinite(port) &&
    !isPortInRange(port, portMin, portMax)
  );
}

/** Return whether a lock changed after this manager started its server. */
function doesNotOwnExpectedLock(
  lock: ServerLock,
  ownedIdentity: OwnedServerIdentity | null,
): boolean {
  return (
    ownedIdentity !== null && !sameOwnedServerIdentity(lock, ownedIdentity)
  );
}

/** Request authenticated graceful server shutdown before process-tree fallback. */
async function requestGracefulShutdown(lock: ServerLock): Promise<void> {
  try {
    await fetch(`http://localhost:${lock.port}/shutdown`, {
      method: "POST",
      signal: AbortSignal.timeout(5_000),
      headers: {
        Authorization: `Bearer ${lock.authToken}`,
        "X-Mcode-Shutdown-Reason": "desktop-update-exit",
      },
    });
  } catch {
    // A hung or already-exited server reaches the process-tree fallback.
  }
}

/** Wait up to ten seconds for a process leader and its POSIX group to exit. */
async function waitForProcessTreeExit(
  pid: number,
  platform: NodeJS.Platform,
): Promise<boolean> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid) && !isProcessGroupAlive(pid, platform)) return false;
    await delay(200);
  }
  return isProcessAlive(pid) || isProcessGroupAlive(pid, platform);
}

/** Result of an owned-process force-stop operation. */
interface ForceStopResult {
  lostOwnership: boolean;
}

/** Force-kill a remaining process only when this manager owns its lock identity. */
async function forceStopOwnedProcessIfNeeded(
  lock: ServerLock,
  processAlive: boolean,
  options: StopServerOptions,
): Promise<ForceStopResult> {
  if (!processAlive) return { lostOwnership: false };
  if (!options.ownedIdentity) throwUnownedProcessError(lock.pid);
  if (!isLiveOwnedProcess(options.ownedProcess, lock.pid)) {
    throwUnownedProcessError(lock.pid);
  }
  if (!hasCurrentOwnedLock(lock, options)) return { lostOwnership: true };
  forceKillServerProcessTree(lock.pid, options.platform);
  await confirmPosixProcessGroupExit(lock.pid, options.platform);
  return { lostOwnership: false };
}

/** Return whether the original owned child still proves the PID is safe to stop. */
function isLiveOwnedProcess(
  child: NodeChildProcess.ChildProcess | null,
  pid: number,
): boolean {
  return (
    child !== null &&
    child.pid === pid &&
    child.exitCode === null &&
    child.signalCode === null
  );
}

/** Throw when graceful shutdown leaves a process that this manager does not own. */
function throwUnownedProcessError(pid: number): never {
  throw new Error(
    `Server process ${pid} still running after graceful shutdown; refusing to terminate unrelated process`,
  );
}

/** Confirm that the lock still identifies the owned process before force-killing it. */
function hasCurrentOwnedLock(
  lock: ServerLock,
  options: StopServerOptions,
): boolean {
  const currentLock = readCurrentLock(options.lockPath);
  return (
    currentLock !== null &&
    options.ownedIdentity !== null &&
    sameOwnedServerIdentity(currentLock, options.ownedIdentity) &&
    sameOwnedServerIdentity(currentLock, {
      pid: lock.pid,
      startedAt: lock.startedAt,
      authToken: lock.authToken,
    })
  );
}

/** Read a currently valid lock without acting on a replacement or deleted lock. */
function readCurrentLock(lockPath: string): ServerLock | null {
  try {
    const lock: unknown = JSON.parse(readFileSync(lockPath, "utf-8"));
    return isServerLock(lock) ? lock : null;
  } catch {
    return null;
  }
}

/** Kill the server leader and all provider subprocesses that it owns. */
function forceKillServerProcessTree(pid: number, platform: NodeJS.Platform): void {
  try {
    if (platform === "win32") {
      NodeChildProcess.execFileSync("taskkill", ["/T", "/F", "/PID", String(pid)], {
        stdio: "ignore",
        timeout: 5_000,
      });
      return;
    }
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (isNoSuchProcessError(error)) return;
    throw new Error(`Failed to terminate server process tree ${pid}`, {
      cause: error,
    });
  }
}

/** Recheck that a forced POSIX process group no longer exists. */
async function confirmPosixProcessGroupExit(
  pid: number,
  platform: NodeJS.Platform,
): Promise<void> {
  if (platform === "win32") return;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && isProcessGroupAlive(pid, platform)) {
    await delay(200);
  }
  if (isProcessGroupAlive(pid, platform)) {
    throw new Error(
      `Server process tree ${pid} still running after termination`,
    );
  }
}

/** Unlink the lock only when the exact stopped server still owns it. */
function removeUnchangedLock(
  lock: ServerLock,
  lockPath: string,
): StopServerResult {
  removeServerLockIfUnchanged(lockPath, lock);
  return { clearOwnedIdentity: true };
}
