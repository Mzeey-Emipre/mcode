import type * as NodeChildProcess from "node:child_process";
import type * as NodeFS from "node:fs";

/** Inputs that register server child exit handling. */
export interface ServerExitHandlerOptions {
  child: NodeChildProcess.ChildProcess;
  stderrStream: NodeFS.WriteStream | undefined;
  plannedExitProcesses: Set<NodeChildProcess.ChildProcess>;
  isCurrentProcess: () => boolean;
  clearCurrentProcess: () => void;
  onChildExit: () => void;
  onUnexpectedExit: (code: number | null) => void;
}

/** Attach cleanup and unexpected-exit handling to a spawned server child. */
export function attachServerExitHandler(
  options: ServerExitHandlerOptions,
): void {
  options.child.on("exit", (code) => {
    console.error(`Server process exited with code ${code}`);
    options.stderrStream?.end();
    options.onChildExit();
    const wasPlannedExit = options.plannedExitProcesses.delete(options.child);
    if (!options.isCurrentProcess()) return;
    options.clearCurrentProcess();
    if (!wasPlannedExit) options.onUnexpectedExit(code);
  });
}

/** Coalesce planned restarts and mark only their replaced child as intentional. */
export class PlannedRestartCoordinator {
  private inFlight: Promise<void> | null = null;

  /** Run one planned restart and return any concurrent caller to the same work. */
  restart(
    isReusedExisting: boolean,
    currentProcess: NodeChildProcess.ChildProcess | null,
    plannedExitProcesses: Set<NodeChildProcess.ChildProcess>,
    runRestart: () => Promise<void>,
  ): Promise<void> {
    if (isReusedExisting) {
      return Promise.reject(
        new Error("Cannot plan a restart for an unowned server"),
      );
    }
    if (this.inFlight) return this.inFlight;
    if (currentProcess) plannedExitProcesses.add(currentProcess);
    this.inFlight = this.runRestart(
      currentProcess,
      plannedExitProcesses,
      runRestart,
    );
    return this.inFlight;
  }

  /** Clear the planned exit mark if the restart did not replace its child. */
  private runRestart(
    oldProcess: NodeChildProcess.ChildProcess | null,
    plannedExitProcesses: Set<NodeChildProcess.ChildProcess>,
    runRestart: () => Promise<void>,
  ): Promise<void> {
    let restartPromise: Promise<void>;
    restartPromise = runRestart()
      .catch((error) => {
        if (oldProcess) plannedExitProcesses.delete(oldProcess);
        throw error;
      })
      .finally(() => {
        if (this.inFlight === restartPromise) this.inFlight = null;
      });
    return restartPromise;
  }
}
