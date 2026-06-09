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

/**
 * Wrap a token in double quotes for `cmd.exe`. Windows paths cannot contain `"`
 * (it is an illegal filename character), so quoting is both safe and sufficient:
 * spaces stay inside one argument and shell metacharacters such as `&`, `|`, or
 * `^` in a directory name are read literally instead of chaining commands.
 */
function quoteForCmd(token: string): string {
  return `"${token}"`;
}

/**
 * Spawn a detached, fire-and-forget child process and resolve once it has been
 * created.
 *
 * On Windows, an absolute path to an `.exe` (e.g. Visual Studio's `devenv.exe`,
 * which lives under "C:\Program Files\...") is spawned directly so spaces in the
 * path are handled by Node instead of breaking `cmd.exe` word-splitting. Bare
 * PATH commands ("code") and `.cmd`/`.bat` shims still need `shell: true` so
 * Windows can resolve and execute them; with `shell: true` Node forwards the raw
 * argv to `cmd.exe` without quoting, so the executable and every argument are
 * quoted here. That keeps spaced install paths (e.g. "Microsoft VS Code") and
 * spaced target directories intact, and prevents a directory name from injecting
 * a chained command.
 */
export function spawnDetached(cmd: string, args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let child: ChildProcess;
    if (process.platform === "win32" && /\.exe$/i.test(cmd)) {
      child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    } else if (process.platform === "win32") {
      child = spawn(quoteForCmd(cmd), args.map(quoteForCmd), {
        detached: true,
        stdio: "ignore",
        shell: true,
      });
    } else {
      child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    }

    child.on("error", (err: Error) => reject(new Error(err.message)));
    // The "spawn" event fires once the child process has been created.
    child.on("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
