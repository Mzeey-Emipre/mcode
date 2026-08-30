import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { createServer, type AddressInfo } from "net";
import { randomUUID } from "crypto";
import { join } from "path";
import { delay, isProcessAlive, type ServerLock } from "./lock.js";

/** Time to wait for another Electron instance to finish starting the server. */
const STARTUP_LOCK_TIMEOUT_MS = 10_000;

/** Interval between lock-owned server probes while another instance starts it. */
const STARTUP_LOCK_POLL_INTERVAL_MS = 200;

/** Unique ownership data for a server startup sentinel. */
export interface StartupLockOwner {
  pid: number;
  token: string;
}

/** Result of acquiring the inter-process server startup lock. */
export type StartupLockResult =
  | { kind: "acquired"; owner: StartupLockOwner }
  | { kind: "existing"; lock: ServerLock };

/** Dependencies for server startup-lock acquisition. */
export interface StartupLockDependencies {
  readonly createLock: () => StartupLockOwner | null;
  readonly releaseLock: (owner: StartupLockOwner) => void;
  readonly readLockOwner: () => StartupLockOwner | null;
  readonly isOwnerAlive: (pid: number) => boolean;
  readonly findExistingServer: () => Promise<ServerLock | null>;
  readonly wait: (timeoutMs: number) => Promise<void>;
  readonly now: () => number;
}

/** Create filesystem-backed startup-lock dependencies. */
export function createStartupLockDependencies(
  sentinelPath: string,
  findExistingServer: () => Promise<ServerLock | null>,
): StartupLockDependencies {
  return {
    createLock: () => tryCreateStartupLock(sentinelPath),
    releaseLock: (owner) => releaseStartupLock(sentinelPath, owner),
    readLockOwner: () => readStartupLockOwner(sentinelPath),
    isOwnerAlive: isProcessAlive,
    findExistingServer,
    wait: delay,
    now: Date.now,
  };
}

/** Wait for a lock-owned server, then reclaim an abandoned startup lock. */
export async function acquireStartupLock(
  dependencies: StartupLockDependencies,
  timeoutMs = STARTUP_LOCK_TIMEOUT_MS,
): Promise<StartupLockResult> {
  const owner = dependencies.createLock();
  if (owner) return { kind: "acquired", owner };
  console.log(
    "[server-manager] Startup lock held by another process, waiting for server",
  );
  return waitForStartupLock(dependencies, timeoutMs);
}

/** Poll an existing startup owner and reclaim only a confirmed abandoned lock. */
async function waitForStartupLock(
  dependencies: StartupLockDependencies,
  timeoutMs: number,
): Promise<StartupLockResult> {
  const existing = await waitForExistingServer(dependencies, timeoutMs);
  if (existing) return { kind: "existing", lock: existing };
  reclaimAbandonedStartupLock(dependencies);
  return acquireStartupLock(dependencies, timeoutMs);
}

/** Reclaim a startup lock only when its recorded owner process no longer exists. */
function reclaimAbandonedStartupLock(
  dependencies: StartupLockDependencies,
): void {
  const owner = dependencies.readLockOwner();
  if (!owner) {
    throw new Error("Server startup lock owner is unavailable after timeout");
  }
  if (dependencies.isOwnerAlive(owner.pid)) {
    throw new Error(`Server startup lock owner ${owner.pid} is still running`);
  }
  dependencies.releaseLock(owner);
}

/** Poll for a healthy server until a startup owner finishes or times out. */
async function waitForExistingServer(
  dependencies: StartupLockDependencies,
  timeoutMs: number,
): Promise<ServerLock | null> {
  const deadline = dependencies.now() + timeoutMs;
  while (dependencies.now() < deadline) {
    await dependencies.wait(STARTUP_LOCK_POLL_INTERVAL_MS);
    const existing = await dependencies.findExistingServer();
    if (existing) return existing;
  }
  return null;
}

/** Remove only the startup sentinel file owned by the supplied token. */
export function releaseStartupLock(
  sentinelPath: string,
  owner: StartupLockOwner,
): void {
  try {
    unlinkSync(startupOwnerPath(sentinelPath, owner));
  } catch {
    return;
  }
  try {
    rmdirSync(sentinelPath);
  } catch {
    // A replacement owner creates its own token file before this owner releases.
  }
}

/** Try to create an owner-scoped startup sentinel without replacing another owner. */
function tryCreateStartupLock(sentinelPath: string): StartupLockOwner | null {
  const owner = { pid: process.pid, token: randomUUID() };
  try {
    mkdirSync(sentinelPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  }
  try {
    writeFileSync(
      startupOwnerPath(sentinelPath, owner),
      JSON.stringify(owner),
      {
        flag: "wx",
      },
    );
    return owner;
  } catch (error) {
    removeEmptyStartupDirectory(sentinelPath);
    throw error;
  }
}

/** Read the unique owner recorded in a startup sentinel directory. */
function readStartupLockOwner(sentinelPath: string): StartupLockOwner | null {
  try {
    const [ownerFile] = readdirSync(sentinelPath);
    if (!ownerFile) return null;
    const owner: unknown = JSON.parse(
      readFileSync(join(sentinelPath, ownerFile), "utf-8"),
    );
    return isStartupLockOwner(owner) ? owner : null;
  } catch {
    return null;
  }
}

/** Return whether a value has the expected startup sentinel ownership shape. */
function isStartupLockOwner(value: unknown): value is StartupLockOwner {
  if (!value || typeof value !== "object") return false;
  const owner = value as Partial<StartupLockOwner>;
  return (
    typeof owner.pid === "number" &&
    Number.isSafeInteger(owner.pid) &&
    owner.pid > 0 &&
    typeof owner.token === "string" &&
    owner.token.length > 0
  );
}

/** Return the owner-scoped file path inside a startup sentinel directory. */
function startupOwnerPath(
  sentinelPath: string,
  owner: StartupLockOwner,
): string {
  return join(sentinelPath, `${owner.token}.json`);
}

/** Remove a newly created empty sentinel directory after an owner-file write failure. */
function removeEmptyStartupDirectory(sentinelPath: string): void {
  try {
    rmdirSync(sentinelPath);
  } catch {
    // Another process cannot own this directory until this creator removes it.
  }
}

/** Find an available TCP port in a half-open range. */
export async function findAvailablePort(
  min: number,
  max: number,
): Promise<number> {
  for (let port = min; port < max; port += 1) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(`No available port found in range ${min}-${max}`);
}

/** Ask the operating system whether a port is available for the server. */
async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      server.close(() => resolve(address.port === port));
    });
  });
}
