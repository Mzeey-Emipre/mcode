import {
  gracefulKillProcessTree,
  killProcessTree,
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
        const reconciled = await scope.reconcile(rootPid);
        if (!reconciled.ok) return true;
        const snapshot = scope.queryProcessIds();
        if (!snapshot.ok || snapshot.overflow) return true;
        return snapshot.processIds.some((pid) => pid !== rootPid);
      },
      close: async () => {
        const cleanupErrors: unknown[] = [];
        const reconciled = await scope.reconcile(rootPid);
        if (!reconciled.ok) {
          try {
            await killProcessTree(rootPid);
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
        try {
          const terminated = scope.terminate(0);
          if (!terminated.ok) {
            cleanupErrors.push(
              new Error(
                terminated.error ?? "PTY Job Object termination failed",
              ),
            );
          }
        } catch (error) {
          cleanupErrors.push(error);
        }
        try {
          const emptied = await scope.waitForEmpty(5_000);
          if (!emptied.ok) {
            cleanupErrors.push(
              new Error(emptied.error ?? "PTY Job Object remained non-empty"),
            );
          }
        } catch (error) {
          cleanupErrors.push(error);
        }
        if (cleanupErrors.length === 1) {
          throw cleanupErrors[0];
        }
        if (cleanupErrors.length > 1) {
          throw new AggregateError(
            cleanupErrors,
            "PTY process scope cleanup failed",
          );
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
