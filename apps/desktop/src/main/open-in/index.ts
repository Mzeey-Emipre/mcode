/**
 * Production wiring for the Open-in app registry. Declares the known editors,
 * git GUIs, and File Explorer as adapters and exports a singleton registry the
 * IPC layer reads from. Adding an openable app means adding an adapter here —
 * nowhere else.
 */

import { join } from "path";
import { createEditorAdapter, type EditorAdapterConfig } from "./editor-adapter.js";
import { createGitGuiAdapter, type GitGuiAdapterConfig } from "./git-gui-adapter.js";
import { createFileExplorerAdapter } from "./file-explorer-adapter.js";
import { OpenInRegistry } from "./registry.js";

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

/** Singleton registry: editors, then git GUIs, then File Explorer (menu order). */
export const openInRegistry = new OpenInRegistry([
  ...EDITOR_CONFIGS.map(createEditorAdapter),
  ...GIT_GUI_CONFIGS.map(createGitGuiAdapter),
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
export { FILE_EXPLORER_ID } from "./file-explorer-adapter.js";
