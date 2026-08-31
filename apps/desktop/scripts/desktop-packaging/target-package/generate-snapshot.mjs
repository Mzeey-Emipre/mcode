/**
 * Generate a V8 context snapshot for the Electron main (browser) process.
 *
 * 1. Bundles snapshot-entry.ts into a self-contained IIFE (no require / Node APIs)
 * 2. Runs electron-mksnapshot to compile the IIFE into a V8 heap snapshot
 * 3. Renames the output to browser_v8_context_snapshot.bin
 *
 * Run:    bun scripts/desktop-packaging/target-package/generate-snapshot.mjs
 * Output: dist/snapshot/browser_v8_context_snapshot.bin
 */

import { build } from "esbuild";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const desktopRoot = NodePath.resolve(__dirname, "..", "..", "..");
const snapshotDir = NodePath.resolve(desktopRoot, "dist/snapshot");

// ---------------------------------------------------------------------------
// Cross-arch guard: electron-mksnapshot can only produce snapshots for the
// host architecture. When CI cross-compiles (e.g. arm64 host → x64 target),
// skip snapshot generation entirely. The after-pack hook handles the missing
// snapshot gracefully by skipping the fuse flip.
// ---------------------------------------------------------------------------

const targetArch = process.env.MCODE_TARGET_ARCH || process.arch;
if (targetArch !== process.arch) {
  console.log(
    `Skipping V8 snapshot: target arch "${targetArch}" !== host arch "${process.arch}". ` +
    `The app will start without a custom snapshot.`,
  );
  process.exit(0);
}

// Clean stale artifacts from previous builds to prevent after-pack from
// copying an outdated snapshot if this script fails mid-way.
if (NodeFS.existsSync(snapshotDir)) {
  NodeFS.rmSync(snapshotDir, { recursive: true, force: true });
}
NodeFS.mkdirSync(snapshotDir, { recursive: true });

// ---------------------------------------------------------------------------
// Step 1: Bundle snapshot entry as IIFE
// ---------------------------------------------------------------------------

console.log("Bundling snapshot entry...");
await build({
  entryPoints: [NodePath.resolve(desktopRoot, "src/main/snapshot-entry.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "esnext",
  outfile: NodePath.resolve(snapshotDir, "snapshot-entry.js"),
  minify: true,
});
console.log("  -> dist/snapshot/snapshot-entry.js");

// ---------------------------------------------------------------------------
// Step 2: Generate V8 snapshot blob via electron-mksnapshot
// ---------------------------------------------------------------------------

console.log("Generating V8 snapshot...");

// electron-mksnapshot registers its CLI as "mksnapshot" in node_modules/.bin.
// In a bun workspace the binary may be hoisted to the monorepo root, so check
// both the local and root node_modules/.bin directories.
const ext = process.platform === "win32" ? ".exe" : "";
const localBin = NodePath.resolve(desktopRoot, `node_modules/.bin/mksnapshot${ext}`);
const rootBin = NodePath.resolve(desktopRoot, `../../node_modules/.bin/mksnapshot${ext}`);
const mksnapshot = NodeFS.existsSync(localBin) ? localBin : rootBin;

if (!NodeFS.existsSync(mksnapshot)) {
  console.error(
    `ERROR: mksnapshot binary not found at:\n  ${localBin}\n  ${rootBin}\n` +
    `Ensure electron-mksnapshot is listed in trustedDependencies (root package.json) ` +
    `so bun runs its install script.`,
  );
  process.exit(1);
}

const snapshotResult = await new Promise((resolveResult) => {
  const child = NodeChildProcess.spawn(
    mksnapshot,
    [NodePath.resolve(snapshotDir, "snapshot-entry.js"), "--output_dir", snapshotDir],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  const appendOutput = (chunk, write) => {
    const text = chunk.toString();
    output = `${output}${text}`.slice(-20_000);
    write(text);
  };

  child.stdout.on("data", (chunk) =>
    appendOutput(chunk, process.stdout.write.bind(process.stdout)),
  );
  child.stderr.on("data", (chunk) =>
    appendOutput(chunk, process.stderr.write.bind(process.stderr)),
  );
  child.on("error", (error) => resolveResult({ error, status: null, output }));
  child.on("close", (status) => resolveResult({ error: null, status, output }));
});

if (snapshotResult.error) {
  console.error(snapshotResult.error);
  process.exit(1);
}

if (snapshotResult.status !== 0) {
  if (snapshotResult.output.includes("Could not find mksnapshot")) {
    console.warn(
      "Skipping V8 snapshot: electron-mksnapshot did not install a native mksnapshot binary for this platform. " +
      "The app will start without a custom snapshot.",
    );
    NodeFS.rmSync(snapshotDir, { recursive: true, force: true });
    process.exit(0);
  }

  process.exit(snapshotResult.status ?? 1);
}

// ---------------------------------------------------------------------------
// Step 3: Rename to browser-specific snapshot
// ---------------------------------------------------------------------------

// On macOS the filename includes the arch suffix; on Windows/Linux it does not.
const platform = process.platform;
let v8ContextFile;
if (platform === "darwin") {
  const arch = process.env.npm_config_arch || process.arch;
  v8ContextFile =
    arch === "arm64"
      ? "v8_context_snapshot.arm64.bin"
      : "v8_context_snapshot.x86_64.bin";
} else {
  v8ContextFile = "v8_context_snapshot.bin";
}

const source = NodePath.resolve(snapshotDir, v8ContextFile);
const target = NodePath.resolve(snapshotDir, "browser_v8_context_snapshot.bin");

if (!NodeFS.existsSync(source)) {
  console.error(
    `ERROR: electron-mksnapshot did not produce ${v8ContextFile}`,
  );
  process.exit(1);
}

// Remove stale target if it exists
if (NodeFS.existsSync(target)) {
  NodeFS.unlinkSync(target);
}

NodeFS.renameSync(source, target);
console.log("  -> dist/snapshot/browser_v8_context_snapshot.bin");

// Clean up intermediate files
const intermediateEntry = NodePath.resolve(snapshotDir, "snapshot-entry.js");
if (NodeFS.existsSync(intermediateEntry)) {
  NodeFS.unlinkSync(intermediateEntry);
}
const snapshotBlob = NodePath.resolve(snapshotDir, "snapshot_blob.bin");
if (NodeFS.existsSync(snapshotBlob)) {
  NodeFS.unlinkSync(snapshotBlob);
}

console.log("V8 snapshot generation complete.");
