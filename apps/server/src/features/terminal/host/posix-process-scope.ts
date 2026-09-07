import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import type { PtyProcessScope } from "./pty-host-runtime.js";

const execFileAsync = NodeUtil.promisify(NodeChildProcess.execFile);
const PROCESS_TABLE_TIMEOUT_MS = 1_000;
const PROCESS_TABLE_MAX_BYTES = 1_048_576;
const GRACEFUL_CLOSE_TIMEOUT_MS = 3_000;
const TERMINATE_CLOSE_TIMEOUT_MS = 500;
const FORCED_CLOSE_TIMEOUT_MS = 5_000;
const ESTABLISH_TIMEOUT_MS = 500;
const CLOSE_POLL_INTERVAL_MS = 25;

interface PosixProcessRecord {
  readonly pid: number;
  readonly processGroupId: number;
  readonly sessionId: number;
}

/** Injectable POSIX process operations used by the PTY containment scope. */
export interface PosixProcessScopeDependencies {
  readonly readProcessTable: () => Promise<readonly PosixProcessRecord[]>;
  readonly signalProcessGroup: (
    processGroupId: number,
    signal: NodeJS.Signals | 0,
  ) => void;
  readonly monotonicNow: () => number;
  readonly sleep: (durationMs: number) => Promise<void>;
}

interface PosixSessionOperations {
  readonly knownProcessGroupIds: ReadonlySet<number>;
  readonly readMembers: () => Promise<readonly PosixProcessRecord[]>;
  readonly signalAll: (
    signal: NodeJS.Signals,
    delayBeforeRoot: boolean,
  ) => Promise<boolean>;
  readonly waitForEmpty: (deadlineMs: number) => Promise<boolean>;
}

async function forceClose(
  session: PosixSessionOperations,
  dependencies: PosixProcessScopeDependencies,
  deadlineMs: number,
): Promise<void> {
  while (dependencies.monotonicNow() < deadlineMs) {
    if (!(await session.signalAll("SIGKILL", false))) return;
    await dependencies.sleep(CLOSE_POLL_INTERVAL_MS);
  }
  if ((await session.readMembers()).length === 0) return;
  throw new Error("POSIX PTY session remained non-empty after forced close");
}

function createPosixSessionOperations(
  rootPid: number,
  dependencies: PosixProcessScopeDependencies,
): PosixSessionOperations {
  const knownProcessGroupIds = new Set<number>();
  const readMembers = async (): Promise<readonly PosixProcessRecord[]> => {
    const members = (await dependencies.readProcessTable()).filter(
      (record) => record.sessionId === rootPid,
    );
    knownProcessGroupIds.clear();
    for (const member of members) {
      knownProcessGroupIds.add(member.processGroupId);
    }
    return members;
  };
  const waitForEmpty = async (deadlineMs: number): Promise<boolean> => {
    while ((await readMembers()).length > 0) {
      if (dependencies.monotonicNow() >= deadlineMs) return false;
      await dependencies.sleep(CLOSE_POLL_INTERVAL_MS);
    }
    return true;
  };
  const signalAll = async (
    signal: NodeJS.Signals,
    delayBeforeRoot: boolean,
  ): Promise<boolean> => {
    const members = await readMembers();
    if (members.length === 0) return false;
    const processGroupIds = [
      ...new Set(members.map((member) => member.processGroupId)),
    ].sort((left, right) => {
      if (left === rootPid) return 1;
      if (right === rootPid) return -1;
      return left - right;
    });
    for (const processGroupId of processGroupIds) {
      if (
        delayBeforeRoot &&
        processGroupId === rootPid &&
        processGroupIds.length > 1
      ) {
        await dependencies.sleep(CLOSE_POLL_INTERVAL_MS);
      }
      try {
        dependencies.signalProcessGroup(processGroupId, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    return true;
  };
  return { knownProcessGroupIds, readMembers, signalAll, waitForEmpty };
}

/** Creates one fail-closed POSIX process-group scope for a native PTY. */
export function createPosixProcessScope(
  rootPid: number,
  dependencies: PosixProcessScopeDependencies = defaultDependencies,
): PtyProcessScope {
  let established = false;
  const session = createPosixSessionOperations(rootPid, dependencies);

  const signal = (value: NodeJS.Signals | 0): boolean => {
    try {
      dependencies.signalProcessGroup(rootPid, value);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  };

  return {
    mechanism: "process-group",
    processGroupId: String(rootPid),
    establish: async () => {
      if (!Number.isSafeInteger(rootPid) || rootPid <= 1) return false;
      const deadlineMs = dependencies.monotonicNow() + ESTABLISH_TIMEOUT_MS;
      while (true) {
        const root = (await session.readMembers()).find(
          (record) => record.pid === rootPid,
        );
        if (root?.processGroupId === rootPid && root.sessionId === rootPid) {
          if (!signal(0)) return false;
          established = true;
          return true;
        }
        if (dependencies.monotonicNow() >= deadlineMs) return false;
        await dependencies.sleep(CLOSE_POLL_INTERVAL_MS);
      }
    },
    hasChildren: async () => {
      if (!established)
        throw new Error("POSIX PTY process group is not established");
      return (await session.readMembers()).some(
        (record) => record.pid !== rootPid,
      );
    },
    close: async (graceful = false) => {
      if (!established)
        throw new Error("POSIX PTY process group is not established");
      const startedAt = dependencies.monotonicNow();
      const forcedDeadline = startedAt + FORCED_CLOSE_TIMEOUT_MS;
      if (!graceful) {
        await forceClose(session, dependencies, forcedDeadline);
        return;
      }
      if (!(await session.signalAll("SIGHUP", true))) return;
      if (await session.waitForEmpty(startedAt + GRACEFUL_CLOSE_TIMEOUT_MS)) return;
      if (!(await session.signalAll("SIGTERM", true))) return;
      const terminateDeadline = Math.min(
        forcedDeadline,
        dependencies.monotonicNow() + TERMINATE_CLOSE_TIMEOUT_MS,
      );
      if (await session.waitForEmpty(terminateDeadline)) return;
      await forceClose(session, dependencies, forcedDeadline);
    },
    dispose: () => {
      if (!established) return;
      for (const processGroupId of session.knownProcessGroupIds) {
        try {
          dependencies.signalProcessGroup(processGroupId, "SIGKILL");
        } catch {
          // The host is already stopping and cannot recover a disposal failure.
        }
      }
    },
  };
}

/** Reaps every surviving process group from one crashed POSIX PTY session. */
export async function reapPosixProcessSession(
  rootPid: number,
  processGroupId: string,
  dependencies: PosixProcessScopeDependencies = defaultDependencies,
): Promise<void> {
  if (
    !Number.isSafeInteger(rootPid) ||
    rootPid <= 1 ||
    processGroupId !== String(rootPid)
  ) {
    throw new Error("POSIX PTY process identity does not match");
  }
  const session = createPosixSessionOperations(rootPid, dependencies);
  const deadline = dependencies.monotonicNow() + FORCED_CLOSE_TIMEOUT_MS;
  while (dependencies.monotonicNow() < deadline) {
    if (!(await session.signalAll("SIGKILL", false))) return;
    await dependencies.sleep(CLOSE_POLL_INTERVAL_MS);
  }
  if ((await session.readMembers()).length === 0) return;
  throw new Error(
    `POSIX PTY session ${rootPid} remained non-empty after crash cleanup`,
  );
}

const defaultDependencies: PosixProcessScopeDependencies = {
  readProcessTable: async () => {
    const { stdout } = await execFileAsync(
      "ps",
      ["-axo", "pid=,pgid=,sid="],
      {
        timeout: PROCESS_TABLE_TIMEOUT_MS,
        maxBuffer: PROCESS_TABLE_MAX_BYTES,
      },
    );
    return stdout.split(/\r?\n/).flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
      if (!match) return [];
      const pid = Number(match[1]);
      const processGroupId = Number(match[2]);
      const sessionId = Number(match[3]);
      if (
        !Number.isSafeInteger(pid) ||
        pid <= 0 ||
        !Number.isSafeInteger(processGroupId) ||
        processGroupId <= 0 ||
        !Number.isSafeInteger(sessionId) ||
        sessionId <= 0
      ) {
        return [];
      }
      return [{ pid, processGroupId, sessionId }];
    });
  },
  signalProcessGroup: (processGroupId, signal) => {
    process.kill(-processGroupId, signal);
  },
  monotonicNow: () => performance.now(),
  sleep: (durationMs) =>
    new Promise<void>((resolve) => setTimeout(resolve, durationMs)),
};
