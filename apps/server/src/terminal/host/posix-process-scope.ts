import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PtyProcessScope } from "./pty-host-runtime.js";

const execFileAsync = promisify(execFile);
const PROCESS_TABLE_TIMEOUT_MS = 1_000;
const PROCESS_TABLE_MAX_BYTES = 1_048_576;
const GRACEFUL_CLOSE_TIMEOUT_MS = 3_000;
const FORCED_CLOSE_TIMEOUT_MS = 5_000;
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

/** Creates one fail-closed POSIX process-group scope for a native PTY. */
export function createPosixProcessScope(
  rootPid: number,
  dependencies: PosixProcessScopeDependencies = defaultDependencies,
): PtyProcessScope {
  let established = false;
  const knownProcessGroupIds = new Set<number>();

  const readSessionMembers = async (): Promise<readonly PosixProcessRecord[]> => {
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
    while ((await readSessionMembers()).length > 0) {
      if (dependencies.monotonicNow() >= deadlineMs) return false;
      await dependencies.sleep(CLOSE_POLL_INTERVAL_MS);
    }
    return true;
  };

  const signal = (value: NodeJS.Signals | 0): boolean => {
    try {
      dependencies.signalProcessGroup(rootPid, value);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  };

  const signalSession = async (value: NodeJS.Signals): Promise<boolean> => {
    const members = await readSessionMembers();
    if (members.length === 0) return false;
    const processGroupIds = [
      ...new Set(members.map((member) => member.processGroupId)),
    ].sort((left, right) => {
      if (left === rootPid) return 1;
      if (right === rootPid) return -1;
      return left - right;
    });
    for (const processGroupId of processGroupIds) {
      if (processGroupId === rootPid && processGroupIds.length > 1) {
        await dependencies.sleep(CLOSE_POLL_INTERVAL_MS);
      }
      try {
        dependencies.signalProcessGroup(processGroupId, value);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    return true;
  };

  return {
    mechanism: "process-group",
    processGroupId: String(rootPid),
    establish: async () => {
      if (!Number.isSafeInteger(rootPid) || rootPid <= 1) return false;
      const root = (await dependencies.readProcessTable()).find(
        (record) => record.pid === rootPid,
      );
      if (root?.processGroupId !== rootPid || root.sessionId !== rootPid) {
        return false;
      }
      if (!signal(0)) return false;
      knownProcessGroupIds.add(rootPid);
      established = true;
      return true;
    },
    hasChildren: async () => {
      if (!established)
        throw new Error("POSIX PTY process group is not established");
      return (await readSessionMembers()).some(
        (record) => record.pid !== rootPid,
      );
    },
    close: async () => {
      if (!established)
        throw new Error("POSIX PTY process group is not established");
      const startedAt = dependencies.monotonicNow();
      if (!(await signalSession("SIGHUP"))) return;
      if (await waitForEmpty(startedAt + GRACEFUL_CLOSE_TIMEOUT_MS)) return;
      while (dependencies.monotonicNow() < startedAt + FORCED_CLOSE_TIMEOUT_MS) {
        if (!(await signalSession("SIGKILL"))) return;
        await dependencies.sleep(CLOSE_POLL_INTERVAL_MS);
      }
      if ((await readSessionMembers()).length === 0) return;
      throw new Error(
        `POSIX PTY session ${rootPid} remained non-empty after forced close`,
      );
    },
    dispose: () => {
      if (!established) return;
      for (const processGroupId of knownProcessGroupIds) {
        try {
          dependencies.signalProcessGroup(processGroupId, "SIGKILL");
        } catch {
          // The host is already stopping and cannot recover a disposal failure.
        }
      }
    },
  };
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
