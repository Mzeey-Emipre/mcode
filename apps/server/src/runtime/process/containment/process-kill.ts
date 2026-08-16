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
  readonly platform?: NodeJS.Platform;
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
  deps?: KillProcessTreeDeps,
): Promise<void> {
  const ef = deps?.execFile ?? execFile;
  const platform = deps?.platform ?? process.platform;
  const processKill =
    deps?.processKill ??
    ((targetPid: number, signal: string | number) => {
      process.kill(targetPid, signal as NodeJS.Signals);
    });
  const sleep =
    deps?.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps?.now ?? Date.now;
  if (platform === "win32") {
    return killWindowsProcessTree(pid, {
      execFile: ef,
      processKill,
      sleep,
      now,
      getSnapshot:
        deps?.getWindowsProcessSnapshot ??
        (() => readWindowsProcessSnapshot(ef)),
      isProcessAlive:
        deps?.isProcessAlive ??
        ((targetPid) => {
          try {
            processKill(targetPid, 0);
            return true;
          } catch (err) {
            if (isProcessGoneError(err)) return false;
            throw err;
          }
        }),
    });
  }
  const getProcessStartMarker =
    deps?.getProcessStartMarker ??
    (deps?.processKill
      ? async (targetPid: number) => {
          try {
            processKill(targetPid, 0);
            return `probe:${targetPid}`;
          } catch (err) {
            if (isProcessGoneError(err)) return null;
            throw err;
          }
        }
      : (targetPid: number) => readUnixProcessStartMarker(targetPid, ef));
  const getRemainingProcessStartMarkers =
    deps?.getProcessStartMarker || deps?.processKill
    ? async (identities: readonly ProcessIdentity[]) => {
        const markers = new Map<number, string | null>();
        for (const identity of identities) {
          markers.set(identity.pid, await getProcessStartMarker(identity.pid));
        }
        return markers;
      }
    : (identities: readonly ProcessIdentity[]) =>
        readUnixProcessStartMarkers(identities.map((identity) => identity.pid), ef);
  const capture = await captureProcessTree(pid, platform, ef, getProcessStartMarker);
  const identities = capture.identities;
  const capturedRoot = identities.find((identity) => identity.depth === 0);
  const rootStillMatches =
    capturedRoot !== undefined &&
    await identityStillMatches(capturedRoot, getProcessStartMarker);

  try {
    // Guard against pid <= 0: process.kill(0) would kill the server's own group.
    if (pid > 0 && rootStillMatches) {
      processKill(-pid, "SIGKILL");
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
      throw err;
    }
  }

  for (const identity of [...identities].sort((a, b) => b.depth - a.depth)) {
    if (!(await identityStillMatches(identity, getProcessStartMarker))) continue;
    try {
      processKill(identity.pid, "SIGKILL");
    } catch (err) {
      if (!isProcessGoneError(err)) throw err;
    }
  }

  const deadline = now() + TERMINATION_VERIFY_TIMEOUT_MS;
  let remaining: ProcessIdentity[];
  try {
    remaining = matchingIdentities(
      identities,
      await getRemainingProcessStartMarkers(identities),
    );
    while (remaining.length > 0 && now() < deadline) {
      await sleep(TERMINATION_VERIFY_POLL_MS);
      remaining = matchingIdentities(
        remaining,
        await getRemainingProcessStartMarkers(remaining),
      );
    }
  } catch (err) {
    logger.warn("killProcessTree: termination verification failed", {
      pid,
      capturedProcessCount: identities.length,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  if (remaining.length > 0) {
    logger.warn("killProcessTree: termination verification timed out", {
      pid,
      capturedProcessCount: identities.length,
      remainingPids: remaining.map((identity) => identity.pid),
      timeoutMs: TERMINATION_VERIFY_TIMEOUT_MS,
    });
    throw new Error(
      `Process-tree termination verification timed out for PTY PID ${pid}; ${remaining.length} process(es) remain`,
    );
  }
  if (capture.error) {
    logger.warn("killProcessTree: descendant verification unavailable", {
      pid,
      capturedProcessCount: identities.length,
      error: capture.error instanceof Error ? capture.error.message : String(capture.error),
    });
    throw new Error(
      `Process tree rooted at PTY PID ${pid} was terminated, but descendant verification was unavailable`,
      { cause: capture.error },
    );
  }
  logger.info("Process tree termination verified", {
    pid,
    capturedProcessCount: identities.length,
  });
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
  const beforeKill = indexWindowsSnapshot(await context.getSnapshot());
  const rootStillMatches =
    root !== undefined &&
    beforeKill.get(root.pid)?.startMarker === root.startMarker;

  if (rootStillMatches) {
    try {
      await context.execFile("taskkill", ["/T", "/F", "/PID", String(pid)], {
        timeout: TASKKILL_TIMEOUT_MS,
      });
    } catch (err) {
      if (isProcessGoneError(err)) {
        logger.debug("killProcessTree: process already gone", { pid });
      } else {
        logger.warn("killProcessTree: unexpected error killing process tree", {
          pid,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    }
  }

  const survivors = await classifyMatchingWindowsProcesses(captured, context);
  const signaled: ProcessIdentity[] = [];
  for (const identity of [...survivors].sort((a, b) => b.depth - a.depth)) {
    try {
      await context.execFile("taskkill", ["/F", "/PID", String(identity.pid)], {
        timeout: TASKKILL_TIMEOUT_MS,
      });
      signaled.push(identity);
    } catch (err) {
      if (!isProcessGoneError(err)) throw err;
    }
  }

  const deadline = context.now() + TERMINATION_VERIFY_TIMEOUT_MS;
  let remaining = await classifyMatchingWindowsProcesses(signaled, context);
  while (remaining.length > 0 && context.now() < deadline) {
    await context.sleep(TERMINATION_VERIFY_POLL_MS);
    remaining = await classifyMatchingWindowsProcesses(remaining, context);
  }
  if (remaining.length > 0) {
    logger.warn("killProcessTree: termination verification timed out", {
      pid,
      capturedProcessCount: captured.length,
      remainingPids: remaining.map((identity) => identity.pid),
      timeoutMs: TERMINATION_VERIFY_TIMEOUT_MS,
    });
    throw new Error(
      `Process-tree termination verification timed out for PTY PID ${pid}; ${remaining.length} process(es) remain`,
    );
  }
  logger.info("Process tree termination verified", {
    pid,
    capturedProcessCount: captured.length,
  });
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
  return values.flatMap((value) => {
    if (typeof value !== "object" || value === null) return [];
    const record = value as Record<string, unknown>;
    const pid = record["ProcessId"];
    const parentPid = record["ParentProcessId"];
    const startMarker = record["CreationDate"];
    const name = record["Name"];
    if (
      typeof pid !== "number" ||
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      typeof parentPid !== "number" ||
      !Number.isSafeInteger(parentPid) ||
      parentPid < 0 ||
      typeof startMarker !== "string" ||
      startMarker.length === 0 ||
      typeof name !== "string" ||
      name.length === 0
    ) {
      return [];
    }
    return [{ pid, parentPid, startMarker, name }];
  });
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
      children = await listDirectChildren(pid);
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
): Promise<void> {
  if (process.platform !== "win32") return;

  const pids = await findDescendantsByName(parentPid, processName);
  if (pids.length === 0) return;

  logger.info("Killing descendant processes", { parentPid, processName, pids });
  await Promise.all(pids.map((pid) => killProcessTree(pid)));
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
  platform?: NodeJS.Platform;
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
  const kill = deps?.processKill ?? ((p: number, sig: string | number) => process.kill(p, sig as NodeJS.Signals));
  const ef = deps?.execFile ?? execFile;
  const platform = deps?.platform ?? process.platform;
  const sleep =
    deps?.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  try {
    if (platform === "win32") {
      // Windows path: taskkill without /F first (graceful), then with /F (force)
      try {
        await ef("taskkill", ["/T", "/PID", String(pid)], {
          timeout: TASKKILL_TIMEOUT_MS,
        });
        // Process terminated gracefully
        return;
      } catch {
        // Process still alive — fall through to forced kill
      }

      await sleep(GRACEFUL_KILL_STEP_MS);

      try {
        await ef("taskkill", ["/T", "/F", "/PID", String(pid)], {
          timeout: TASKKILL_TIMEOUT_MS,
        });
      } catch {
        // Swallow — process may already be gone
      }
    } else {
      // Unix path
      if (pid <= 0) return;

      // Step 1: SIGHUP
      try {
        kill(-pid, "SIGHUP");
      } catch (err) {
        if (isEsrch(err)) return;
        // Unexpected error (e.g. EPERM) — log and abort the ladder rather than
        // silently skipping so the caller's outer catch surfaces it.
        throw err;
      }

      await sleep(GRACEFUL_KILL_STEP_MS);

      // Liveness probe after SIGHUP
      try {
        kill(pid, 0);
      } catch (err) {
        if (isEsrch(err)) return;
        return;
      }

      // Step 2: SIGTERM
      try {
        kill(-pid, "SIGTERM");
      } catch (err) {
        if (isEsrch(err)) return;
        return;
      }

      await sleep(GRACEFUL_KILL_STEP_MS);

      // Liveness probe after SIGTERM
      try {
        kill(pid, 0);
      } catch (err) {
        if (isEsrch(err)) return;
        return;
      }

      // Step 3: SIGKILL
      try {
        kill(-pid, "SIGKILL");
      } catch {
        // Swallow — process may already be gone
      }
    }
  } catch (err) {
    logger.warn("gracefulKillProcessTree: unexpected error", {
      pid,
      error: err instanceof Error ? err.message : String(err),
    });
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
): Promise<Array<{ name: string; pid: number }>> {
  return listDirectChildrenWith(pid, process.platform, execFile);
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
