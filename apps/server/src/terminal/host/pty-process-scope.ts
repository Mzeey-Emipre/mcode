import {
  gracefulKillProcessTree,
  listDirectChildren,
} from "../../services/process-kill.js";
import { WindowsProcessScopeFactory } from "../../services/windows-process-scope.js";
import type { PtyProcessScope } from "./pty-host-runtime.js";

/** Creates an authoritative process scope for one native PTY. */
export function createPtyProcessScope(rootPid: number): PtyProcessScope {
  if (process.platform === "win32") {
    const scope = new WindowsProcessScopeFactory().create();
    return {
      mechanism: "job-object",
      processGroupId: `job-${rootPid}`,
      establish: async () => {
        const assigned = scope.assign(rootPid);
        if (!assigned.ok) return false;
        return (await scope.reconcile(rootPid)).ok;
      },
      hasChildren: async () => {
        const snapshot = scope.queryProcessIds();
        return (
          snapshot.ok && snapshot.processIds.some((pid) => pid !== rootPid)
        );
      },
      close: async () => {
        const terminated = scope.terminate(0);
        if (!terminated.ok) {
          throw new Error(
            terminated.error ?? "PTY Job Object termination failed",
          );
        }
        const emptied = await scope.waitForEmpty(5_000);
        if (!emptied.ok) {
          throw new Error(emptied.error ?? "PTY Job Object remained non-empty");
        }
      },
      dispose: () => scope.close(),
    };
  }

  return {
    mechanism: "process-group",
    processGroupId: String(rootPid),
    establish: async () => {
      if (!Number.isInteger(rootPid) || rootPid <= 1) return false;
      try {
        process.kill(-rootPid, 0);
        return true;
      } catch {
        return false;
      }
    },
    hasChildren: async () => (await listDirectChildren(rootPid)).length > 0,
    close: async () => gracefulKillProcessTree(rootPid),
    dispose: () => {
      try {
        process.kill(-rootPid, "SIGKILL");
      } catch {
        /* process group is already gone */
      }
    },
  };
}
