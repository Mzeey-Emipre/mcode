/**
 * Shared detection and launch primitives for spawn-based open-in adapters
 * (editors, git GUIs, and future terminal kinds). Each adapter owns its CLI
 * arguments and metadata; the executable resolution and the detached
 * fire-and-forget spawn are identical across them and live here.
 */

import { execFileSync, spawn, type ChildProcess } from "child_process";
import { existsSync } from "fs";

/** Check whether a CLI command exists on the system PATH. */
export function commandOnPath(cmd: string): boolean {
  const checkCmd = process.platform === "win32" ? "where" : "which";
  try {
    execFileSync(checkCmd, [cmd], { stdio: "pipe", encoding: "utf-8" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a memoized resolver for an app's executable: the PATH command when it
 * exists, otherwise the first existing Windows fallback path, or `null` when the
 * app is not installed. The result is cached on first call so detection and a
 * subsequent launch never repeat the PATH lookup.
 */
export function createExecutableResolver(
  command: string,
  windowsPaths?: readonly string[],
): () => string | null {
  // `undefined` = not yet resolved; `null` = resolved as not installed.
  let resolved: string | null | undefined;
  return () => {
    if (resolved !== undefined) return resolved;
    if (commandOnPath(command)) {
      resolved = command;
      return resolved;
    }
    if (process.platform === "win32" && windowsPaths) {
      for (const p of windowsPaths) {
        if (existsSync(p)) {
          resolved = p;
          return resolved;
        }
      }
    }
    resolved = null;
    return resolved;
  };
}

const WINDOWS_COMMAND_SLOT = "MCODE_OPEN_IN_COMMAND";
const WINDOWS_ARGUMENT_SLOT_PREFIX = "MCODE_OPEN_IN_ARG_";

function quoteForWindowsCommand(token: string): string {
  return `"${token}"`;
}

function spawnWindowsCommand(
  cmd: string,
  args: string[],
  spawnProcess: typeof spawn,
): ChildProcess {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    [WINDOWS_COMMAND_SLOT]: quoteForWindowsCommand(cmd),
  };
  const commandSlots = args.map((arg, index) => {
    const slot = `${WINDOWS_ARGUMENT_SLOT_PREFIX}${index}`;
    env[slot] = quoteForWindowsCommand(arg);
    return `!${slot}!`;
  });
  const fixedCommand = [`!${WINDOWS_COMMAND_SLOT}!`, ...commandSlots].join(" ");

  return spawnProcess("cmd.exe", ["/d", "/v:on", "/s", "/c", fixedCommand], {
    detached: true,
    stdio: "ignore",
    shell: false,
    windowsVerbatimArguments: true,
    env,
  });
}

/**
 * Spawn a detached, fire-and-forget child process and resolve once it has been
 * created.
 *
 * On Windows, an absolute path to an `.exe` is spawned directly. Bare PATH
 * commands and `.cmd`/`.bat` shims run through a fixed `cmd.exe` command while
 * the executable and arguments remain in child environment slots. This keeps
 * shell metacharacters out of the command string.
 *
 * @param platform Platform selected by the owning adapter.
 * @param spawnProcess Injectable process boundary used by focused tests.
 */
export function spawnDetached(
  cmd: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  spawnProcess: typeof spawn = spawn,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let child: ChildProcess;
    if (platform === "win32" && /\.exe$/i.test(cmd)) {
      child = spawnProcess(cmd, args, { detached: true, stdio: "ignore" });
    } else if (platform === "win32") {
      child = spawnWindowsCommand(cmd, args, spawnProcess);
    } else {
      child = spawnProcess(cmd, args, { detached: true, stdio: "ignore" });
    }

    child.on("error", (err: Error) => reject(new Error(err.message)));
    // The "spawn" event fires once the child process has been created.
    child.on("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
