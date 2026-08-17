import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { WindowsProcessScopeFactory } from "../../../runtime/process/containment/windows-process-scope.js";
import type { PtyHostChild } from "./pty-host-supervisor.js";

/** Options for the isolated Node PTY host child process. */
export interface SpawnPtyHostChildOptions {
  readonly entryPath: string;
  readonly executablePath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly onStderr?: (text: string) => void;
}

/** Resolves the sibling bundled PTY host entry used by the server bundle. */
export function resolvePtyHostEntryPath(serverEntryPath: string): string {
  return resolve(dirname(serverEntryPath), "pty-host.cjs");
}

/** Spawns the separate PTY host with one inherited Node IPC channel. */
export function spawnPtyHostChild(
  options: SpawnPtyHostChildOptions,
): PtyHostChild {
  const child = spawn(
    options.executablePath ?? process.execPath,
    [options.entryPath],
    {
      env: options.env ?? process.env,
      stdio: ["ignore", "ignore", options.onStderr ? "pipe" : "ignore", "ipc"],
      detached: process.platform !== "win32",
      windowsHide: true,
    },
  );
  let disposeContainment: () => void;
  if (process.platform === "win32" && child.pid) {
    const hostScope = new WindowsProcessScopeFactory().create();
    const assigned = hostScope.assign(child.pid);
    if (!assigned.ok) {
      child.kill("SIGKILL");
      hostScope.close();
      throw new Error(
        assigned.error ?? "Could not contain the isolated PTY host process",
      );
    }
    disposeContainment = () => hostScope.close();
  } else if (child.pid) {
    const hostProcessGroupId = child.pid;
    disposeContainment = () => {
      try {
        process.kill(-hostProcessGroupId, "SIGKILL");
      } catch {
        // The host process group is already empty.
      }
    };
  } else {
    disposeContainment = () => undefined;
  }
  if (options.onStderr) {
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", options.onStderr);
  }
  return Object.assign(child, {
    disposeContainment,
  }) as unknown as PtyHostChild;
}
