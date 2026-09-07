/** Ensure Electron is available for the desktop shell and isolated PTY host. */
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { ensureElectronForPrebuild } from "./electron-postinstall.mjs";

const rootDir = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
if (process.env.SKIP_ELECTRON_REBUILD === "1") {
  console.log("Skipping Electron install check (SKIP_ELECTRON_REBUILD=1)");
} else {
  ensureElectronForPrebuild(NodePath.resolve(rootDir, "apps", "desktop"));
}
