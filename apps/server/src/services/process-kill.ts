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
const TERMINATION_VERIFY_TIMEOUT_MS = 2_000;
const TERMINATION_VERIFY_POLL_MS = 50;

/** Injectable process-tree termination dependencies for focused verification tests. */
export interface KillProcessTreeDeps {
  readonly execFile?: typeof execFile;
  readonly platform?: NodeJS.Platform;
  readonly processKill?: (pid: number, signal: string | number) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
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
  let identities: number[];
  try {
    identities = await captureProcessTree(pid, platform, ef);
  } catch (err) {
    logger.warn("killProcessTree: failed to capture process identities", {
      pid,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  try {
    if (platform === "win32") {
      await ef("taskkill", ["/T", "/F", "/PID", String(pid)], {
        timeout: TASKKILL_TIMEOUT_MS,
      });
    } else {
      // Guard against pid <= 0: process.kill(0) would kill the server's own group.
      if (pid > 0) {
        processKill(-pid, "SIGKILL");
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
      throw err;
    }
  }

  const deadline = now() + TERMINATION_VERIFY_TIMEOUT_MS;
  let remaining: number[];
  try {
    remaining = identities.filter((identity) => isProcessRunning(identity, processKill));
    while (remaining.length > 0 && now() < deadline) {
      await sleep(TERMINATION_VERIFY_POLL_MS);
      remaining = remaining.filter((identity) => isProcessRunning(identity, processKill));
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
      remainingPids: remaining,
      timeoutMs: TERMINATION_VERIFY_TIMEOUT_MS,
    });
    throw new Error(
      `Process-tree termination verification timed out for PTY PID ${pid}; ${remaining.length} process(es) remain`,
    );
  }
  logger.info("Process tree termination verified", {
    pid,
    capturedProcessCount: identities.length,
  });
}

async function captureProcessTree(
  rootPid: number,
  platform: NodeJS.Platform,
  ef: typeof execFile,
): Promise<number[]> {
  if (rootPid <= 0) return [];
  const identities: number[] = [];
  const pending = [rootPid];
  const visited = new Set<number>();
  while (pending.length > 0 && identities.length < PROCESS_TREE_LIMIT) {
    const currentPid = pending.shift()!;
    if (visited.has(currentPid)) continue;
    visited.add(currentPid);
    identities.push(currentPid);
    const children = await listDirectChildrenWith(currentPid, platform, ef);
    pending.push(...children.map((child) => child.pid));
  }
  if (pending.length > 0) {
    throw new Error(
      `Process tree rooted at PTY PID ${rootPid} exceeds the ${PROCESS_TREE_LIMIT}-process verification limit`,
    );
  }
  return identities;
}

function isProcessRunning(
  pid: number,
  processKill: (pid: number, signal: string | number) => void,
): boolean {
  try {
    processKill(pid, 0);
    return true;
  } catch (err) {
    if (isProcessGoneError(err)) return false;
    throw err;
  }
}

/**
 * Recursively find descendant processes matching a given name.
 * On Windows uses wmic to query the process tree (returns name + PID).
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
 * The wmic-based process tree scan also has no Unix equivalent that
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
      "wmic",
      ["process", "where", `ParentProcessId=${pid}`, "get", "Name,ProcessId", "/format:csv"],
      { timeout: TASKKILL_TIMEOUT_MS },
    );
    return parseWmicCsv(stdout);
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

/** Parse wmic CSV output into name/pid pairs. */
function parseWmicCsv(output: string): Array<{ name: string; pid: number }> {
  const lines = output.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];

  const header = lines[0]!.toLowerCase();
  const nameIdx = header.split(",").findIndex((col) => col.trim() === "name");
  const pidIdx = header.split(",").findIndex((col) => col.trim() === "processid");
  if (nameIdx === -1 || pidIdx === -1) return [];

  return lines.slice(1).reduce<Array<{ name: string; pid: number }>>((acc, line) => {
    const cols = line.split(",");
    const name = cols[nameIdx]?.trim() ?? "";
    const pid = parseInt(cols[pidIdx]?.trim() ?? "", 10);
    if (name && !isNaN(pid)) acc.push({ name, pid });
    return acc;
  }, []);
}
