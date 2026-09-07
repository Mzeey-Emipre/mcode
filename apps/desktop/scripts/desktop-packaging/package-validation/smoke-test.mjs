/**
 * Post-packaging smoke test for the Mcode server bundle.
 *
 * Launches server.cjs from the electron-builder unpacked directory using
 * the staged Bun runtime. Electron remains the explicit PTY host. Polls /health and
 * exits 0 on success, 1 on failure.
 *
 * This catches:
 * - Missing Bun runtime or Electron PTY host artifacts
 * - Broken asarUnpack configuration
 * - Server startup crashes invisible in the packaged app
 * - Import/require resolution failures in the CJS bundle
 * - Missing Claude Agent SDK native CLI (after-pack regression)
 *
 * Usage:
 *   node apps/desktop/scripts/desktop-packaging/package-validation/smoke-test.mjs             # auto-detect unpacked dir
 *   node apps/desktop/scripts/desktop-packaging/package-validation/smoke-test.mjs --bundle    # test pre-packaging bundle (requires native deps on PATH)
 */

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import {
  findClaudeSdkCliPath,
  expectedClaudeSdkCliPath,
} from "../../../../../scripts/build-server-dev-bundle.mjs";
import {
  classifySmokeOutcome,
  getPackagedRuntimeStartupTimeoutMs,
  selectPackagedPtyHost,
} from "./smoke-test-config.mjs";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const desktopRoot = NodePath.resolve(__dirname, "..", "..", "..");
const releaseDir = process.env.MCODE_PACKAGE_RELEASE_DIR
  ? NodePath.resolve(process.env.MCODE_PACKAGE_RELEASE_DIR)
  : NodePath.resolve(desktopRoot, "release");

const SMOKE_PORT = 19899;
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
      server: NodePath.resolve(releaseDir, "win-unpacked/resources/app.asar.unpacked/dist/server/server.cjs"),
      renamedBinary: NodePath.resolve(releaseDir, "win-unpacked/resources/bin/mcode-server.exe"),
      electron: NodePath.resolve(releaseDir, "win-unpacked/Mcode.exe"),
      resourcesRoot: NodePath.resolve(releaseDir, "win-unpacked/resources"),
      bun: NodePath.resolve(releaseDir, "win-unpacked/resources/bin/mcode-bun.exe"),
      koffi: NodePath.resolve(releaseDir, "win-unpacked/resources/app.asar.unpacked/node_modules/koffi"),
      nodePty: NodePath.resolve(releaseDir, "win-unpacked/resources/app.asar.unpacked/node_modules/node-pty"),
    },
    // Linux (electron-builder uses package name as binary name)
    {
      server: NodePath.resolve(releaseDir, "linux-unpacked/resources/app.asar.unpacked/dist/server/server.cjs"),
      renamedBinary: NodePath.resolve(releaseDir, "linux-unpacked/resources/bin/mcode-server"),
      electron: NodePath.resolve(releaseDir, "linux-unpacked/mcode-desktop"),
      resourcesRoot: NodePath.resolve(releaseDir, "linux-unpacked/resources"),
      bun: NodePath.resolve(releaseDir, "linux-unpacked/resources/bin/mcode-bun"),
      koffi: NodePath.resolve(releaseDir, "linux-unpacked/resources/app.asar.unpacked/node_modules/koffi"),
      nodePty: NodePath.resolve(releaseDir, "linux-unpacked/resources/app.asar.unpacked/node_modules/node-pty"),
    },
    // macOS Intel
    {
      server: NodePath.resolve(releaseDir, "mac/Mcode.app/Contents/Resources/app.asar.unpacked/dist/server/server.cjs"),
      renamedBinary: NodePath.resolve(releaseDir, "mac/Mcode.app/Contents/Resources/bin/mcode-server"),
      electron: NodePath.resolve(releaseDir, "mac/Mcode.app/Contents/MacOS/Mcode"),
      allowsUnsignedMacFallback: true,
      resourcesRoot: NodePath.resolve(releaseDir, "mac/Mcode.app/Contents/Resources"),
      bun: NodePath.resolve(releaseDir, "mac/Mcode.app/Contents/Resources/bin/mcode-bun"),
      koffi: NodePath.resolve(releaseDir, "mac/Mcode.app/Contents/Resources/app.asar.unpacked/node_modules/koffi"),
      nodePty: NodePath.resolve(releaseDir, "mac/Mcode.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty"),
    },
    // macOS ARM
    {
      server: NodePath.resolve(releaseDir, "mac-arm64/Mcode.app/Contents/Resources/app.asar.unpacked/dist/server/server.cjs"),
      renamedBinary: NodePath.resolve(releaseDir, "mac-arm64/Mcode.app/Contents/Resources/bin/mcode-server"),
      electron: NodePath.resolve(releaseDir, "mac-arm64/Mcode.app/Contents/MacOS/Mcode"),
      allowsUnsignedMacFallback: true,
      resourcesRoot: NodePath.resolve(releaseDir, "mac-arm64/Mcode.app/Contents/Resources"),
      bun: NodePath.resolve(releaseDir, "mac-arm64/Mcode.app/Contents/Resources/bin/mcode-bun"),
      koffi: NodePath.resolve(releaseDir, "mac-arm64/Mcode.app/Contents/Resources/app.asar.unpacked/node_modules/koffi"),
      nodePty: NodePath.resolve(releaseDir, "mac-arm64/Mcode.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty"),
    },
  ];

  for (const c of candidates) {
    // On macOS, the renamed binary triggers SIGTRAP due to library validation
    // when not co-signed by electron-builder (CI runs with signing disabled).
    // In production, mac.binaries handles co-signing. For the smoke test, use
    // the main Electron binary on macOS to validate the server bundle.
    const ptyHost = selectPackagedPtyHost({
      renamedBinary: c.renamedBinary,
      electron: c.electron,
      allowsUnsignedMacFallback: c.allowsUnsignedMacFallback,
      hasRenamedBinary: NodeFS.existsSync(c.renamedBinary),
      hasElectron: NodeFS.existsSync(c.electron),
    });
    if (NodeFS.existsSync(c.server) && NodeFS.existsSync(c.bun) && ptyHost) {
      return {
        server: c.server,
        bun: c.bun,
        ptyHost,
        resourcesRoot: NodeFS.realpathSync(c.resourcesRoot),
        koffi: c.koffi,
        nodePty: c.nodePty,
      };
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
 * --bundle mode: test the pre-packaging bundle with the workspace Bun runtime.
 */
function findBundleServer() {
  const server = NodePath.resolve(desktopRoot, "dist/server/server.cjs");
  if (!NodeFS.existsSync(server)) {
    return null;
  }
  return { server, bun: process.env.BUN ?? "bun", ptyHost: process.env.MCODE_PTY_HOST_EXECUTABLE };
}

const bundleOnly = process.argv.includes("--bundle");
const found = bundleOnly ? findBundleServer() : findUnpackedServer();

if (!found) {
  const target = bundleOnly ? "dist/server/server.cjs" : "unpacked release directory";
  console.error(`[smoke-test] ERROR: Could not find ${target}.`);
  console.error(bundleOnly
    ? "  Run: bun run --cwd apps/desktop build"
    : "  Run: node apps/desktop/scripts/desktop-packaging/target-package/ci-package.mjs");
  process.exit(1);
}

console.log(`[smoke-test] Server: ${found.server}`);
console.log(`[smoke-test] Bun runtime: ${found.bun}`);

const sdkTarget = bundleOnly
  ? { platform: process.platform, arch: process.arch }
  : inferPackagedSdkTarget(found.server);
const timeoutMs = getPackagedRuntimeStartupTimeoutMs({
  hostPlatform: process.platform,
  hostArch: process.arch,
  targetPlatform: sdkTarget.platform,
  targetArch: sdkTarget.arch,
});

if (!bundleOnly) {
  if (!found.koffi || !NodeFS.existsSync(found.koffi)) {
    console.error(`[smoke-test] ERROR: koffi native module missing at ${found.koffi}`);
    console.error("  package config should include node_modules/koffi in files and asarUnpack.");
    process.exit(1);
  }
  console.log(`[smoke-test] koffi module: ${found.koffi}`);

  const claudeCli = findClaudeSdkCliPath(found.server, sdkTarget.platform, sdkTarget.arch);
  if (!claudeCli) {
    const expected = expectedClaudeSdkCliPath(found.server, sdkTarget.platform, sdkTarget.arch);
    console.error(`[smoke-test] ERROR: Claude SDK CLI binary missing at ${expected}`);
    console.error("  after-pack.mjs should copy it into app.asar.unpacked/dist/server/node_modules/");
    process.exit(1);
  }
  console.log(`[smoke-test] Claude SDK CLI: ${claudeCli}`);

  if (sdkTarget.platform === "win32") {
    const marker = "MCODE_PACKAGED_PTY_OK";
    const ptyScript = `
      const { spawn } = require(process.env.MCODE_PACKAGED_NODE_PTY);
      const marker = ${JSON.stringify(marker)};
      let output = "";
      const terminal = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", "Write-Output " + marker],
        {
          name: "xterm-256color",
          cols: 80,
          rows: 24,
          cwd: process.cwd(),
          env: process.env,
          useConptyDll: true,
        },
      );
      const timeout = setTimeout(() => {
        console.error("Packaged PTY timed out: " + JSON.stringify(output));
        process.exit(1);
      }, 8000);
      terminal.onData((data) => { output += data; });
      terminal.onExit(({ exitCode }) => {
        clearTimeout(timeout);
        if (exitCode !== 0 || !output.includes(marker)) {
          console.error("Packaged PTY failed: " + JSON.stringify({ exitCode, output }));
          process.exit(1);
        }
        process.stdout.write(marker, () => process.exit(0));
      });
    `;

    try {
      const output = NodeChildProcess.execFileSync(found.ptyHost, ["-e", ptyScript], {
        cwd: NodePath.dirname(found.server),
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          MCODE_PACKAGED_NODE_PTY: found.nodePty,
        },
      });
      if (!output.includes(marker)) {
        throw new Error(`Packaged PTY marker missing from output: ${output}`);
      }
      console.log("[smoke-test] Packaged PTY: PASS");
    } catch (error) {
      const details = error.stderr?.toString() || error.stdout?.toString() || error.message;
      console.error(`[smoke-test] ERROR: Packaged PTY failed to start: ${details}`);
      process.exit(1);
    }
  }
}

// ---------------------------------------------------------------------------
// Create a temporary data directory so the smoke test is isolated
// ---------------------------------------------------------------------------

const dataDir = NodePath.resolve(NodeOS.tmpdir(), `mcode-smoke-${NodeCrypto.randomUUID().slice(0, 8)}`);
NodeFS.mkdirSync(dataDir, { recursive: true });

// ---------------------------------------------------------------------------
// Spawn the server
// ---------------------------------------------------------------------------

const env = {
  ...process.env,
  MCODE_PTY_HOST_EXECUTABLE: found.ptyHost,
  MCODE_PORT: String(SMOKE_PORT),
  MCODE_DATA_DIR: dataDir,
  MCODE_MODE: "desktop",
  MCODE_VERSION: "0.0.0-smoke",
  NODE_ENV: "production",
};

if (found.resourcesRoot) {
  env.MCODE_PACKAGED_RESOURCES_ROOT = found.resourcesRoot;
  env.MCODE_DRIZZLE_MIGRATIONS_DIR = NodePath.join(NodePath.dirname(found.server), "drizzle");
  env.NODE_PATH = [
    NodePath.join(found.resourcesRoot, "app.asar.unpacked", "node_modules"),
    process.env.NODE_PATH,
  ].filter(Boolean).join(NodePath.delimiter);
}

console.log(`[smoke-test] Starting server on port ${SMOKE_PORT}...`);

const child = NodeChildProcess.spawn(found.bun, [found.server], {
  cwd: NodePath.dirname(found.server),
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

const deadline = Date.now() + timeoutMs;
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

const outcome = classifySmokeOutcome({
  healthy,
  exitedAtDeadline: exited,
});

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
try { NodeFS.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ok */ }

if (outcome === "healthy") {
  console.log("[smoke-test] PASS: Server started and /health returned 200.");
  process.exit(0);
} else if (outcome === "crashed") {
  console.error("[smoke-test] FAIL: Server crashed before becoming ready.");
  if (serverStderr) {
    console.error("[smoke-test] Last stderr output:\n" + serverStderr.slice(-2000));
  }
  process.exit(1);
} else {
  console.error(`[smoke-test] FAIL: Server did not respond within ${timeoutMs / 1000}s.`);
  if (serverStderr) {
    console.error("[smoke-test] Last stderr output:\n" + serverStderr.slice(-2000));
  }
  process.exit(1);
}
