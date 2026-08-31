/**
 * electron-builder afterPack hook.
 *
 * 1. Built renamed `mcode-server` Electron binary (before fuse flip)
 * 2. Copied Claude Agent SDK native CLI into the asar-unpacked server tree
 * 3. Copied Copilot SDK's bundled CLI package tree into the asar-unpacked server tree
 * 4. Restored node-pty's Windows ConPTY runtime after the native rebuild
 * 5. Copied browser V8 snapshot (when generated) and flipped security fuses
 *
 * This script is invoked automatically by electron-builder via the
 * "afterPack" config in package.json.
 */

import { flipFuses, FuseVersion, FuseV1Options } from "@electron/fuses";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import {
  buildServerBinary,
} from "./build-server-binary.mjs";
import {
  copyClaudeSdkCliToDir,
  copyCopilotSdkToDir,
  electronArchToNpm,
  electronPlatformToNpm,
  resolvePackagedServerDir,
} from "../../../../../scripts/build-server-dev-bundle.mjs";
import { ensurePackagedConptyRuntime } from "./packaged-node-pty.mjs";
import { retainTargetTerminalNativeArtifacts } from "../package-validation/terminal-artifact-attestation.mjs";

/**
 * @param {import("electron-builder").AfterPackContext} context
 */
export default async function afterPack(context) {
  const { electronPlatformName, appOutDir } = context;
  const desktopRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..", "..", "..");
  const snapshotFile = NodePath.resolve(
    desktopRoot,
    "dist/snapshot/browser_v8_context_snapshot.bin",
  );

  // -------------------------------------------------------------------------
  // Step 1: Produce renamed server binary BEFORE the fuse flip. The server
  // binary runs with ELECTRON_RUN_AS_NODE=1 and must NOT have the browser
  // V8 snapshot fuse enabled, otherwise it crashes trying to load a snapshot
  // file that isn't alongside it.
  // -------------------------------------------------------------------------

  const productFilename =
    context.packager.appInfo.productFilename ??
    context.packager.appInfo.productName;
  // Windows VERSIONINFO requires a numeric dotted quad (x.x.x.x) where each
  // segment fits in [0, 65535]. Parse only the semver core (major.minor.patch)
  // and derive a bounded fourth segment from the prerelease metadata. Nightly
  // versions like "0.11.1-nightly.20260518.42" contain a date segment that
  // exceeds 65535, so we use the run number (last prerelease segment) instead.
  const appVersion = toWindowsVersion(context.packager.appInfo.version);
  const companyName = context.packager.appInfo.companyName ?? "Mcode";
  // Stamp the app favicon onto the win32 server binary so Task Manager shows it
  // instead of a generic icon. resedit ignores this on non-win32 platforms.
  const winIconPath = NodePath.resolve(desktopRoot, "build", "icon.ico");

  // The renamed copy at Contents/Resources/bin/mcode-server is co-signed by
  // electron-builder via the `mac.binaries` entry in package.json, so it
  // passes notarytool when notarization is enabled.
  await buildServerBinary({
    appOutDir: context.appOutDir,
    electronPlatformName,
    productFilename,
    executableName: context.packager.executableName,
    appVersion,
    companyName,
    iconPath: NodeFS.existsSync(winIconPath) ? winIconPath : undefined,
  });

  console.log("[after-pack] Built renamed server binary");

  // -------------------------------------------------------------------------
  // Step 1b: Copy Claude Agent SDK native CLI into asar-unpacked server tree.
  // electron-builder excludes nested node_modules from the default files filter,
  // so build-time staging under dist/server/node_modules does not survive packaging.
  // -------------------------------------------------------------------------

  const sourceRepoRoot = process.env.MCODE_PACKAGING_SOURCE_ROOT
    ? NodePath.resolve(process.env.MCODE_PACKAGING_SOURCE_ROOT)
    : NodePath.resolve(desktopRoot, "..", "..");
  const serverPackageRoot = NodePath.resolve(sourceRepoRoot, "apps", "server");
  const npmPlatform = electronPlatformToNpm(electronPlatformName);
  const npmArch = electronArchToNpm(context.arch);
  const packagedServerDir = resolvePackagedServerDir({
    appOutDir,
    electronPlatformName,
    productFilename,
  });
  const { platformPkg, binDst } = copyClaudeSdkCliToDir({
    destServerDir: packagedServerDir,
    serverPackageRoot,
    platform: npmPlatform,
    arch: npmArch,
  });
  console.log(`[after-pack] Copied Claude SDK CLI (${platformPkg}) to ${binDst}`);

  const { platformPkg: copilotPlatformPkg, copilotDst } = copyCopilotSdkToDir({
    destServerDir: packagedServerDir,
    serverPackageRoot,
    platform: npmPlatform,
    arch: npmArch,
  });
  console.log(`[after-pack] Copied Copilot SDK packages (${copilotPlatformPkg}) to ${copilotDst}`);

  if (npmPlatform === "win32") {
    const nodePtyRoot = NodePath.resolve(
      packagedServerDir,
      "..",
      "..",
      "node_modules",
      "node-pty",
    );
    // Keep this mandatory: electron-builder can retain conpty.node while
    // dropping its runtime files, which makes every packaged terminal fail.
    const { dllPath } = ensurePackagedConptyRuntime({
      nodePtyRoot,
      arch: npmArch,
    });
    console.log(`[after-pack] Restored packaged ConPTY runtime at ${dllPath}`);
  }

  retainTargetTerminalNativeArtifacts({
    resourcesRoot: NodePath.resolve(packagedServerDir, "../../.."),
    targetPlatform: npmPlatform,
    targetArch: npmArch,
  });

  // -------------------------------------------------------------------------
  // Step 2: V8 snapshot copy + fuse flip.
  // This runs AFTER the server binary copy so only the main Electron binary
  // (used for the GUI) gets the fuses — not the ELECTRON_RUN_AS_NODE copy.
  //
  // The snapshot copy is conditional on the snapshot file existing, but the
  // fuse flip is always performed so that EnableNodeCliInspectArguments is
  // disabled on every packaged build regardless of snapshot presence.
  // -------------------------------------------------------------------------

  await configureBrowserSnapshotAndFuses(context, snapshotFile);
}

function toWindowsVersion(rawVersion) {
  const semverCore = rawVersion.match(/^(\d+)\.(\d+)\.(\d+)/);
  const [major, minor, patch] = semverCore ? [semverCore[1], semverCore[2], semverCore[3]] : ["0", "0", "0"];
  const prerelease = rawVersion.replace(/^\d+\.\d+\.\d+[-.]?/, "");
  const preNums = prerelease.match(/\d+/g);
  const fourth = preNums ? String(Math.min(Number(preNums[preNums.length - 1]), 65535)) : "0";
  return `${major}.${minor}.${patch}.${fourth}`;
}

async function configureBrowserSnapshotAndFuses(context, snapshotFile) {
  const hasSnapshot = NodeFS.existsSync(snapshotFile);
  const electronBinary = packagedElectronBinary(context);
  if (hasSnapshot) {
    const snapshotDest = packagedSnapshotPath(context);
    console.log(`[after-pack] Copying snapshot to ${snapshotDest}`);
    NodeFS.copyFileSync(snapshotFile, snapshotDest);
  } else {
    console.log("[after-pack] No snapshot found, skipping snapshot copy");
  }
  console.log(`[after-pack] Flipping security fuses on ${electronBinary}`);
  await flipFuses(electronBinary, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: isMacPlatform(context.electronPlatformName),
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: hasSnapshot,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
  });
  console.log("[after-pack] Security fuses applied");
}

function isMacPlatform(platform) {
  return platform === "darwin" || platform === "mas";
}

function packagedElectronBinary(context) {
  const { electronPlatformName, appOutDir, packager } = context;
  const productFilename = packager.appInfo.productFilename;
  if (isMacPlatform(electronPlatformName)) return NodePath.join(appOutDir, `${productFilename}.app`, "Contents", "MacOS", productFilename);
  if (electronPlatformName === "win32") return NodePath.join(appOutDir, `${productFilename}.exe`);
  return NodePath.join(appOutDir, packager.executableName);
}

function packagedSnapshotPath(context) {
  const { electronPlatformName, appOutDir, packager } = context;
  if (!isMacPlatform(electronPlatformName)) return NodePath.join(appOutDir, "browser_v8_context_snapshot.bin");
  const frameworkDir = NodePath.join(appOutDir, `${packager.appInfo.productFilename}.app`, "Contents/Frameworks/Electron Framework.framework/Resources");
  return NodePath.join(frameworkDir, "browser_v8_context_snapshot.bin");
}
