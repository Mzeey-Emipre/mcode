/** Electron prerequisite used before installing ABI-specific native modules. */

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ensureElectronBinary } from "./ensure-electron.mjs";

/** Installs Electron when needed and returns its verified executable path. */
export function ensureElectronForPrebuild(desktopRoot) {
  ensureElectronBinary(desktopRoot);

  const desktopRequire = createRequire(resolve(desktopRoot, "package.json"));
  const electronPath = desktopRequire("electron");
  if (!existsSync(electronPath)) {
    throw new Error(`Electron binary unavailable after installation: ${electronPath}`);
  }
  return electronPath;
}
