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

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import type { LaunchTarget, OpenInAdapter } from "../contracts/types.js";
import { commandOnPath, spawnDetached } from "../launch/spawn-launch.js";

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
  spawn: typeof NodeChildProcess.spawn;
}

const REAL_DEPS: Omit<TerminalAdapterDeps, "commandOnPath"> = {
  fileExists: NodeFS.existsSync,
  spawn: NodeChildProcess.spawn,
};

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
  platform: NodeJS.Platform,
  deps: TerminalAdapterDeps = {
    ...REAL_DEPS,
    commandOnPath: (command) => commandOnPath(command, platform),
  },
): OpenInAdapter {
  // `undefined` = not yet resolved; `null` = resolved as not installed.
  let resolvedCommand: string | null | undefined;

  function resolveCommand(): string | null {
    if (resolvedCommand !== undefined) return resolvedCommand;
    if (platform !== "win32") {
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

      return spawnDetached(cmd, args, platform, deps.spawn);
    },
  };
}
