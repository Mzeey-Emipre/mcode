/**
 * Editor adapters for the Open-in app registry. Each editor declares its id,
 * label, icon key, and Windows fallback install paths; detection and launch
 * (detached spawn with per-editor CLI args) are owned here rather than inlined
 * in the IPC layer.
 */

import { execFileSync, spawn, type ChildProcess } from "child_process";
import { existsSync } from "fs";
import { buildEditorArgs, type EditorId } from "../editor-args.js";
import type { LaunchTarget, OpenInAdapter } from "./types.js";

/** Static declaration for an editor adapter. */
export interface EditorAdapterConfig {
  readonly id: EditorId;
  readonly label: string;
  /** Renderer-side icon key (resolved to a component in the renderer). */
  readonly iconKey: string;
  /** Absolute fallback executable paths checked on Windows when not on PATH. */
  readonly windowsPaths?: readonly string[];
}

/** Check whether a CLI command exists on the system PATH. */
function commandOnPath(cmd: string): boolean {
  const checkCmd = process.platform === "win32" ? "where" : "which";
  try {
    execFileSync(checkCmd, [cmd], { stdio: "pipe", encoding: "utf-8" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Build an editor adapter from a static config. The resolved executable path is
 * memoized on first detection so {@link OpenInAdapter.launch} reuses it without a
 * second PATH lookup.
 */
export function createEditorAdapter(config: EditorAdapterConfig): OpenInAdapter {
  // `undefined` = not yet resolved; `null` = resolved as not installed.
  let resolvedCommand: string | null | undefined;

  function resolveCommand(): string | null {
    if (resolvedCommand !== undefined) return resolvedCommand;
    if (commandOnPath(config.id)) {
      resolvedCommand = config.id;
      return resolvedCommand;
    }
    if (process.platform === "win32" && config.windowsPaths) {
      for (const p of config.windowsPaths) {
        if (existsSync(p)) {
          resolvedCommand = p;
          return resolvedCommand;
        }
      }
    }
    resolvedCommand = null;
    return resolvedCommand;
  }

  return {
    id: config.id,
    label: config.label,
    kind: "editor",
    iconKey: config.iconKey,

    detect() {
      return resolveCommand() !== null;
    },

    launch(target: LaunchTarget): Promise<void> {
      const cmd = resolveCommand();
      if (!cmd) {
        return Promise.reject(new Error(`Editor not detected: ${config.id}`));
      }

      const args = buildEditorArgs(config.id, target.path, target.line);

      return new Promise<void>((resolve, reject) => {
        let child: ChildProcess;
        // On Windows, editor shims (e.g. "code") are .cmd scripts. shell: true
        // lets Node quote arguments safely instead of hand-rolling cmd.exe /c.
        if (process.platform === "win32") {
          child = spawn(cmd, args, { detached: true, stdio: "ignore", shell: true });
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
    },
  };
}
