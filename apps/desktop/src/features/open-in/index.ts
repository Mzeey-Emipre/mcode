/**
 * Production wiring for the Open-in app registry. Declares the known editors,
 * git GUIs, terminals, and File Explorer as adapters and exports a singleton
 * registry the IPC layer reads from. Adding an openable app means adding an
 * adapter here — nowhere else.
 */

import { join } from "path";
import { createEditorAdapter, type EditorAdapterConfig } from "./adapters/editor.js";
import { createGitGuiAdapter, type GitGuiAdapterConfig } from "./adapters/git-gui.js";
import { createFileExplorerAdapter } from "./adapters/file-explorer.js";
import {
  createTerminalAdapter,
  type TerminalAdapterConfig,
} from "./adapters/terminal.js";
import { OpenInRegistry } from "./registry/registry.js";

/**
 * Candidate `devenv.exe` locations for Visual Studio across editions and years.
 * Visual Studio has no PATH command, so detection relies entirely on these.
 */
function visualStudioPaths(): string[] {
  const roots = [
    join(process.env.ProgramFiles ?? "C:\\Program Files", "Microsoft Visual Studio"),
    join(
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
        paths.push(join(root, year, edition, "Common7", "IDE", "devenv.exe"));
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

/** Known git GUIs. GitHub Desktop adds a `github` PATH command on install. */
const GIT_GUI_CONFIGS: readonly GitGuiAdapterConfig[] = [
  {
    id: "github-desktop",
    label: "GitHub Desktop",
    iconKey: "githubDesktop",
    command: "github",
    windowsPaths: [
      join(process.env.LOCALAPPDATA ?? "", "GitHubDesktop", "bin", "github.bat"),
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

/**
 * Singleton registry: editors, then git GUIs, then terminals, then File Explorer
 * (menu order).
 */
export const openInRegistry = new OpenInRegistry([
  ...EDITOR_CONFIGS.map(createEditorAdapter),
  ...GIT_GUI_CONFIGS.map(createGitGuiAdapter),
  ...TERMINAL_CONFIGS.map((c) => createTerminalAdapter(c)),
  createFileExplorerAdapter(),
]);

export { OpenInRegistry } from "./registry/registry.js";
export type { OpenInAppStatus } from "./registry/registry.js";
export type {
  LaunchTarget,
  OpenInAdapter,
  OpenInAppKind,
  OpenInAppMeta,
} from "./contracts/types.js";
