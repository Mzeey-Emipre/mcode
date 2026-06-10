/**
 * Post-packaging smoke test for the Mcode server bundle.
 *
 * Launches server.cjs from the electron-builder unpacked directory using
 * the packaged Electron binary with ELECTRON_RUN_AS_NODE=1 (mirroring how
 * server-manager.ts spawns the server in production). Polls /health and
 * exits 0 on success, 1 on failure.
 *
 * This catches:
 * - Missing native modules (better-sqlite3, node-pty)
 * - Broken asarUnpack configuration
 * - Server startup crashes invisible in the packaged app
 * - Import/require resolution failures in the CJS bundle
 * - Missing Claude Agent SDK native CLI (after-pack regression)
 *
 * Usage:
 *   node apps/desktop/scripts/smoke-test.mjs             # auto-detect unpacked dir
 *   node apps/desktop/scripts/smoke-test.mjs --bundle    # test pre-packaging bundle (requires native deps on PATH)
 */

import { spawn, execFileSync } from "child_process";
import { existsSync, mkdirSync, rmSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import {
  findClaudeSdkCliPath,
  expectedClaudeSdkCliPath,
} from "../../../scripts/build-server-dev-bundle.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, "..");
const releaseDir = resolve(desktopRoot, "release");

const SMOKE_PORT = 19899;
const TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 300;

// ---------------------------------------------------------------------------
// Locate the unpacked server bundle and Electron binary
// ---------------------------------------------------------------------------

/** Find the server.cjs and runtime binary from the unpacked directory.
 *  Prefers the renamed `mcode-server` binary (production code path) and
 *  falls back to the main Electron binary when the renamed copy is absent. */
function findUnpackedServer() {
  const candidates = [
    // Windows
    {
      server: resolve(releaseDir, "win-unpacked/resources/app.asar.unpacked/dist/server/server.cjs"),
      renamedBinary: resolve(releaseDir, "win-unpacked/resources/bin/mcode-server.exe"),
      electron: resolve(releaseDir, "win-unpacked/Mcode.exe"),
      sqlite: resolve(releaseDir, "win-unpacked/resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release"),
    },
    // Linux (electron-builder uses package name as binary name)
    {
      server: resolve(releaseDir, "linux-unpacked/resources/app.asar.unpacked/dist/server/server.cjs"),
      renamedBinary: resolve(releaseDir, "linux-unpacked/resources/bin/mcode-server"),
      electron: resolve(releaseDir, "linux-unpacked/mcode-desktop"),
      sqlite: resolve(releaseDir, "linux-unpacked/resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release"),
    },
    // macOS Intel
    {
      server: resolve(releaseDir, "mac/Mcode.app/Contents/Resources/app.asar.unpacked/dist/server/server.cjs"),
      renamedBinary: resolve(releaseDir, "mac/Mcode.app/Contents/Resources/bin/mcode-server"),
      electron: resolve(releaseDir, "mac/Mcode.app/Contents/MacOS/Mcode"),
      sqlite: resolve(releaseDir, "mac/Mcode.app/Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release"),
    },
    // macOS ARM
    {
      server: resolve(releaseDir, "mac-arm64/Mcode.app/Contents/Resources/app.asar.unpacked/dist/server/server.cjs"),
      renamedBinary: resolve(releaseDir, "mac-arm64/Mcode.app/Contents/Resources/bin/mcode-server"),
      electron: resolve(releaseDir, "mac-arm64/Mcode.app/Contents/MacOS/Mcode"),
      sqlite: resolve(releaseDir, "mac-arm64/Mcode.app/Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release"),
    },
  ];

  for (const c of candidates) {
    // On macOS, the renamed binary triggers SIGTRAP due to library validation
    // when not co-signed by electron-builder (CI runs with signing disabled).
    // In production, mac.binaries handles co-signing. For the smoke test, use
    // the main Electron binary on macOS to validate the server bundle.
    const isMac = c.server.includes(".app/Contents/");
    const useRenamed = !isMac && existsSync(c.renamedBinary);
    const runtime = useRenamed ? c.renamedBinary : c.electron;
    if (existsSync(c.server) && existsSync(runtime)) {
      const electronBinding = resolve(c.sqlite, "better_sqlite3.electron.node");
      const nodeBinding = resolve(c.sqlite, "better_sqlite3.node");
      const binding = existsSync(electronBinding) ? electronBinding : existsSync(nodeBinding) ? nodeBinding : undefined;
      const electronDir = useRenamed ? dirname(c.electron) : undefined;
      return { server: c.server, electron: runtime, binding, electronDir };
    }
  }
  return null;
}

/**
 * Infer the packaged app's npm platform/arch from the release output path.
 *
 * @param {string} serverPath Absolute path to packaged `server.cjs`.
 * @returns {{ platform: NodeJS.Platform, arch: NodeJS.Architecture }}
 */
function inferPackagedSdkTarget(serverPath) {
  const normalized = serverPath.replace(/\\/g, "/");
  if (normalized.includes("/win-unpacked/")) {
    return { platform: "win32", arch: "x64" };
  }
  if (normalized.includes("/linux-unpacked/")) {
    return { platform: "linux", arch: "x64" };
  }
  if (normalized.includes("/mac-arm64/")) {
    return { platform: "darwin", arch: "arm64" };
  }
  if (normalized.includes("/mac/")) {
    return { platform: "darwin", arch: "x64" };
  }
  return { platform: process.platform, arch: process.arch };
}

/**
 * --bundle mode: test the pre-packaging bundle with the system node/bun.
 * Skips native module verification but catches JS bundle errors.
 */
function findBundleServer() {
  const server = resolve(desktopRoot, "dist/server/server.cjs");
  if (!existsSync(server)) {
    return null;
  }
  return { server, electron: process.execPath, binding: undefined };
}

const bundleOnly = process.argv.includes("--bundle");
const found = bundleOnly ? findBundleServer() : findUnpackedServer();

if (!found) {
  const target = bundleOnly ? "dist/server/server.cjs" : "unpacked release directory";
  console.error(`[smoke-test] ERROR: Could not find ${target}.`);
  console.error(bundleOnly
    ? "  Run: bun run --cwd apps/desktop build"
    : "  Run: node apps/desktop/scripts/ci-package.mjs");
  process.exit(1);
}

console.log(`[smoke-test] Server: ${found.server}`);
console.log(`[smoke-test] Runtime: ${found.electron}`);
if (found.binding) {
  console.log(`[smoke-test] SQLite binding: ${found.binding}`);
}

if (!bundleOnly) {
  const sdkTarget = inferPackagedSdkTarget(found.server);
  const claudeCli = findClaudeSdkCliPath(found.server, sdkTarget.platform, sdkTarget.arch);
  if (!claudeCli) {
    const expected = expectedClaudeSdkCliPath(found.server, sdkTarget.platform, sdkTarget.arch);
    console.error(`[smoke-test] ERROR: Claude SDK CLI binary missing at ${expected}`);
    console.error("  after-pack.mjs should copy it into app.asar.unpacked/dist/server/node_modules/");
    process.exit(1);
  }
  console.log(`[smoke-test] Claude SDK CLI: ${claudeCli}`);
}

// ---------------------------------------------------------------------------
// Create a temporary data directory so the smoke test is isolated
// ---------------------------------------------------------------------------

const dataDir = resolve(tmpdir(), `mcode-smoke-${randomUUID().slice(0, 8)}`);
mkdirSync(dataDir, { recursive: true });

// ---------------------------------------------------------------------------
// Spawn the server
// ---------------------------------------------------------------------------

const env = {
  ...process.env,
  ELECTRON_RUN_AS_NODE: "1",
  MCODE_PORT: String(SMOKE_PORT),
  MCODE_DATA_DIR: dataDir,
  MCODE_MODE: "desktop",
  MCODE_VERSION: "0.0.0-smoke",
  NODE_ENV: "production",
};

if (found.binding) {
  env.BETTER_SQLITE3_BINDING = found.binding;
}

// When using the renamed binary in a different directory, the dynamic linker
// can't find Electron's shared libraries (libffmpeg.so on Linux). Point
// LD_LIBRARY_PATH at the original Electron binary directory as a fallback.
if (found.electronDir) {
  if (process.platform === "linux") {
    env.LD_LIBRARY_PATH = [found.electronDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":");
  } else if (process.platform === "darwin") {
    env.DYLD_LIBRARY_PATH = [found.electronDir, process.env.DYLD_LIBRARY_PATH].filter(Boolean).join(":");
  }
}

// On macOS, verify the binary's code signature before attempting to run.
// A bad signature causes a silent SIGKILL from the kernel.
if (process.platform === "darwin") {
  try {
    const sigInfo = execFileSync("codesign", ["-dvv", found.electron], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    console.log(`[smoke-test] codesign info:\n${sigInfo}`);
  } catch (e) {
    console.log(`[smoke-test] codesign -dvv output: ${e.stderr || e.stdout || e.message}`);
  }
  try {
    execFileSync("codesign", ["--verify", "--strict", found.electron], { encoding: "utf-8" });
    console.log("[smoke-test] codesign --verify: OK");
  } catch (e) {
    console.error(`[smoke-test] codesign --verify FAILED: ${e.stderr || e.message}`);
  }
}

console.log(`[smoke-test] Starting server on port ${SMOKE_PORT}...`);

const child = spawn(found.electron, [
  "--max-old-space-size=96",
  found.server,
], {
  cwd: dirname(found.server),
  env,
  stdio: ["ignore", "pipe", "pipe"],
});

let serverStderr = "";
child.stderr.on("data", (chunk) => { serverStderr += chunk.toString(); });
child.stdout.on("data", (chunk) => { process.stdout.write(chunk); });

// ---------------------------------------------------------------------------
// Poll /health
// ---------------------------------------------------------------------------

let exited = false;
/** Resolves when the child process exits. */
const exitPromise = new Promise((resolve) => {
  child.on("exit", (code, signal) => {
    exited = true;
    if (signal) {
      console.error(`[smoke-test] Server killed by signal ${signal}`);
    }
    if (code !== null && code !== 0) {
      console.error(`[smoke-test] Server exited with code ${code}`);
    }
    if ((code !== null && code !== 0) || signal) {
      if (serverStderr) {
        console.error("[smoke-test] stderr:\n" + serverStderr.slice(-2000));
      }
    }
    resolve(code);
  });
});

const deadline = Date.now() + TIMEOUT_MS;
let healthy = false;

while (Date.now() < deadline && !exited) {
  try {
    const res = await fetch(`http://localhost:${SMOKE_PORT}/health`);
    if (res.ok) {
      healthy = true;
      break;
    }
  } catch {
    // not ready yet
  }
  await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
}

// ---------------------------------------------------------------------------
// Report and cleanup
// ---------------------------------------------------------------------------

// Kill the server (graceful then force)
try { process.kill(child.pid, "SIGTERM"); } catch { /* already dead */ }
setTimeout(() => {
  try { process.kill(child.pid, "SIGKILL"); } catch { /* ok */ }
}, 3000);

// Wait for exit
await exitPromise;

// Clean up temp data directory
try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ok */ }

if (healthy) {
  console.log("[smoke-test] PASS: Server started and /health returned 200.");
  process.exit(0);
} else if (exited) {
  console.error("[smoke-test] FAIL: Server crashed before becoming ready.");
  if (serverStderr) {
    console.error("[smoke-test] Last stderr output:\n" + serverStderr.slice(-2000));
  }
  process.exit(1);
} else {
  console.error(`[smoke-test] FAIL: Server did not respond within ${TIMEOUT_MS / 1000}s.`);
  if (serverStderr) {
    console.error("[smoke-test] Last stderr output:\n" + serverStderr.slice(-2000));
  }
  process.exit(1);
}
