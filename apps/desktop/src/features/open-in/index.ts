/**
 * Production wiring for the Open-in app registry. Declares the known editors,
 * git GUIs, terminals, and File Explorer as adapters. Adding an openable app
 * means adding an adapter here — nowhere else.
 */

import * as NodePath from "node:path";
import { createEditorAdapter, type EditorAdapterConfig } from "./adapters/editor.js";
import { createGitGuiAdapter, type GitGuiAdapterConfig } from "./adapters/git-gui.js";
import { createFileExplorerAdapter } from "./adapters/file-explorer.js";
import {
  createTerminalAdapter,
  type TerminalAdapterConfig,
} from "./adapters/terminal.js";
import {
  registerOpenInHandlers as registerOpenInHandlersForRegistry,
  type OpenInIpc,
} from "./ipc/handlers.js";
import { OpenInRegistry } from "./registry/registry.js";

/**
 * Candidate `devenv.exe` locations for Visual Studio across editions and years.
 * Visual Studio has no PATH command, so detection relies entirely on these.
 */
function visualStudioPaths(): string[] {
  const roots = [
    NodePath.join(process.env.ProgramFiles ?? "C:\\Program Files", "Microsoft Visual Studio"),
    NodePath.join(
      process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
      "Microsoft Visual Studio",
    ),
  ];
  const years = ["2022", "2019"];
  const editions = ["Enterprise", "Professional", "Community"];
  const paths: string[] = [];
  for (const root of roots) {
    for (const year of years) {
      for (const edition of editions) {
        paths.push(NodePath.join(root, year, edition, "Common7", "IDE", "devenv.exe"));
      }
    }
  }
  return paths;
}

/** Known editors, with Windows fallback install paths for PATH-less setups. */
const EDITOR_CONFIGS: readonly EditorAdapterConfig[] = [
  {
    id: "code",
    label: "VS Code",
    iconKey: "vscode",
    windowsPaths: [
      NodePath.join(
        process.env.LOCALAPPDATA ?? "",
        "Programs",
        "Microsoft VS Code",
        "bin",
        "code.cmd",
      ),
    ],
  },
  {
    id: "vs",
    label: "Visual Studio",
    iconKey: "visualstudio",
    windowsPaths: visualStudioPaths(),
  },
  {
    id: "cursor",
    label: "Cursor",
    iconKey: "cursor",
    windowsPaths: [
      NodePath.join(
        process.env.LOCALAPPDATA ?? "",
        "Programs",
        "cursor",
        "resources",
        "app",
        "bin",
        "cursor.cmd",
      ),
      NodePath.join(
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
      NodePath.join(process.env.LOCALAPPDATA ?? "", "Programs", "Zed", "bin", "zed.exe"),
      NodePath.join(process.env.LOCALAPPDATA ?? "", "Zed", "bin", "zed.exe"),
    ],
  },
];

/** Known git GUIs. GitHub Desktop adds a `github` PATH command on install. */
const GIT_GUI_CONFIGS: readonly GitGuiAdapterConfig[] = [
  {
    id: "github-desktop",
    label: "GitHub Desktop",
    iconKey: "githubDesktop",
    command: "github",
    windowsPaths: [
      NodePath.join(process.env.LOCALAPPDATA ?? "", "GitHubDesktop", "bin", "github.bat"),
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
      NodePath.join(
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
      NodePath.join(process.env.ProgramFiles ?? "", "Git", "git-bash.exe"),
      NodePath.join(process.env["ProgramFiles(x86)"] ?? "", "Git", "git-bash.exe"),
      NodePath.join(
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
      NodePath.join(process.env.SystemRoot ?? "", "System32", "wsl.exe"),
    ],
  },
];

/**
 * Create the registry in menu order for the platform selected by app composition.
 */
export function createOpenInRegistry(platform: NodeJS.Platform): OpenInRegistry {
  return new OpenInRegistry([
    ...EDITOR_CONFIGS.map((config) => createEditorAdapter(config, platform)),
    ...GIT_GUI_CONFIGS.map((config) => createGitGuiAdapter(config, platform)),
    ...TERMINAL_CONFIGS.map((config) => createTerminalAdapter(config, platform)),
    createFileExplorerAdapter(),
  ]);
}

/** Register Open In handlers with the configured registry. */
export function registerOpenInHandlers(
  ipcMain: OpenInIpc,
  platform: NodeJS.Platform,
): void {
  registerOpenInHandlersForRegistry({
    ipcMain,
    registry: createOpenInRegistry(platform),
  });
}

export { OpenInRegistry } from "./registry/registry.js";
export type { OpenInIpc } from "./ipc/handlers.js";
export type { OpenInAppStatus } from "./registry/registry.js";
export type {
  LaunchTarget,
  OpenInAdapter,
  OpenInAppKind,
  OpenInAppMeta,
} from "./contracts/types.js";
