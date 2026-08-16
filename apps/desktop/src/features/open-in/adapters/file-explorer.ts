/**
 * File Explorer adapter for the Open-in app registry. Reveals a path in the OS
 * file browser via Electron's `shell.openPath`. Always available, so detection
 * is unconditionally true.
 */

import { shell } from "electron";
import type { LaunchTarget, OpenInAdapter } from "../contracts/types.js";

/** Stable id for the system file manager adapter. */
export const FILE_EXPLORER_ID = "explorer";

/** Build the File Explorer adapter. */
export function createFileExplorerAdapter(): OpenInAdapter {
  return {
    id: FILE_EXPLORER_ID,
    label: "File Explorer",
    kind: "fileManager",
    iconKey: "explorer",

    detect() {
      return true;
    },

    async launch(target: LaunchTarget): Promise<void> {
      // Matches the prior open-in-explorer behavior: shell.openPath resolves
      // with an error string rather than rejecting, and that string was never
      // surfaced. Path validity is enforced upstream by the IPC handler.
      await shell.openPath(target.path);
    },
  };
}
