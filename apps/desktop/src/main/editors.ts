/**
 * Editor detection and launch utilities.
 * Detects installed code editors by checking CLI availability,
 * and provides functions to open projects in them.
 */

import { execFileSync, spawn } from "child_process";
import { shell } from "electron";

/** Supported editor identifiers. */
export type EditorId = "code" | "cursor" | "zed";

interface EditorMeta {
  readonly id: EditorId;
  readonly label: string;
}

const KNOWN_EDITORS: readonly EditorMeta[] = [
  { id: "code", label: "VS Code" },
  { id: "cursor", label: "Cursor" },
  { id: "zed", label: "Zed" },
] as const;

/** Check whether a CLI command exists on the system PATH. */
function commandExists(cmd: string): boolean {
  const checkCmd = process.platform === "win32" ? "where" : "which";
  try {
    execFileSync(checkCmd, [cmd], { stdio: "pipe", encoding: "utf-8" });
    return true;
  } catch {
    return false;
  }
}

let cachedEditors: EditorId[] | null = null;

/**
 * Detect which supported editors are installed.
 * Results are cached after the first call; pass `force` to re-detect.
 */
export function detectEditors(force = false): EditorId[] {
  if (cachedEditors !== null && !force) return cachedEditors;
  cachedEditors = KNOWN_EDITORS
    .filter((e) => commandExists(e.id))
    .map((e) => e.id);
  return cachedEditors;
}

/**
 * Open a directory in the given editor.
 * Spawns the editor as a detached process so it outlives the app.
 */
export function openInEditor(editor: EditorId, dirPath: string): void {
  const child = spawn(editor, [dirPath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

/**
 * Open a directory in the system file explorer.
 * Cross-platform via Electron's shell.openPath().
 */
export async function openInExplorer(dirPath: string): Promise<void> {
  await shell.openPath(dirPath);
}
