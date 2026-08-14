/**
 * Ensure the workspace Electron binary is downloaded before desktop dev or prod.
 * Bun may skip electron's postinstall when ELECTRON_SKIP_BINARY_DOWNLOAD=1 (CI);
 * this restores the binary for local desktop workflows.
 */

import { execFileSync } from "child_process";
import { createRequire } from "module";
import { existsSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");

/** Maximum time allowed for one Electron binary download attempt. */
export const ELECTRON_INSTALL_TIMEOUT_MS = 180_000;

/**
 * Resolve the on-disk Electron package directory (follows bun hoisting).
 * @param {string} [desktopRoot] - Path to apps/desktop; defaults to monorepo layout.
 * @returns {string}
 */
export function resolveElectronPackageDir(desktopRoot = resolve(rootDir, "apps", "desktop")) {
  const desktopRequire = createRequire(resolve(desktopRoot, "package.json"));
  return dirname(desktopRequire.resolve("electron/package.json"));
}

/**
 * True when path.txt points at an executable under dist/.
 * @param {string} electronPkgDir
 * @returns {boolean}
 */
export function isElectronBinaryInstalled(electronPkgDir) {
  const pathFile = resolve(electronPkgDir, "path.txt");
  if (!existsSync(pathFile)) return false;
  const rel = readFileSync(pathFile, "utf-8").trim();
  if (!rel) return false;
  return existsSync(resolve(electronPkgDir, "dist", rel));
}

/**
 * Run Electron's postinstall downloader with a bounded timeout.
 * @param {string} electronPkgDir
 * @param {number} [timeoutMs]
 */
export function runElectronInstall(electronPkgDir, timeoutMs = ELECTRON_INSTALL_TIMEOUT_MS) {
  execFileSync(process.execPath, [resolve(electronPkgDir, "install.js")], {
    stdio: "inherit",
    cwd: electronPkgDir,
    env: process.env,
    timeout: timeoutMs,
  });
}

/**
 * Download the Electron binary if install.js was skipped.
 * @param {string} [desktopRoot]
 */
export function ensureElectronBinary(desktopRoot = resolve(rootDir, "apps", "desktop")) {
  if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD === "1") {
    throw new Error(
      "ELECTRON_SKIP_BINARY_DOWNLOAD=1 is set but desktop dev needs the Electron binary. " +
        "Unset it, then run: bun run install:electron",
    );
  }

  const electronPkgDir = resolveElectronPackageDir(desktopRoot);
  if (isElectronBinaryInstalled(electronPkgDir)) return;

  console.log("[dev] Electron binary missing; running install.js (postinstall was likely skipped).");
  runElectronInstall(electronPkgDir);

  if (!isElectronBinaryInstalled(electronPkgDir)) {
    throw new Error(
      "Electron install.js finished but the binary is still missing. " +
        "Delete node_modules and run bun install without ELECTRON_SKIP_BINARY_DOWNLOAD.",
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  ensureElectronBinary();
  console.log("Electron binary ready.");
}
