/**
 * Production wiring for the Open-in app registry. Declares the known editors and
 * File Explorer as adapters and exports a singleton registry the IPC layer reads
 * from. Adding an openable app means adding an adapter here — nowhere else.
 */

import { join } from "path";
import { createEditorAdapter, type EditorAdapterConfig } from "./editor-adapter.js";
import { createFileExplorerAdapter } from "./file-explorer-adapter.js";
import {
  createTerminalAdapter,
  type TerminalAdapterConfig,
} from "./terminal-adapter.js";
import { OpenInRegistry } from "./registry.js";

/** Known editors, with Windows fallback install paths for PATH-less setups. */
const EDITOR_CONFIGS: readonly EditorAdapterConfig[] = [
  {
    id: "code",
    label: "VS Code",
    iconKey: "vscode",
    windowsPaths: [
      join(
        process.env.LOCALAPPDATA ?? "",
        "Programs",
        "Microsoft VS Code",
        "bin",
        "code.cmd",
      ),
    ],
  },
  {
    id: "cursor",
    label: "Cursor",
    iconKey: "cursor",
    windowsPaths: [
      join(
        process.env.LOCALAPPDATA ?? "",
        "Programs",
        "cursor",
        "resources",
        "app",
        "bin",
        "cursor.cmd",
      ),
      join(
        process.env.LOCALAPPDATA ?? "",
        "Programs",
        "Cursor",
        "resources",
        "app",
        "bin",
        "cursor.cmd",
      ),
    ],
  },
  {
    id: "zed",
    label: "Zed",
    iconKey: "zed",
    windowsPaths: [
      join(process.env.LOCALAPPDATA ?? "", "Programs", "Zed", "bin", "zed.exe"),
      join(process.env.LOCALAPPDATA ?? "", "Zed", "bin", "zed.exe"),
    ],
  },
];

/**
 * Known external terminals, with Windows fallback install paths for setups where
 * the launcher is not on PATH (Git Bash in particular ships no PATH entry).
 */
const TERMINAL_CONFIGS: readonly TerminalAdapterConfig[] = [
  {
    id: "windows-terminal",
    label: "Windows Terminal",
    iconKey: "windows-terminal",
    command: "wt",
    windowsPaths: [
      join(
        process.env.LOCALAPPDATA ?? "",
        "Microsoft",
        "WindowsApps",
        "wt.exe",
      ),
    ],
  },
  {
    id: "git-bash",
    label: "Git Bash",
    iconKey: "git-bash",
    command: "git-bash",
    windowsPaths: [
      join(process.env.ProgramFiles ?? "", "Git", "git-bash.exe"),
      join(process.env["ProgramFiles(x86)"] ?? "", "Git", "git-bash.exe"),
      join(
        process.env.LOCALAPPDATA ?? "",
        "Programs",
        "Git",
        "git-bash.exe",
      ),
    ],
  },
  {
    id: "wsl",
    label: "WSL",
    iconKey: "wsl",
    command: "wsl",
    windowsPaths: [
      join(process.env.SystemRoot ?? "", "System32", "wsl.exe"),
    ],
  },
];

/** Singleton registry: editors, then terminals, then File Explorer (menu order). */
export const openInRegistry = new OpenInRegistry([
  ...EDITOR_CONFIGS.map(createEditorAdapter),
  ...TERMINAL_CONFIGS.map((c) => createTerminalAdapter(c)),
  createFileExplorerAdapter(),
]);

export { OpenInRegistry } from "./registry.js";
export type { OpenInAppStatus } from "./registry.js";
export type {
  LaunchTarget,
  OpenInAdapter,
  OpenInAppKind,
  OpenInAppMeta,
} from "./types.js";
