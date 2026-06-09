/**
 * Production wiring for the Open-in app registry. Declares the known editors and
 * File Explorer as adapters and exports a singleton registry the IPC layer reads
 * from. Adding an openable app means adding an adapter here — nowhere else.
 */

import { join } from "path";
import { createEditorAdapter, type EditorAdapterConfig } from "./editor-adapter.js";
import { createFileExplorerAdapter } from "./file-explorer-adapter.js";
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

/** Singleton registry: editors first (menu order), then File Explorer. */
export const openInRegistry = new OpenInRegistry([
  ...EDITOR_CONFIGS.map(createEditorAdapter),
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
