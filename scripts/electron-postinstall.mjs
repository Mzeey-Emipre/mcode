/** Electron prerequisite used before installing ABI-specific native modules. */

import * as NodeModule from "node:module";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { ensureElectronBinary } from "./ensure-electron.mjs";

/** Installs Electron when needed and returns its verified executable path. */
export function ensureElectronForPrebuild(desktopRoot) {
  ensureElectronBinary(desktopRoot);

  const desktopRequire = NodeModule.createRequire(NodePath.resolve(desktopRoot, "package.json"));
  const electronPath = desktopRequire("electron");
  if (!NodeFS.existsSync(electronPath)) {
    throw new Error(`Electron binary unavailable after installation: ${electronPath}`);
  }
  return electronPath;
}
