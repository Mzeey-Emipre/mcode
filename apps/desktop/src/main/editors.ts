/**
 * Editor detection and launch utilities.
 * Detects installed code editors by checking CLI availability,
 * and provides functions to open projects in them.
 */

import { execFileSync, spawn } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { shell } from "electron";

/** Supported editor identifiers. */
export type EditorId = "code" | "cursor" | "zed";

interface EditorMeta {
  readonly id: EditorId;
  readonly label: string;
  /** Known install paths to check when the CLI is not on PATH (Windows). */
  readonly windowsPaths?: readonly string[];
}

const KNOWN_EDITORS: readonly EditorMeta[] = [
  {
    id: "code",
    label: "VS Code",
    windowsPaths: [
      join(process.env.LOCALAPPDATA ?? "", "Programs", "Microsoft VS Code", "bin", "code.cmd"),
    ],
  },
  {
    id: "cursor",
    label: "Cursor",
    windowsPaths: [
      join(process.env.LOCALAPPDATA ?? "", "Programs", "cursor", "resources", "app", "bin", "cursor.cmd"),
      join(process.env.LOCALAPPDATA ?? "", "Programs", "Cursor", "resources", "app", "bin", "cursor.cmd"),
    ],
  },
  {
    id: "zed",
    label: "Zed",
    windowsPaths: [
      join(process.env.LOCALAPPDATA ?? "", "Programs", "Zed", "bin", "zed.exe"),
      join(process.env.LOCALAPPDATA ?? "", "Zed", "bin", "zed.exe"),
    ],
  },
] as const;

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
 * Find the executable path for an editor.
 * First checks PATH, then falls back to known install locations on Windows.
 * Returns the resolved command string, or null if not found.
 */
function findEditorCommand(editor: EditorMeta): string | null {
  if (commandOnPath(editor.id)) return editor.id;

  if (process.platform === "win32" && editor.windowsPaths) {
    for (const p of editor.windowsPaths) {
      if (existsSync(p)) return p;
    }
  }

  return null;
}

/** Map from editor ID to resolved executable path. */
let resolvedEditors: Map<EditorId, string> | null = null;

/**
 * Detect which supported editors are installed.
 * Results are cached after the first call; pass `force` to re-detect.
 */
export function detectEditors(force = false): EditorId[] {
  if (resolvedEditors !== null && !force) {
    return [...resolvedEditors.keys()];
  }

  resolvedEditors = new Map();
  for (const editor of KNOWN_EDITORS) {
    const cmd = findEditorCommand(editor);
    if (cmd) resolvedEditors.set(editor.id, cmd);
  }

  return [...resolvedEditors.keys()];
}

/**
 * Open a directory in the given editor.
 * Spawns the editor as a detached process so it outlives the app.
 * On Windows, .cmd files are invoked via cmd.exe with
 * windowsVerbatimArguments to prevent shell injection.
 */
export function openInEditor(editor: EditorId, dirPath: string): void {
  const cmd = resolvedEditors?.get(editor);
  if (!cmd) {
    throw new Error(`Editor not detected: ${editor}. Call detectEditors() first.`);
  }

  let child;
  if (process.platform === "win32" && cmd.endsWith(".cmd")) {
    child = spawn("cmd.exe", ["/c", cmd, dirPath], {
      detached: true,
      stdio: "ignore",
      windowsVerbatimArguments: true,
    });
  } else {
    child = spawn(cmd, [dirPath], {
      detached: true,
      stdio: "ignore",
    });
  }
  child.unref();
}

/**
 * Open a directory in the system file explorer.
 * Cross-platform via Electron's shell.openPath().
 */
export async function openInExplorer(dirPath: string): Promise<void> {
  await shell.openPath(dirPath);
}
