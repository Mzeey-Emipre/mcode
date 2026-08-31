/**
 * Ensure the workspace Electron binary is downloaded before desktop dev or prod.
 * Bun may skip electron's postinstall when ELECTRON_SKIP_BINARY_DOWNLOAD=1 (CI);
 * this restores the binary for local desktop workflows.
 */

import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const rootDir = NodePath.resolve(__dirname, "..");

/** Maximum time allowed for one Electron binary download attempt. */
export const ELECTRON_INSTALL_TIMEOUT_MS = 180_000;

/**
 * Resolve the on-disk Electron package directory (follows bun hoisting).
 * @param {string} [desktopRoot] - Path to apps/desktop; defaults to monorepo layout.
 * @returns {string}
 */
export function resolveElectronPackageDir(desktopRoot = NodePath.resolve(rootDir, "apps", "desktop")) {
  const desktopRequire = NodeModule.createRequire(NodePath.resolve(desktopRoot, "package.json"));
  return NodePath.dirname(desktopRequire.resolve("electron/package.json"));
}

/**
 * True when path.txt points at an executable under dist/.
 * @param {string} electronPkgDir
 * @returns {boolean}
 */
export function isElectronBinaryInstalled(electronPkgDir) {
  const pathFile = NodePath.resolve(electronPkgDir, "path.txt");
  if (!NodeFS.existsSync(pathFile)) return false;
  const rel = NodeFS.readFileSync(pathFile, "utf-8").trim();
  if (!rel) return false;
  return NodeFS.existsSync(NodePath.resolve(electronPkgDir, "dist", rel));
}

/**
 * Run Electron's postinstall downloader with a bounded timeout.
 * @param {string} electronPkgDir
 * @param {number} [timeoutMs]
 */
export function runElectronInstall(electronPkgDir, timeoutMs = ELECTRON_INSTALL_TIMEOUT_MS) {
  NodeChildProcess.execFileSync(process.execPath, [NodePath.resolve(electronPkgDir, "install.js")], {
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
export function ensureElectronBinary(desktopRoot = NodePath.resolve(rootDir, "apps", "desktop")) {
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

if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  ensureElectronBinary();
  console.log("Electron binary ready.");
}
