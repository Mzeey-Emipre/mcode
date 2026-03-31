/**
 * Generate a V8 context snapshot for the Electron main (browser) process.
 *
 * 1. Bundles snapshot-entry.ts into a self-contained IIFE (no require / Node APIs)
 * 2. Runs electron-mksnapshot to compile the IIFE into a V8 heap snapshot
 * 3. Renames the output to browser_v8_context_snapshot.bin
 *
 * Run:    bun scripts/generate-snapshot.mjs
 * Output: dist/snapshot/browser_v8_context_snapshot.bin
 */

import { build } from "esbuild";
import { execFileSync } from "child_process";
import { renameSync, existsSync, mkdirSync, unlinkSync, rmSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, "..");
const snapshotDir = resolve(desktopRoot, "dist/snapshot");

// Clean stale artifacts from previous builds to prevent after-pack from
// copying an outdated snapshot if this script fails mid-way.
if (existsSync(snapshotDir)) {
  rmSync(snapshotDir, { recursive: true, force: true });
}
mkdirSync(snapshotDir, { recursive: true });

// ---------------------------------------------------------------------------
// Step 1: Bundle snapshot entry as IIFE
// ---------------------------------------------------------------------------

console.log("Bundling snapshot entry...");
await build({
  entryPoints: [resolve(desktopRoot, "src/main/snapshot-entry.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "esnext",
  outfile: resolve(snapshotDir, "snapshot-entry.js"),
  minify: true,
});
console.log("  -> dist/snapshot/snapshot-entry.js");

// ---------------------------------------------------------------------------
// Step 2: Generate V8 snapshot blob via electron-mksnapshot
// ---------------------------------------------------------------------------

console.log("Generating V8 snapshot...");

// electron-mksnapshot registers its CLI as "mksnapshot" in node_modules/.bin
const ext = process.platform === "win32" ? ".exe" : "";
const mksnapshot = resolve(
  desktopRoot,
  `node_modules/.bin/mksnapshot${ext}`,
);

execFileSync(
  mksnapshot,
  [resolve(snapshotDir, "snapshot-entry.js"), "--output_dir", snapshotDir],
  { stdio: "inherit" },
);

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

const source = resolve(snapshotDir, v8ContextFile);
const target = resolve(snapshotDir, "browser_v8_context_snapshot.bin");

if (!existsSync(source)) {
  console.error(
    `ERROR: electron-mksnapshot did not produce ${v8ContextFile}`,
  );
  process.exit(1);
}

// Remove stale target if it exists
if (existsSync(target)) {
  unlinkSync(target);
}

renameSync(source, target);
console.log("  -> dist/snapshot/browser_v8_context_snapshot.bin");

// Clean up intermediate files
const intermediateEntry = resolve(snapshotDir, "snapshot-entry.js");
if (existsSync(intermediateEntry)) {
  unlinkSync(intermediateEntry);
}
const snapshotBlob = resolve(snapshotDir, "snapshot_blob.bin");
if (existsSync(snapshotBlob)) {
  unlinkSync(snapshotBlob);
}

console.log("V8 snapshot generation complete.");
