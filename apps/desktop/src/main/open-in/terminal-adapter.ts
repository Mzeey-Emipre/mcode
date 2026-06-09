/**
 * Terminal adapters for the Open-in app registry. Each terminal (Windows
 * Terminal, Git Bash, WSL) launches an external terminal emulator at the target
 * working directory. Per ADR-0006 these are ordinary registry adapters that
 * resolve their own environment — they do NOT share the server's
 * `ShellEnvResolver`, which stays a PTY-only concern.
 *
 * Detection and launch-argument shaping live here (the testable surface); the
 * leaf spawn is a thin fire-and-forget shim matching the editor adapters.
 */

import { execFileSync, spawn, type ChildProcess } from "child_process";
import { existsSync } from "fs";
import type { LaunchTarget, OpenInAdapter } from "./types.js";

/** IDs of the external terminals we detect and can launch. */
export type TerminalId = "windows-terminal" | "git-bash" | "wsl";

/** Static declaration for a terminal adapter. */
export interface TerminalAdapterConfig {
  readonly id: TerminalId;
  readonly label: string;
  /** Renderer-side icon key (resolved to a component in the renderer). */
  readonly iconKey: string;
  /** Executable/command name checked on PATH and spawned when found. */
  readonly command: string;
  /** Absolute fallback executable paths checked on Windows when not on PATH. */
  readonly windowsPaths?: readonly string[];
}

/**
 * Injectable system probes. Defaults hit the real OS; tests pass fakes so
 * detection and launch can be exercised without spawning anything or depending
 * on which terminals happen to be installed on the test machine.
 */
export interface TerminalAdapterDeps {
  /** Whether a command resolves on the system PATH. */
  commandOnPath(cmd: string): boolean;
  /** Whether an absolute path exists on disk. */
  fileExists(path: string): boolean;
  /** Spawn a detached child process. */
  spawn: typeof spawn;
  /** Host platform (terminals here are Windows-only). */
  platform: NodeJS.Platform;
}

/** Check whether a command exists on the system PATH. */
function commandOnPathReal(cmd: string): boolean {
  const checkCmd = process.platform === "win32" ? "where" : "which";
  try {
    execFileSync(checkCmd, [cmd], { stdio: "pipe", encoding: "utf-8" });
    return true;
  } catch {
    return false;
  }
}

const REAL_DEPS: TerminalAdapterDeps = {
  commandOnPath: commandOnPathReal,
  fileExists: existsSync,
  spawn,
  platform: process.platform,
};

/**
 * Quote a token for a `shell: true` spawn on Windows. cmd.exe joins the command
 * and args into a single line and applies no quoting of its own, so a token
 * containing whitespace or a shell metacharacter (`& | < > ^ ( )`) would be
 * split — or, for metacharacters, interpreted by cmd.exe (command injection).
 * Wrapping such a token in double quotes neutralizes both; Windows paths cannot
 * contain `"`, so quoting is lossless. Tokens needing no quoting are unchanged.
 */
function quoteForShell(token: string): string {
  return /[\s&|<>^()]/.test(token) ? `"${token}"` : token;
}

/**
 * Build the CLI arguments to launch a terminal at a working directory. Pure
 * function — the highest-value test target. The arg shapes follow ADR-0006:
 * Windows Terminal `-d <dir>`, WSL `--cd <dir>`, Git Bash `--cd=<dir>`.
 */
export function buildTerminalArgs(terminal: TerminalId, dir: string): string[] {
  switch (terminal) {
    case "windows-terminal":
      return ["-d", dir];
    case "wsl":
      return ["--cd", dir];
    case "git-bash":
      return [`--cd=${dir}`];
  }
}

/**
 * Build a terminal adapter from a static config. The resolved executable is
 * memoized on first detection so {@link OpenInAdapter.launch} reuses it without a
 * second PATH lookup. External terminals are a Windows concern here, so
 * detection is always false off Windows.
 */
export function createTerminalAdapter(
  config: TerminalAdapterConfig,
  deps: TerminalAdapterDeps = REAL_DEPS,
): OpenInAdapter {
  // `undefined` = not yet resolved; `null` = resolved as not installed.
  let resolvedCommand: string | null | undefined;

  function resolveCommand(): string | null {
    if (resolvedCommand !== undefined) return resolvedCommand;
    if (deps.platform !== "win32") {
      resolvedCommand = null;
      return resolvedCommand;
    }
    if (deps.commandOnPath(config.command)) {
      resolvedCommand = config.command;
      return resolvedCommand;
    }
    for (const p of config.windowsPaths ?? []) {
      if (deps.fileExists(p)) {
        resolvedCommand = p;
        return resolvedCommand;
      }
    }
    resolvedCommand = null;
    return resolvedCommand;
  }

  return {
    id: config.id,
    label: config.label,
    kind: "terminal",
    iconKey: config.iconKey,

    detect() {
      return resolveCommand() !== null;
    },

    launch(target: LaunchTarget): Promise<void> {
      const cmd = resolveCommand();
      if (!cmd) {
        return Promise.reject(new Error(`Terminal not detected: ${config.id}`));
      }

      const args = buildTerminalArgs(config.id, target.path);

      // shell:true lets PATH aliases like `wt` and the git-bash launcher resolve,
      // but cmd.exe concatenates the command and args into one unquoted line. The
      // launcher path ("Program Files") and the target directory can both carry
      // spaces or shell metacharacters, so quote every token that needs it; bare
      // tokens (`wt`, `-d`, a space-free path) pass through untouched.
      const spawnCmd = quoteForShell(cmd);
      const spawnArgs = args.map(quoteForShell);

      return new Promise<void>((resolve, reject) => {
        // Terminal executables on Windows (wt.exe, wsl.exe, git-bash.exe) launch
        // their own window and resolve their own environment; we fire and forget.
        const child: ChildProcess = deps.spawn(spawnCmd, spawnArgs, {
          detached: true,
          stdio: "ignore",
          shell: true,
        });

        child.on("error", (err: Error) => reject(new Error(err.message)));
        // The "spawn" event fires once the child process has been created.
        child.on("spawn", () => {
          child.unref();
          resolve();
        });
      });
    },
  };
}
