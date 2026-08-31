/**
 * Git GUI adapters for the Open-in app registry. A git GUI opens a *repository*
 * (not a file or arbitrary folder), so its launch passes the repo root path
 * straight through to the app's CLI. Detection and launch are owned here rather
 * than inlined in the IPC layer.
 */

import type { LaunchTarget, OpenInAdapter } from "../contracts/types.js";
import { createExecutableResolver, spawnDetached } from "../launch/spawn-launch.js";

/** Static declaration for a git GUI adapter. */
export interface GitGuiAdapterConfig {
  /** Stable registry id (e.g. "github-desktop"). */
  readonly id: string;
  readonly label: string;
  /** Renderer-side icon key (resolved to a component in the renderer). */
  readonly iconKey: string;
  /** PATH command that opens a repo at the given path (e.g. "github"). */
  readonly command: string;
  /** Absolute fallback executable paths checked on Windows when not on PATH. */
  readonly windowsPaths?: readonly string[];
}

/**
 * Build a git GUI adapter from a static config. The resolved executable path is
 * memoized on first detection so {@link OpenInAdapter.launch} reuses it without a
 * second PATH lookup.
 */
export function createGitGuiAdapter(
  config: GitGuiAdapterConfig,
  platform: NodeJS.Platform,
): OpenInAdapter {
  const resolveCommand = createExecutableResolver(config.command, platform, config.windowsPaths);

  return {
    id: config.id,
    label: config.label,
    kind: "gitGui",
    iconKey: config.iconKey,

    detect() {
      return resolveCommand() !== null;
    },

    launch(target: LaunchTarget): Promise<void> {
      const cmd = resolveCommand();
      if (!cmd) {
        return Promise.reject(new Error(`Git GUI not detected: ${config.id}`));
      }
      return spawnDetached(cmd, [target.path], platform);
    },
  };
}
