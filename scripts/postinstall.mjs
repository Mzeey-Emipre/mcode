/**
 * Monorepo postinstall script.
 *
 * Replaces better-sqlite3's Node.js prebuild with one compiled for Electron's
 * NODE_MODULE_VERSION (ABI). The server runs inside Electron (forked with
 * ELECTRON_RUN_AS_NODE=1), so it needs Electron's ABI, not the system Node's.
 *
 * Instead, we query the real ABI from the Electron binary and download the
 * matching prebuild directly from better-sqlite3's GitHub releases.
 */

import { execSync } from "child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, unlinkSync } from "fs";
import { createRequire } from "module";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const desktopDir = resolve(rootDir, "apps", "desktop");

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
const nativeBinary = resolve(
  betterSqliteDir,
  "build",
  "Release",
  "better_sqlite3.node",
);

/**
 * Query the actual NODE_MODULE_VERSION from the installed Electron binary.
 *
 * ELECTRON_RUN_AS_NODE=1 makes Electron behave as plain Node, so
 * process.versions.modules reflects the real ABI it loads native addons with.
 * npx resolves the binary cross-platform (avoids EFTYPE on Windows Git Bash).
 */
function getElectronABI() {
  const abi = execSync(
    'npx electron -e "process.stdout.write(process.versions.modules);process.exit(0)"',
    {
      encoding: "utf-8",
      timeout: 30_000,
      cwd: desktopDir,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "ignore"],
    },
  ).trim();

  if (!/^\d+$/.test(abi)) {
    throw new Error(`Unexpected ABI from Electron binary: ${abi}`);
  }
  return abi;
}

// ---- Main ----

const electronABI = getElectronABI();
const platform = process.platform;
const arch = process.arch;
const tarName = `better-sqlite3-v${bsqlVersion}-electron-v${electronABI}-${platform}-${arch}.tar.gz`;
const url = `https://github.com/WiseLibs/better-sqlite3/releases/download/v${bsqlVersion}/${tarName}`;

console.log(`Downloading Electron prebuild: ${tarName}`);

// Download and extract to OS temp dir first (bun's .bun/@version paths
// contain special characters that break Git Bash's tar on Windows).
const tmpDir = resolve(tmpdir(), "mcode-postinstall");
const tmpTarPath = resolve(tmpDir, tarName).replace(/\\/g, "/");

mkdirSync(tmpDir, { recursive: true });

execSync(`curl -fsSL -o "${tmpTarPath}" "${url}"`, {
  stdio: "inherit",
  timeout: 60_000,
});

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
mkdirSync(dirname(nativeBinary), { recursive: true });
copyFileSync(extractedBinary, nativeBinary);

// Clean up temp files
rmSync(tmpDir, { recursive: true, force: true });

console.log(
  `better-sqlite3 v${bsqlVersion} ready for Electron ABI ${electronABI}`,
);
