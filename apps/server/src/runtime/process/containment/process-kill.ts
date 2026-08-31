/**
 * Platform-aware process tree termination.
 * On Windows, uses taskkill /T /F to kill the entire tree.
 * On Unix, sends SIGKILL to the process group.
 * Expected already-gone errors are harmless. Other failures reject so callers
 * cannot report a successful close while descendants may still be running.
 */

import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { logger } from "@mcode/shared";

const execFile = promisify(execFileCb);

// 5 s gives taskkill enough time to propagate through a deep process tree
// without blocking server shutdown or the cleanup worker's retry loop.
const TASKKILL_TIMEOUT_MS = 5_000;
const PROCESS_TREE_LIMIT = 128;
const PROCESS_ENUMERATION_MAX_BUFFER = 256 * 1024;
const TERMINATION_VERIFY_TIMEOUT_MS = 2_000;
const TERMINATION_VERIFY_POLL_MS = 50;
const POWERSHELL_CHILD_PROCESS_SCRIPT =
  "& { param([int]$ParentPid) $ErrorActionPreference = 'Stop'; " +
  "Get-CimInstance Win32_Process -Filter ('ParentProcessId = ' + $ParentPid) | " +
  "Select-Object Name,ProcessId | ConvertTo-Json -Compress }";
const POWERSHELL_PROCESS_SNAPSHOT_SCRIPT =
  "$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process | " +
  "Select-Object Name,ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress";

/** Validated process record returned by a bounded Windows CIM snapshot. */
export interface WindowsProcessSnapshotEntry {
  readonly pid: number;
  readonly parentPid: number;
  readonly startMarker: string;
  readonly name: string;
}

interface ProcessIdentity {
  readonly pid: number;
  readonly parentPid: number | null;
  readonly startMarker: string;
  readonly depth: number;
}

/** Injectable process-tree termination dependencies for focused verification tests. */
export interface KillProcessTreeDeps {
  readonly execFile?: typeof execFile;
  readonly platform: NodeJS.Platform;
  readonly processKill?: (pid: number, signal: string | number) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly getProcessStartMarker?: (pid: number) => Promise<string | null>;
  readonly getWindowsProcessSnapshot?: () => Promise<readonly WindowsProcessSnapshotEntry[]>;
  readonly isProcessAlive?: (pid: number) => boolean;
}

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
 * Rejects when termination fails for a reason other than an already-gone root.
 */
export async function killProcessTree(
  pid: number,
  deps: KillProcessTreeDeps,
): Promise<void> {
  const context = createKillContext(deps);
  if (context.platform === "win32") return killWindowsProcessTree(pid, context.windows);
  assertPosixPlatform(context.platform);
  return killUnixProcessTree(pid, context.unix);
}

interface UnixKillContext {
  readonly execFile: typeof execFile;
  readonly platform: NodeJS.Platform;
  readonly processKill: (pid: number, signal: string | number) => void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly getProcessStartMarker: (pid: number) => Promise<string | null>;
  readonly getRemainingProcessStartMarkers: (identities: readonly ProcessIdentity[]) => Promise<Map<number, string | null>>;
}

interface SharedKillContext {
  readonly platform: NodeJS.Platform;
  readonly execFile: typeof execFile;
  readonly processKill: (pid: number, signal: string | number) => void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}

function createKillContext(deps: KillProcessTreeDeps | undefined): {
  readonly platform: NodeJS.Platform;
  readonly windows: WindowsKillContext;
  readonly unix: UnixKillContext;
} {
  const shared = createSharedKillContext(deps);
  return {
    platform: shared.platform,
    windows: createWindowsKillContext(deps, shared),
    unix: createUnixKillContext(deps, shared),
  };
}

function createSharedKillContext(deps: KillProcessTreeDeps | undefined): SharedKillContext {
  return {
    platform: resolveKillPlatform(deps),
    execFile: resolveProcessExecutor(deps),
    processKill: resolveProcessKiller(deps),
    sleep: resolveProcessSleep(deps),
    now: resolveProcessClock(deps),
  };
}

function resolveKillPlatform(deps: KillProcessTreeDeps): NodeJS.Platform {
  return deps.platform;
}

function assertPosixPlatform(platform: NodeJS.Platform): void {
  if (["aix", "android", "darwin", "freebsd", "linux", "openbsd", "sunos"].includes(platform)) return;
  throw new Error(`Unsupported process containment platform: ${platform}`);
}

function resolveProcessExecutor(deps: KillProcessTreeDeps): typeof execFile {
  return deps.execFile ?? execFile;
}

function resolveProcessKiller(
  deps: KillProcessTreeDeps,
): (pid: number, signal: string | number) => void {
  return deps.processKill ?? defaultProcessKill;
}

function resolveProcessSleep(deps: KillProcessTreeDeps): (ms: number) => Promise<void> {
  return deps.sleep ?? defaultSleep;
}

function resolveProcessClock(deps: KillProcessTreeDeps): () => number {
  return deps.now ?? Date.now;
}

function createWindowsKillContext(
  deps: KillProcessTreeDeps,
  shared: SharedKillContext,
): WindowsKillContext {
  return {
    execFile: shared.execFile,
    processKill: shared.processKill,
    sleep: shared.sleep,
    now: shared.now,
    getSnapshot: deps?.getWindowsProcessSnapshot ?? (() => readWindowsProcessSnapshot(shared.execFile)),
    isProcessAlive: deps?.isProcessAlive ?? createProcessLivenessProbe(shared.processKill),
  };
}

function createUnixKillContext(
  deps: KillProcessTreeDeps | undefined,
  shared: SharedKillContext,
): UnixKillContext {
  const getProcessStartMarker = resolveUnixStartMarker(deps, shared.processKill, shared.execFile);
  return {
    ...shared,
    getProcessStartMarker,
    getRemainingProcessStartMarkers: resolveRemainingMarkers(deps, getProcessStartMarker, shared.execFile),
  };
}

function defaultProcessKill(pid: number, signal: string | number): void {
  process.kill(pid, signal as NodeJS.Signals);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function createProcessLivenessProbe(
  processKill: (pid: number, signal: string | number) => void,
): (pid: number) => boolean {
  return (pid) => {
    try {
      processKill(pid, 0);
      return true;
    } catch (error) {
      if (isProcessGoneError(error)) return false;
      throw error;
    }
  };
}

function resolveUnixStartMarker(
  deps: KillProcessTreeDeps | undefined,
  processKill: (pid: number, signal: string | number) => void,
  execFileForProcess: typeof execFile,
): (pid: number) => Promise<string | null> {
  if (deps?.getProcessStartMarker) return deps.getProcessStartMarker;
  if (!deps?.processKill) return (pid) => readUnixProcessStartMarker(pid, execFileForProcess);
  return async (pid) => {
    try {
      processKill(pid, 0);
      return `probe:${pid}`;
    } catch (error) {
      if (isProcessGoneError(error)) return null;
      throw error;
    }
  };
}

function resolveRemainingMarkers(
  deps: KillProcessTreeDeps | undefined,
  getProcessStartMarker: (pid: number) => Promise<string | null>,
  execFileForProcess: typeof execFile,
): (identities: readonly ProcessIdentity[]) => Promise<Map<number, string | null>> {
  if (!deps?.getProcessStartMarker && !deps?.processKill) {
    return (identities) => readUnixProcessStartMarkers(identities.map((identity) => identity.pid), execFileForProcess);
  }
  return async (identities) => {
    const markers = new Map<number, string | null>();
    for (const identity of identities) markers.set(identity.pid, await getProcessStartMarker(identity.pid));
    return markers;
  };
}

async function killUnixProcessTree(pid: number, context: UnixKillContext): Promise<void> {
  const capture = await captureProcessTree(pid, context.platform, context.execFile, context.getProcessStartMarker);
  const identities = capture.identities;
  await killUnixProcessGroup(pid, identities, context.processKill, context.getProcessStartMarker);
  await killUnixDescendants(identities, context.processKill, context.getProcessStartMarker);
  const remaining = await verifyUnixTermination(pid, identities, context);
  assertUnixTermination(pid, identities, remaining, capture.error);
  logger.info("Process tree termination verified", { pid, capturedProcessCount: identities.length });
}

async function killUnixProcessGroup(
  pid: number,
  identities: readonly ProcessIdentity[],
  processKill: UnixKillContext["processKill"],
  getProcessStartMarker: UnixKillContext["getProcessStartMarker"],
): Promise<void> {
  const root = identities.find((identity) => identity.depth === 0);
  if (pid <= 0 || !root || !(await identityStillMatches(root, getProcessStartMarker))) return;
  try {
    processKill(-pid, "SIGKILL");
  } catch (error) {
    if (isProcessGoneError(error)) {
      logger.debug("killProcessTree: process already gone", { pid });
      return;
    }
    logger.warn("killProcessTree: unexpected error killing process tree", {
      pid,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function killUnixDescendants(
  identities: readonly ProcessIdentity[],
  processKill: UnixKillContext["processKill"],
  getProcessStartMarker: UnixKillContext["getProcessStartMarker"],
): Promise<void> {
  for (const identity of [...identities].sort((left, right) => right.depth - left.depth)) {
    if (!(await identityStillMatches(identity, getProcessStartMarker))) continue;
    try {
      processKill(identity.pid, "SIGKILL");
    } catch (error) {
      if (!isProcessGoneError(error)) throw error;
    }
  }
}

async function verifyUnixTermination(
  pid: number,
  identities: readonly ProcessIdentity[],
  context: UnixKillContext,
): Promise<ProcessIdentity[]> {
  const deadline = context.now() + TERMINATION_VERIFY_TIMEOUT_MS;
  try {
    let remaining = matchingIdentities(identities, await context.getRemainingProcessStartMarkers(identities));
    while (remaining.length > 0 && context.now() < deadline) {
      await context.sleep(TERMINATION_VERIFY_POLL_MS);
      remaining = matchingIdentities(remaining, await context.getRemainingProcessStartMarkers(remaining));
    }
    return remaining;
  } catch (error) {
    logger.warn("killProcessTree: termination verification failed", {
      pid,
      capturedProcessCount: identities.length,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function assertUnixTermination(
  pid: number,
  identities: readonly ProcessIdentity[],
  remaining: readonly ProcessIdentity[],
  captureError: unknown,
): void {
  if (remaining.length > 0) {
    logger.warn("killProcessTree: termination verification timed out", {
      pid, capturedProcessCount: identities.length,
      remainingPids: remaining.map((identity) => identity.pid), timeoutMs: TERMINATION_VERIFY_TIMEOUT_MS,
    });
    throw new Error(`Process-tree termination verification timed out for PTY PID ${pid}; ${remaining.length} process(es) remain`);
  }
  if (captureError) {
    logger.warn("killProcessTree: descendant verification unavailable", {
      pid, capturedProcessCount: identities.length,
      error: captureError instanceof Error ? captureError.message : String(captureError),
    });
    throw new Error(
      `Process tree rooted at PTY PID ${pid} was terminated, but descendant verification was unavailable`,
      { cause: captureError },
    );
  }
}

interface WindowsKillContext {
  readonly execFile: typeof execFile;
  readonly processKill: (pid: number, signal: string | number) => void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly getSnapshot: () => Promise<readonly WindowsProcessSnapshotEntry[]>;
  readonly isProcessAlive: (pid: number) => boolean;
}

async function killWindowsProcessTree(
  pid: number,
  context: WindowsKillContext,
): Promise<void> {
  if (pid <= 0) return;
  const captured = buildWindowsProcessTree(pid, await context.getSnapshot());
  const root = captured.find((identity) => identity.depth === 0);
  await killWindowsProcessTreeRoot(pid, root, context);
  const signaled = await killWindowsSurvivors(captured, context);
  const remaining = await verifyWindowsTermination(signaled, context);
  assertWindowsTermination(pid, captured, remaining);
  logger.info("Process tree termination verified", {
    pid,
    capturedProcessCount: captured.length,
  });
}

async function killWindowsProcessTreeRoot(
  pid: number,
  root: ProcessIdentity | undefined,
  context: WindowsKillContext,
): Promise<void> {
  const beforeKill = indexWindowsSnapshot(await context.getSnapshot());
  if (!root || beforeKill.get(root.pid)?.startMarker !== root.startMarker) return;
  try {
    await context.execFile("taskkill", ["/T", "/F", "/PID", String(pid)], { timeout: TASKKILL_TIMEOUT_MS });
  } catch (error) {
    if (isProcessGoneError(error)) {
      logger.debug("killProcessTree: process already gone", { pid });
      return;
    }
    logger.warn("killProcessTree: unexpected error killing process tree", {
      pid, error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function killWindowsSurvivors(
  captured: readonly ProcessIdentity[],
  context: WindowsKillContext,
): Promise<ProcessIdentity[]> {
  const signaled: ProcessIdentity[] = [];
  const survivors = await classifyMatchingWindowsProcesses(captured, context);
  for (const identity of [...survivors].sort((left, right) => right.depth - left.depth)) {
    try {
      await context.execFile("taskkill", ["/F", "/PID", String(identity.pid)], { timeout: TASKKILL_TIMEOUT_MS });
      signaled.push(identity);
    } catch (error) {
      if (!isProcessGoneError(error)) throw error;
    }
  }
  return signaled;
}

async function verifyWindowsTermination(
  identities: readonly ProcessIdentity[],
  context: WindowsKillContext,
): Promise<ProcessIdentity[]> {
  const deadline = context.now() + TERMINATION_VERIFY_TIMEOUT_MS;
  let remaining = await classifyMatchingWindowsProcesses(identities, context);
  while (remaining.length > 0 && context.now() < deadline) {
    await context.sleep(TERMINATION_VERIFY_POLL_MS);
    remaining = await classifyMatchingWindowsProcesses(remaining, context);
  }
  return remaining;
}

function assertWindowsTermination(
  pid: number,
  captured: readonly ProcessIdentity[],
  remaining: readonly ProcessIdentity[],
): void {
  if (remaining.length === 0) return;
  logger.warn("killProcessTree: termination verification timed out", {
    pid, capturedProcessCount: captured.length,
    remainingPids: remaining.map((identity) => identity.pid), timeoutMs: TERMINATION_VERIFY_TIMEOUT_MS,
  });
  throw new Error(`Process-tree termination verification timed out for PTY PID ${pid}; ${remaining.length} process(es) remain`);
}

async function classifyMatchingWindowsProcesses(
  identities: readonly ProcessIdentity[],
  context: WindowsKillContext,
): Promise<ProcessIdentity[]> {
  const apparentlyAlive = identities.filter((identity) =>
    context.isProcessAlive(identity.pid));
  if (apparentlyAlive.length === 0) return [];
  const snapshot = indexWindowsSnapshot(await context.getSnapshot());
  return apparentlyAlive.filter(
    (identity) => snapshot.get(identity.pid)?.startMarker === identity.startMarker,
  );
}

function buildWindowsProcessTree(
  rootPid: number,
  snapshot: readonly WindowsProcessSnapshotEntry[],
): ProcessIdentity[] {
  const byPid = indexWindowsSnapshot(snapshot);
  const root = byPid.get(rootPid);
  if (!root) return [];
  const childrenByParent = new Map<number, WindowsProcessSnapshotEntry[]>();
  for (const entry of snapshot) {
    const children = childrenByParent.get(entry.parentPid) ?? [];
    children.push(entry);
    childrenByParent.set(entry.parentPid, children);
  }
  const identities: ProcessIdentity[] = [];
  const pending = [{ pid: rootPid, parentPid: null as number | null, depth: 0 }];
  const visited = new Set<number>();
  while (pending.length > 0 && identities.length < PROCESS_TREE_LIMIT) {
    const current = pending.shift()!;
    if (visited.has(current.pid)) continue;
    visited.add(current.pid);
    const entry = byPid.get(current.pid);
    if (!entry) continue;
    identities.push({ ...current, startMarker: entry.startMarker });
    pending.push(
      ...(childrenByParent.get(current.pid) ?? []).map((child) => ({
        pid: child.pid,
        parentPid: current.pid,
        depth: current.depth + 1,
      })),
    );
  }
  if (pending.length > 0) {
    throw new Error(
      `Process tree rooted at PTY PID ${rootPid} exceeds the ${PROCESS_TREE_LIMIT}-process verification limit`,
    );
  }
  return identities;
}

function indexWindowsSnapshot(
  snapshot: readonly WindowsProcessSnapshotEntry[],
): Map<number, WindowsProcessSnapshotEntry> {
  return new Map(snapshot.map((entry) => [entry.pid, entry]));
}

async function readWindowsProcessSnapshot(
  ef: typeof execFile,
): Promise<WindowsProcessSnapshotEntry[]> {
  const { stdout } = await ef(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      POWERSHELL_PROCESS_SNAPSHOT_SCRIPT,
    ],
    {
      timeout: TASKKILL_TIMEOUT_MS,
      maxBuffer: PROCESS_ENUMERATION_MAX_BUFFER,
      windowsHide: true,
    },
  );
  return parseWindowsProcessSnapshot(stdout);
}

function parseWindowsProcessSnapshot(output: string): WindowsProcessSnapshotEntry[] {
  if (!output.trim()) return [];
  const parsed: unknown = JSON.parse(output);
  const values = Array.isArray(parsed) ? parsed : [parsed];
  return values.flatMap(parseWindowsProcessSnapshotEntry);
}

function parseWindowsProcessSnapshotEntry(value: unknown): WindowsProcessSnapshotEntry[] {
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  const pid = record["ProcessId"];
  const parentPid = record["ParentProcessId"];
  const startMarker = record["CreationDate"];
  const name = record["Name"];
  if (!isWindowsProcessId(pid, false) || !isWindowsProcessId(parentPid, true)) return [];
  if (typeof startMarker !== "string" || startMarker.length === 0) return [];
  if (typeof name !== "string" || name.length === 0) return [];
  return [{ pid, parentPid, startMarker, name }];
}

function isWindowsProcessId(value: unknown, permitsZero: boolean): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && (permitsZero ? value >= 0 : value > 0);
}

async function captureProcessTree(
  rootPid: number,
  platform: NodeJS.Platform,
  ef: typeof execFile,
  getProcessStartMarker: (pid: number) => Promise<string | null>,
): Promise<{ identities: ProcessIdentity[]; error?: unknown }> {
  if (rootPid <= 0) return { identities: [] };
  const identities: ProcessIdentity[] = [];
  const pending = [{ pid: rootPid, parentPid: null as number | null, depth: 0 }];
  const visited = new Set<number>();
  while (pending.length > 0 && identities.length < PROCESS_TREE_LIMIT) {
    const current = pending.shift()!;
    const currentPid = current.pid;
    if (visited.has(currentPid)) continue;
    visited.add(currentPid);
    let startMarker: string | null;
    try {
      startMarker = await getProcessStartMarker(currentPid);
    } catch (error) {
      return { identities, error };
    }
    if (startMarker === null) continue;
    identities.push({ ...current, startMarker });
    let children: Array<{ name: string; pid: number }>;
    try {
      children = await listDirectChildrenWith(currentPid, platform, ef);
    } catch (error) {
      return { identities, error };
    }
    pending.push(
      ...children.map((child) => ({
        pid: child.pid,
        parentPid: currentPid,
        depth: current.depth + 1,
      })),
    );
  }
  if (pending.length > 0) {
    throw new Error(
      `Process tree rooted at PTY PID ${rootPid} exceeds the ${PROCESS_TREE_LIMIT}-process verification limit`,
    );
  }
  return { identities };
}

async function identityStillMatches(
  identity: ProcessIdentity,
  getProcessStartMarker: (pid: number) => Promise<string | null>,
): Promise<boolean> {
  return (await getProcessStartMarker(identity.pid)) === identity.startMarker;
}

function matchingIdentities(
  identities: readonly ProcessIdentity[],
  markers: ReadonlyMap<number, string | null>,
): ProcessIdentity[] {
  return identities.filter(
    (identity) => markers.get(identity.pid) === identity.startMarker,
  );
}

async function readUnixProcessStartMarkers(
  pids: readonly number[],
  ef: typeof execFile,
): Promise<Map<number, string>> {
  if (pids.length === 0) return new Map();
  try {
    const { stdout } = await ef(
      "ps",
      ["-o", "pid=,lstart=", "-p", pids.join(",")],
      { timeout: TASKKILL_TIMEOUT_MS },
    );
    const markers = new Map<number, string>();
    for (const line of stdout.split(/\r?\n/)) {
      const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
      if (!match) continue;
      markers.set(Number(match[1]), match[2]);
    }
    return markers;
  } catch (err) {
    if (isProcessGoneError(err) || (err as { code?: unknown }).code === 1) return new Map();
    throw err;
  }
}

async function readUnixProcessStartMarker(
  pid: number,
  ef: typeof execFile,
): Promise<string | null> {
  try {
    const { stdout } = await ef("ps", ["-o", "lstart=", "-p", String(pid)], {
      timeout: TASKKILL_TIMEOUT_MS,
    });
    return stdout.trim() || null;
  } catch (err) {
    if (isProcessGoneError(err) || (err as { code?: unknown }).code === 1) return null;
    throw err;
  }
}

/**
 * Recursively find descendant processes matching a given name.
 * On Windows uses PowerShell CIM to query the process tree (returns name + PID).
 * On Unix uses pgrep (returns PIDs only, without names), so name matching
 * will never produce results there. Callers that need name-based filtering
 * should guard with a platform check (see {@link killDescendantsByName}).
 * Best-effort: returns an empty array on failure.
 */
export async function findDescendantsByName(
  parentPid: number,
  processName: string,
  platform: NodeJS.Platform,
): Promise<number[]> {
  const matched: number[] = [];
  const visited = new Set<number>();
  const queue = [parentPid];

  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (visited.has(pid)) continue;
    visited.add(pid);

    let children: Array<{ name: string; pid: number }>;
    try {
      children = await listDirectChildren(pid, platform);
    } catch {
      continue;
    }

    for (const child of children) {
      if (child.name.toLowerCase() === processName.toLowerCase()) {
        matched.push(child.pid);
      }
      queue.push(child.pid);
    }
  }

  return matched;
}

/**
 * Find descendant processes matching a name and kill each one.
 * Best-effort: never throws. Used to clean up SDK subprocesses that
 * outlive their stream connection.
 *
 * Windows-only: on Unix, process cwd does not hold ancestor directory
 * handles, so the directory locking problem this solves does not occur.
 * The Windows process tree scan also has no Unix equivalent that
 * returns process names without additional per-PID lookups.
 */
export async function killDescendantsByName(
  parentPid: number,
  processName: string,
  platform: NodeJS.Platform,
): Promise<void> {
  if (platform !== "win32") return;

  const pids = await findDescendantsByName(parentPid, processName, platform);
  if (pids.length === 0) return;

  logger.info("Killing descendant processes", { parentPid, processName, pids });
  await Promise.all(pids.map((pid) => killProcessTree(pid, { platform })));
}

// 2 s grace period between each signal ladder step
const GRACEFUL_KILL_STEP_MS = 2_000;

/** Injectable dependencies for gracefulKillProcessTree (for testability). */
export interface GracefulKillDeps {
  processKill?: (pid: number, signal: string | number) => void;
  execFile?: (
    cmd: string,
    args: string[],
    opts: { timeout?: number },
  ) => Promise<{ stdout: string; stderr: string }>;
  platform: NodeJS.Platform;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Graceful shutdown ladder for PTY process trees (app-quit path only).
 * Sends SIGHUP, waits 2s, sends SIGTERM, waits 2s, sends SIGKILL.
 * On Windows: taskkill without /F, wait 2s, taskkill with /F.
 * Short-circuits at each step if the process has already exited.
 * Never throws.
 */
export async function gracefulKillProcessTree(
  pid: number,
  deps?: GracefulKillDeps,
): Promise<void> {
  const context = createGracefulKillContext(deps);
  try {
    await runGracefulKillProcessTree(pid, context);
  } catch (err) {
    logger.warn("gracefulKillProcessTree: unexpected error", {
      pid,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

interface GracefulKillContext {
  readonly kill: (pid: number, signal: string | number) => void;
  readonly execFile: NonNullable<GracefulKillDeps["execFile"]>;
  readonly platform: NodeJS.Platform;
  readonly sleep: (ms: number) => Promise<void>;
}

function createGracefulKillContext(deps: GracefulKillDeps): GracefulKillContext {
  return {
    kill: deps.processKill ?? defaultProcessKill,
    execFile: deps.execFile ?? execFile,
    platform: deps.platform,
    sleep: deps.sleep ?? defaultSleep,
  };
}

async function runGracefulKillProcessTree(pid: number, context: GracefulKillContext): Promise<void> {
  if (context.platform === "win32") {
    return gracefulKillWindowsProcessTree(pid, context.execFile, context.sleep);
  }
  assertPosixPlatform(context.platform);
  return gracefulKillUnixProcessTree(pid, context.kill, context.sleep);
}

async function gracefulKillWindowsProcessTree(
  pid: number,
  execFileForProcess: NonNullable<GracefulKillDeps["execFile"]>,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  try {
    await execFileForProcess("taskkill", ["/T", "/PID", String(pid)], { timeout: TASKKILL_TIMEOUT_MS });
    return;
  } catch {
    await sleep(GRACEFUL_KILL_STEP_MS);
  }
  try {
    await execFileForProcess("taskkill", ["/T", "/F", "/PID", String(pid)], { timeout: TASKKILL_TIMEOUT_MS });
  } catch {
    // The process may already be gone.
  }
}

async function gracefulKillUnixProcessTree(
  pid: number,
  kill: (pid: number, signal: string | number) => void,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  if (pid <= 0) return;
  if (!sendGracefulSignal(kill, -pid, "SIGHUP", true)) return;
  await sleep(GRACEFUL_KILL_STEP_MS);
  if (!isAliveAfterGracefulSignal(kill, pid)) return;
  if (!sendGracefulSignal(kill, -pid, "SIGTERM", false)) return;
  await sleep(GRACEFUL_KILL_STEP_MS);
  if (!isAliveAfterGracefulSignal(kill, pid)) return;
  try {
    kill(-pid, "SIGKILL");
  } catch {
    // The process may already be gone.
  }
}

function sendGracefulSignal(
  kill: (pid: number, signal: string | number) => void,
  pid: number,
  signal: "SIGHUP" | "SIGTERM",
  rethrowUnexpected: boolean,
): boolean {
  try {
    kill(pid, signal);
    return true;
  } catch (error) {
    if (isEsrch(error)) return false;
    if (rethrowUnexpected) throw error;
    return false;
  }
}

function isAliveAfterGracefulSignal(
  kill: (pid: number, signal: string | number) => void,
  pid: number,
): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Returns true when the error code indicates the process no longer exists. */
function isEsrch(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ESRCH";
}

/**
 * List direct child processes of a given PID.
 * Returns name and PID for each child.
 */
export async function listDirectChildren(
  pid: number,
  platform: NodeJS.Platform,
): Promise<Array<{ name: string; pid: number }>> {
  return listDirectChildrenWith(pid, platform, execFile);
}

async function listDirectChildrenWith(
  pid: number,
  platform: NodeJS.Platform,
  ef: typeof execFile,
): Promise<Array<{ name: string; pid: number }>> {
  if (platform === "win32") {
    const { stdout } = await ef(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        POWERSHELL_CHILD_PROCESS_SCRIPT,
        String(pid),
      ],
      {
        timeout: TASKKILL_TIMEOUT_MS,
        maxBuffer: PROCESS_ENUMERATION_MAX_BUFFER,
        windowsHide: true,
      },
    );
    return parsePowerShellProcesses(stdout);
  }

  assertPosixPlatform(platform);

  // Unix: pgrep -P returns child PIDs, one per line
  let stdout: string;
  try {
    ({ stdout } = await ef("pgrep", ["-P", String(pid)], {
      timeout: TASKKILL_TIMEOUT_MS,
    }));
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === 1 || code === "1") return [];
    throw err;
  }
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => ({ name: "", pid: parseInt(line.trim(), 10) }))
    .filter((entry) => !isNaN(entry.pid));
}

/** Parse bounded PowerShell CIM JSON into validated name/PID pairs. */
function parsePowerShellProcesses(
  output: string,
): Array<{ name: string; pid: number }> {
  if (!output.trim()) return [];
  const parsed: unknown = JSON.parse(output);
  const values = Array.isArray(parsed) ? parsed : [parsed];
  return values.flatMap((value) => {
    if (typeof value !== "object" || value === null) return [];
    const record = value as Record<string, unknown>;
    const name = record["Name"];
    const pid = record["ProcessId"];
    if (
      typeof name !== "string" ||
      name.length === 0 ||
      typeof pid !== "number" ||
      !Number.isSafeInteger(pid) ||
      pid <= 0
    ) {
      return [];
    }
    return [{ name, pid }];
  });
}
