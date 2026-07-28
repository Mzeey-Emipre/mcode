/**
 * Monorepo postinstall script.
 *
 * Downloads an Electron-compatible better-sqlite3 prebuild for the backend
 * runtime. Bun owns repository orchestration while Electron owns the backend
 * and native-module ABI:
 *
 *   build/Release/better_sqlite3.electron.node  - Electron prebuild
 *
 * Skips gracefully when:
 * - Electron binary is not installed (worktrees, CI, server-only dev)
 * - The correct prebuild is already in place (avoids re-downloading)
 *
 * Set SKIP_ELECTRON_REBUILD=1 to force skip.
 */

import { execSync, execFileSync } from "child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { createRequire } from "module";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const desktopDir = resolve(rootDir, "apps", "desktop");

// Allow explicit skip (useful for CI, worktrees, server-only dev).
// This skips Electron download and verification for environments without it.
let skipElectron = false;
if (process.env.SKIP_ELECTRON_REBUILD === "1") {
  console.log("Skipping Electron prebuild (SKIP_ELECTRON_REBUILD=1)");
  skipElectron = true;
}

// Resolve where better-sqlite3 actually lives (follows bun's .bun/ hoisting)
const serverRequire = createRequire(
  resolve(rootDir, "apps", "server", "src", "index.ts"),
);
const betterSqliteDir = dirname(
  serverRequire.resolve("better-sqlite3/package.json"),
);
const bsqlVersion = JSON.parse(
  readFileSync(resolve(betterSqliteDir, "package.json"), "utf-8"),
).version;
const electronBinary = resolve(
  betterSqliteDir,
  "build",
  "Release",
  "better_sqlite3.electron.node",
);
// Marker file to track which ABI the current prebuild was built for
const abiMarker = resolve(betterSqliteDir, "build", "Release", ".electron-abi");

/**
 * Resolve the path to the actual Electron binary from the project's
 * node_modules. Returns null if Electron is not installed or the binary
 * is missing (e.g. in worktrees before `electron install` runs).
 */
function getElectronBinary() {
  try {
    const desktopRequire = createRequire(
      resolve(desktopDir, "package.json"),
    );
    const electronPath = desktopRequire("electron");
    if (!existsSync(electronPath)) return null;
    return electronPath;
  } catch {
    return null;
  }
}

/**
 * Query the actual NODE_MODULE_VERSION from the installed Electron binary.
 * Returns null if the binary can't be queried.
 */
function getElectronABI(electronBin) {
  try {
    const abi = execFileSync(
      electronBin,
      ["-e", "process.stdout.write(process.versions.modules);process.exit(0)"],
      {
        encoding: "utf-8",
        timeout: 30_000,
        cwd: desktopDir,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    if (!/^\d+$/.test(abi)) return null;
    return abi;
  } catch {
    return null;
  }
}

// ---- Electron prebuild ----

const platform = process.platform;
const arch = process.arch;
let electronABI = null;

if (!skipElectron) {
  const electronBin = getElectronBinary();
  if (!electronBin) {
    console.log("Skipping Electron prebuild (Electron binary not found)");
  } else {
    electronABI = getElectronABI(electronBin);
    if (!electronABI) {
      console.log("Skipping Electron prebuild (could not detect Electron ABI)");
    }
  }
}

if (electronABI) {
  // Check if the correct Electron prebuild is already in place.
  // Both the ABI marker AND the actual binary must exist -- upgrading from an
  // older postinstall may leave a stale marker without the .electron.node file.
  let electronAlreadyOk = false;
  if (existsSync(abiMarker) && existsSync(electronBinary)) {
    const currentABI = readFileSync(abiMarker, "utf-8").trim();
    if (currentABI === electronABI) {
      electronAlreadyOk = true;
      console.log(
        `better-sqlite3 v${bsqlVersion} already built for Electron ABI ${electronABI}`,
      );
    }
  }

  if (!electronAlreadyOk) {
    const tarName = `better-sqlite3-v${bsqlVersion}-electron-v${electronABI}-${platform}-${arch}.tar.gz`;
    const url = `https://github.com/WiseLibs/better-sqlite3/releases/download/v${bsqlVersion}/${tarName}`;

    console.log(`Downloading Electron prebuild: ${tarName}`);

    // Download and extract to OS temp dir first (bun's .bun/@version paths
    // contain special characters that break Git Bash's tar on Windows).
    const tmpDir = mkdtempSync(resolve(tmpdir(), "mcode-postinstall-"));
    const tmpTarPath = resolve(tmpDir, tarName).replace(/\\/g, "/");

    try {
      execSync(`curl -fsSL -o "${tmpTarPath}" "${url}"`, {
        stdio: "inherit",
        timeout: 60_000,
      });

      // Pre-create extraction target so tar doesn't need to create nested dirs.
      // Windows tar (bsdtar/GNU tar via MSYS2) can intermittently fail to
      // auto-create directories inside C:\Windows\Temp during bun install hooks.
      mkdirSync(resolve(tmpDir, "build", "Release"), { recursive: true });

      // Extract using tar. Avoid --force-local (unsupported by Windows' bsdtar)
      // and avoid absolute paths with drive letters (the colon in "C:" is
      // misinterpreted as a remote host prefix by some tar implementations).
      // Using cwd + relative filename sidesteps both issues.
      execSync(`tar -xzf "${tarName}"`, {
        stdio: "inherit",
        cwd: tmpDir,
      });

      // Copy the extracted binary to better-sqlite3's build directory
      const extractedBinary = resolve(
        tmpDir,
        "build",
        "Release",
        "better_sqlite3.node",
      );
      mkdirSync(dirname(electronBinary), { recursive: true });

      // Install the Electron prebuild under its explicit ABI-specific name.
      copyFileSync(extractedBinary, electronBinary);

      // Write marker so we skip on next install
      mkdirSync(dirname(abiMarker), { recursive: true });
      writeFileSync(abiMarker, electronABI);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

if (electronABI) {
  if (!existsSync(electronBinary)) {
    throw new Error(`Electron better-sqlite3 binding missing after install: ${electronBinary}`);
  }
  if (!existsSync(abiMarker)) {
    throw new Error(`Electron better-sqlite3 ABI marker missing after install: ${abiMarker}`);
  }
  const installedABI = readFileSync(abiMarker, "utf-8").trim();
  if (!/^\d+$/.test(installedABI) || installedABI !== electronABI) {
    throw new Error(
      `Electron better-sqlite3 ABI marker mismatch: expected ${electronABI}, found ${installedABI || "missing"}`,
    );
  }
  console.log(
    `better-sqlite3 v${bsqlVersion}: Electron ABI ${electronABI} at better_sqlite3.electron.node`,
  );
} else {
  console.log(`better-sqlite3 v${bsqlVersion}: Electron binding not checked (Electron unavailable)`);
}
