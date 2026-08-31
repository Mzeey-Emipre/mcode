/**
 * Editor adapters for the Open-in app registry. Each editor declares its id,
 * label, icon key, and Windows fallback install paths; detection and launch
 * (detached spawn with per-editor CLI args) are owned here rather than inlined
 * in the IPC layer.
 */

import { buildEditorArgs, type EditorId } from "../launch/editor-args.js";
import type { LaunchTarget, OpenInAdapter } from "../contracts/types.js";
import { createExecutableResolver, spawnDetached } from "../launch/spawn-launch.js";

/** Static declaration for an editor adapter. */
export interface EditorAdapterConfig {
  readonly id: EditorId;
  readonly label: string;
  /** Renderer-side icon key (resolved to a component in the renderer). */
  readonly iconKey: string;
  /** Absolute fallback executable paths checked on Windows when not on PATH. */
  readonly windowsPaths?: readonly string[];
}

/**
 * Build an editor adapter from a static config. The resolved executable path is
 * memoized on first detection so {@link OpenInAdapter.launch} reuses it without a
 * second PATH lookup.
 */
export function createEditorAdapter(
  config: EditorAdapterConfig,
  platform: NodeJS.Platform,
): OpenInAdapter {
  const resolveCommand = createExecutableResolver(config.id, platform, config.windowsPaths);

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
      return spawnDetached(cmd, buildEditorArgs(config.id, target.path, target.line), platform);
    },
  };
}
