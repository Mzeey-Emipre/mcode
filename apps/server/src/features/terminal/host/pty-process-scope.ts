import { killProcessTree } from "../../../runtime/process/containment/process-kill.js";
import { WindowsProcessScopeFactory } from "../../../runtime/process/containment/windows-process-scope.js";
import { createPosixProcessScope } from "./posix-process-scope.js";
import type { PtyProcessScope } from "./pty-host-runtime.js";
import type { HostRuntime } from "@mcode/shared/node/host-runtime";

/** Creates an authoritative process scope for one native PTY. */
export function createPtyProcessScope(
  rootPid: number,
  hostRuntime: Pick<HostRuntime, "platform" | "architecture">,
): PtyProcessScope {
  if (hostRuntime.platform === "win32") {
    const scope = new WindowsProcessScopeFactory(hostRuntime).create();
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
          const [fallbackResult] = await Promise.allSettled([
            killProcessTree(rootPid, { platform: hostRuntime.platform }),
          ]);
          if (fallbackResult.status === "rejected") {
            cleanupErrors.push(fallbackResult.reason);
          }
        }
        const terminated = scope.terminate(0);
        if (!terminated.ok) {
          cleanupErrors.push(
            new Error(
              terminated.error ?? "PTY Job Object termination failed",
            ),
          );
        }
        const emptied = await scope.waitForEmpty(5_000);
        if (!emptied.ok) {
          cleanupErrors.push(
            new Error(emptied.error ?? "PTY Job Object remained non-empty"),
          );
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

  return createPosixProcessScope(rootPid);
}
