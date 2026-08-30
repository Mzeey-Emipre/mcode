import { existsSync, linkSync, readFileSync, renameSync, unlinkSync } from "fs";
import { readFile } from "fs/promises";
import { randomUUID } from "crypto";
import { basename, dirname, join } from "path";

/** Maximum wait for an existing server health endpoint. */
const EXISTING_SERVER_HEALTH_TIMEOUT_MS = 3_000;

/** Lock file data written by a running server. */
export interface ServerLock {
  port: number;
  authToken: string;
  pid: number;
  startedAt: string;
  version: string;
  ipcPath: string;
}

/** Identity that proves this manager started a server. */
export interface OwnedServerIdentity {
  pid: number;
  startedAt: string;
  authToken: string;
}

/** Return the server lock file path for a Mcode data directory. */
export function lockFilePath(dataDir: string): string {
  return join(dataDir, "server.lock");
}

/** Test whether a value has the complete server lock file shape. */
export function isServerLock(value: unknown): value is ServerLock {
  if (!value || typeof value !== "object") return false;
  const lock = value as Partial<ServerLock>;
  return isValidLockPort(lock.port) && isValidLockIdentity(lock);
}

/** Return whether a port can appear in a server lock. */
function isValidLockPort(port: unknown): port is number {
  return typeof port === "number" && Number.isFinite(port);
}

/** Return whether the non-port fields can identify a server lock. */
function isValidLockIdentity(lock: Partial<ServerLock>): boolean {
  return (
    typeof lock.authToken === "string" &&
    isValidProcessId(lock.pid) &&
    typeof lock.startedAt === "string" &&
    typeof lock.version === "string" &&
    typeof lock.ipcPath === "string"
  );
}

/** Return whether a value is a positive integer process identifier. */
function isValidProcessId(pid: unknown): pid is number {
  return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0;
}

/** Return whether a port belongs to the supplied desktop mode band. */
export function isPortInRange(port: number, min: number, max: number): boolean {
  return port >= min && port < max;
}

/** Read and validate a server lock file, returning null when it is unavailable. */
export function readServerLock(lockPath: string): ServerLock | null {
  try {
    const lock: unknown = JSON.parse(readFileSync(lockPath, "utf-8"));
    return isServerLock(lock) ? lock : null;
  } catch {
    return null;
  }
}

/** Return whether the specified process exists. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNoSuchProcessError(error);
  }
}

/** Return whether a detached POSIX process group exists. */
export function isProcessGroupAlive(pid: number): boolean {
  if (process.platform === "win32") return isProcessAlive(pid);
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return !isNoSuchProcessError(error);
  }
}

/** Return whether an error reports that a process no longer exists. */
export function isNoSuchProcessError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return code === "ESRCH" || message.includes("ESRCH");
}

/** Return whether two complete lock files identify the same server instance. */
export function sameServerLockIdentity(
  left: ServerLock,
  right: ServerLock,
): boolean {
  return (
    left.port === right.port &&
    left.authToken === right.authToken &&
    left.pid === right.pid &&
    left.startedAt === right.startedAt &&
    left.version === right.version &&
    left.ipcPath === right.ipcPath
  );
}

/** Return whether a lock belongs to the server process this manager started. */
export function sameOwnedServerIdentity(
  lock: ServerLock,
  identity: OwnedServerIdentity,
): boolean {
  return (
    lock.pid === identity.pid &&
    lock.startedAt === identity.startedAt &&
    lock.authToken === identity.authToken
  );
}

/** Probe the lock-owned server and return it when it is healthy in this mode band. */
export async function tryExistingServer(
  lockPath: string,
  portMin: number,
  portMax: number,
): Promise<ServerLock | null> {
  const lock = readServerLock(lockPath);
  if (!lock) return null;
  if (!isPortInRange(lock.port, portMin, portMax)) {
    logForeignPort(lock, portMin, portMax);
    return null;
  }
  if (!isProcessAlive(lock.pid)) {
    removeStaleLock(lockPath, lock);
    return null;
  }
  return (await isHealthyServer(lock.port)) ? lock : null;
}

/** Log that a lock belongs to a different desktop mode. */
function logForeignPort(
  lock: ServerLock,
  portMin: number,
  portMax: number,
): void {
  console.log(
    `[server-manager] Ignored existing server on port ${lock.port} (outside ${portMin}-${portMax})`,
  );
}

/** Remove a stale lock after its process exited. */
function removeStaleLock(lockPath: string, lock: ServerLock): void {
  console.log(`[server-manager] Stale lock file: PID ${lock.pid} not alive`);
  removeServerLockIfUnchanged(lockPath, lock);
}

/** Probe a server health endpoint. */
async function isHealthyServer(port: number): Promise<boolean> {
  try {
    const response = await fetchWithTimeout(
      `http://localhost:${port}/health`,
      EXISTING_SERVER_HEALTH_TIMEOUT_MS,
    );
    return response.ok;
  } catch {
    return false;
  }
}

/** Fetch a health endpoint with a timeout even when a fetch implementation ignores abort signals. */
async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error(`Server health check timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      fetch(url, { signal: controller.signal }),
      timeout,
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

/** Remove a lock only after atomically quarantining and revalidating its exact identity. */
export function removeServerLockIfUnchanged(
  lockPath: string,
  expectedLock: ServerLock,
): boolean {
  const quarantinePath = createLockQuarantinePath(lockPath);
  try {
    renameSync(lockPath, quarantinePath);
  } catch {
    return false;
  }
  const quarantinedLock = readServerLock(quarantinePath);
  if (
    !quarantinedLock ||
    !sameServerLockIdentity(expectedLock, quarantinedLock)
  ) {
    restoreQuarantinedLock(quarantinePath, lockPath);
    return false;
  }
  try {
    unlinkSync(quarantinePath);
    return true;
  } catch {
    restoreQuarantinedLock(quarantinePath, lockPath);
    return false;
  }
}

/** Create a same-directory quarantine path for one atomic lock removal attempt. */
function createLockQuarantinePath(lockPath: string): string {
  return join(
    dirname(lockPath),
    `.${basename(lockPath)}.${randomUUID()}.removing`,
  );
}

/** Restore a quarantined replacement when its identity differs from the expected lock. */
function restoreQuarantinedLock(
  quarantinePath: string,
  lockPath: string,
): void {
  try {
    linkSync(quarantinePath, lockPath);
    unlinkSync(quarantinePath);
  } catch {
    // A replacement lock must win over a stale quarantine restoration.
  }
}

/** Read a newly written lock file until its auth token is available. */
export async function readServerLockWithRetry(
  lockPath: string,
  maxAttempts: number,
  intervalMs: number,
): Promise<ServerLock> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const lock = await readServerLockAsync(lockPath);
    if (lock?.authToken) return lock;
    await delay(intervalMs);
  }
  throw new Error("Server lock file not available after health check passed");
}

/** Read and validate a lock file without blocking the main process. */
async function readServerLockAsync(
  lockPath: string,
): Promise<ServerLock | null> {
  try {
    const lock: unknown = JSON.parse(await readFile(lockPath, "utf-8"));
    return isServerLock(lock) ? lock : null;
  } catch {
    return null;
  }
}

/** Wait for a bounded interval. */
export function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

/** Return the port from a valid lock when it belongs to this desktop mode. */
export function readPreferredPort(
  lockPath: string,
  portMin: number,
  portMax: number,
): number | null {
  if (!existsSync(lockPath)) return null;
  const lock = readServerLock(lockPath);
  if (!lock || !isPortInRange(lock.port, portMin, portMax)) return null;
  return lock.port;
}
