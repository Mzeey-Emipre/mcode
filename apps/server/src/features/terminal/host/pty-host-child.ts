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
  const disposeContainment = createHostContainment(child.pid, () => child.kill("SIGKILL"));
  if (options.onStderr) {
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", options.onStderr);
  }
  return Object.assign(child, {
    disposeContainment,
  }) as unknown as PtyHostChild;
}

function createHostContainment(
  pid: number | undefined,
  terminateOnFailure: () => void,
): () => void {
  if (!pid) return () => undefined;
  if (process.platform === "win32") {
    return createWindowsHostContainment(pid, terminateOnFailure);
  }
  return createPosixHostContainment(pid);
}

function createWindowsHostContainment(pid: number, terminateOnFailure: () => void): () => void {
  const hostScope = new WindowsProcessScopeFactory().create();
  const assigned = hostScope.assign(pid);
  if (!assigned.ok) {
    terminateOnFailure();
    hostScope.close();
    throw new Error(assigned.error ?? "Could not contain the isolated PTY host process");
  }
  return () => hostScope.close();
}

function createPosixHostContainment(processGroupId: number): () => void {
  return () => {
    try {
      process.kill(-processGroupId, "SIGKILL");
    } catch {
      // The host process group is already empty.
    }
  };
}
