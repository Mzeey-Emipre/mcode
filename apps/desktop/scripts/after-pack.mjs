/**
 * electron-builder afterPack hook.
 *
 * 1. Copies browser_v8_context_snapshot.bin into the packaged app resources
 * 2. Flips the LoadBrowserProcessSpecificV8Snapshot fuse on the Electron binary
 *
 * This script is invoked automatically by electron-builder via the
 * "afterPack" config in package.json.
 */

import { flipFuses, FuseVersion, FuseV1Options } from "@electron/fuses";
import { copyFileSync, existsSync } from "fs";
import { resolve, join, dirname } from "path";
import { fileURLToPath } from "url";

/**
 * @param {import("electron-builder").AfterPackContext} context
 */
export default async function afterPack(context) {
  const { electronPlatformName, appOutDir } = context;
  const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const snapshotFile = resolve(
    desktopRoot,
    "dist/snapshot/browser_v8_context_snapshot.bin",
  );

  // Skip if snapshot was not generated (e.g. dev builds)
  if (!existsSync(snapshotFile)) {
    console.log("[after-pack] No snapshot found, skipping fuse configuration");
    return;
  }

  // -------------------------------------------------------------------------
  // Step 1: Copy snapshot blob to the correct platform-specific location
  // -------------------------------------------------------------------------

  let snapshotDest;
  let electronBinary;

  if (electronPlatformName === "darwin") {
    const frameworkDir = join(
      appOutDir,
      `${context.packager.appInfo.productFilename}.app`,
      "Contents/Frameworks/Electron Framework.framework/Resources",
    );
    snapshotDest = join(frameworkDir, "browser_v8_context_snapshot.bin");
    electronBinary = join(
      appOutDir,
      `${context.packager.appInfo.productFilename}.app`,
      "Contents/Frameworks/Electron Framework.framework/Electron Framework",
    );
  } else if (electronPlatformName === "win32") {
    snapshotDest = join(appOutDir, "browser_v8_context_snapshot.bin");
    electronBinary = join(
      appOutDir,
      `${context.packager.appInfo.productFilename}.exe`,
    );
  } else {
    snapshotDest = join(appOutDir, "browser_v8_context_snapshot.bin");
    electronBinary = join(appOutDir, context.packager.executableName);
  }

  console.log(`[after-pack] Copying snapshot to ${snapshotDest}`);
  copyFileSync(snapshotFile, snapshotDest);

  // -------------------------------------------------------------------------
  // Step 2: Flip the LoadBrowserProcessSpecificV8Snapshot fuse
  // -------------------------------------------------------------------------

  console.log(`[after-pack] Flipping V8 snapshot fuse on ${electronBinary}`);
  await flipFuses(electronBinary, {
    version: FuseVersion.V1,
    // On ARM64 macOS, flipping fuses invalidates the ad-hoc code signature.
    // Reset it so the binary can launch before electron-builder codesigns.
    resetAdHocDarwinSignature: electronPlatformName === "darwin",
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: true,
  });

  console.log("[after-pack] V8 snapshot fuse enabled");
}
