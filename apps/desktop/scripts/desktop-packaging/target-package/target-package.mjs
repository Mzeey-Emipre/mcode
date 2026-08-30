/**
 * Prepare Claude and Copilot SDK platform packages for the electron-builder target.
 *
 * Bun filters optional dependencies by host architecture. Cross-architecture
 * packaging therefore downloads missing target packages directly into Bun's
 * isolated store without changing package manifests or the lockfile.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { electronArchToNpm, electronPlatformToNpm, repoRootFromScript } from "../../../../../scripts/build-server-dev-bundle.mjs";
import {
  assertContained,
  assertPackageSpec,
  buildRegistryMetadataUrl,
  packageMetadataUsable,
  pathExists,
  readPlanTargetMetadata,
  resolveInstallRoot,
  verifyPackageIntegrity,
} from "./package-registry.mjs";
import {
  resolveClaudeTargetPackagePlan,
  resolveCopilotTargetPackagePlan,
  resolveHostDesktopTarget,
} from "../target-inventory/target-inventory.mjs";

export {
  assertContained,
  buildRegistryMetadataUrl,
  packageMetadataUsable,
  readLockPackageRecord,
  resolveInstallPackageDestination,
  resolveInstallRoot,
  verifyPackageIntegrity,
} from "./package-registry.mjs";
export {
  copilotSdkPlatformPackageName,
  resolveClaudeTargetPackagePlan,
  resolveCopilotTargetPackagePlan,
} from "../target-inventory/target-inventory.mjs";

const repoRoot = repoRootFromScript();
const serverRoot = resolve(repoRoot, "apps/server");

/** Download and extract one npm package into a bounded Bun-store destination. */
export async function downloadAndExtractPackage({
  packageName,
  version,
  destination,
  installRoot,
  plan,
  integrity,
  executable,
  chmodExecutable = false,
  registry = process.env.npm_config_registry ?? "https://registry.npmjs.org",
}) {
  assertPackageSpec(packageName, version);
  const resolvedInstallRoot = resolve(
    installRoot ?? resolveInstallRoot(destination),
  );
  assertContained(resolvedInstallRoot, destination);
  const tarballBytes = await downloadPackageTarball(registry, packageName, version);
  verifyPackageIntegrity(tarballBytes, integrity ?? plan?.integrity);
  const { tempDir, tarballPath } = createPackageTempDirectory(destination, resolvedInstallRoot);
  try {
    extractAndValidatePackage(tempDir, tarballPath, tarballBytes, packageName, plan, executable, chmodExecutable);
    replacePackageDestination(tempDir, destination, resolvedInstallRoot);
  } finally {
    removePackagePath(tarballPath);
    removePackageDirectory(tempDir);
  }
}

async function downloadPackageTarball(registry, packageName, version) {
  const metadataUrl = buildRegistryMetadataUrl(registry, packageName, version);
  const metadataResponse = await fetch(metadataUrl);
  if (!metadataResponse.ok) {
    throw new Error(`[ensure-sdk] Registry lookup failed for ${packageName}@${version}: HTTP ${metadataResponse.status}`);
  }
  const tarballUrl = (await metadataResponse.json()).dist?.tarball;
  if (!tarballUrl) throw new Error(`[ensure-sdk] Registry metadata for ${packageName}@${version} has no dist.tarball`);
  const tarballResponse = await fetch(tarballUrl);
  if (!tarballResponse.ok) {
    throw new Error(`[ensure-sdk] Tarball download failed (${tarballUrl}): HTTP ${tarballResponse.status}`);
  }
  return Buffer.from(await tarballResponse.arrayBuffer());
}

function createPackageTempDirectory(destination, installRoot) {
  const destinationParent = dirname(destination);
  assertContained(installRoot, destinationParent);
  mkdirSync(destinationParent, { recursive: true });
  const tempDir = mkdtempSync(join(destinationParent, `.${basename(destination)}-tmp-`));
  assertContained(installRoot, tempDir);
  return { tempDir, tarballPath: join(tempDir, "package.tgz") };
}

function extractAndValidatePackage(tempDir, tarballPath, tarballBytes, packageName, plan, executable, chmodExecutable) {
  writeFileSync(tarballPath, tarballBytes);
  execFileSync("tar", ["-xzf", "package.tgz", "--strip-components=1"], { cwd: tempDir, stdio: "inherit" });
  validateExtractedPackage(tempDir, packageName, plan, executable);
  if (executable && chmodExecutable) chmodSync(join(tempDir, executable), 0o755);
}

function validateExtractedPackage(tempDir, packageName, plan, executable) {
  if (plan && !packageMetadataUsable(JSON.parse(readFileSync(resolve(tempDir, "package.json"), "utf8")), plan)) {
    throw new Error(`[ensure-sdk] Downloaded package metadata mismatch for ${packageName}`);
  }
  if (!executable) return;
  const executablePath = resolve(tempDir, executable);
  if (!existsSync(executablePath) || !statSync(executablePath).isFile()) {
    throw new Error(`[ensure-sdk] Downloaded package executable missing for ${packageName}`);
  }
}

function replacePackageDestination(tempDir, destination, installRoot) {
  const backupPath = join(dirname(destination), `.${basename(destination)}-backup-${randomUUID()}`);
  assertContained(installRoot, backupPath);
  let movedExisting = false;
  try {
    if (pathExists(destination)) {
      renameSync(destination, backupPath);
      movedExisting = true;
    }
    renameSync(tempDir, destination);
    if (movedExisting) removePackageDirectory(backupPath);
  } catch (error) {
    restorePackageDestination(destination, backupPath, movedExisting);
    throw error;
  } finally {
    removePackageDirectory(backupPath);
  }
}

function restorePackageDestination(destination, backupPath, movedExisting) {
  removePackageDirectory(destination);
  if (movedExisting && pathExists(backupPath)) renameSync(backupPath, destination);
}

function removePackagePath(filePath) {
  if (pathExists(filePath)) rmSync(filePath, { force: true });
}

function removePackageDirectory(directoryPath) {
  if (pathExists(directoryPath)) rmSync(directoryPath, { recursive: true, force: true });
}

/** Forward a resolved package plan through shared download mechanics. */
export async function downloadTargetPackage(
  plan,
  downloader = downloadAndExtractPackage,
) {
  return downloader({ ...plan, packageName: plan.packageName, plan });
}

/** Ensure both SDK platform packages exist for a packaging target. */
export async function prepareSdkPlatformPackages({
  serverPackageRoot = serverRoot,
  platform = electronPlatformToNpm(process.platform),
  arch = process.env.MCODE_TARGET_ARCH?.trim()
    ? electronArchToNpm(process.env.MCODE_TARGET_ARCH.trim())
    : process.arch,
} = {}) {
  const target = resolveHostDesktopTarget({ platform, arch });
  const targetPlatform = { windows: "win32", macos: "darwin", linux: "linux" }[
    target.platform
  ];
  const claudePlan = resolveClaudeTargetPackagePlan(
    serverPackageRoot,
    targetPlatform,
    target.arch,
  );
  await ensureTargetPackage("Claude", claudePlan, target.id, serverPackageRoot);

  const copilotPlan = resolveCopilotTargetPackagePlan(
    serverPackageRoot,
    targetPlatform,
    target.arch,
  );
  await ensureTargetPackage("Copilot", copilotPlan, target.id, serverPackageRoot);
}

async function ensureTargetPackage(label, plan, targetId, serverPackageRoot) {
  if (readPlanTargetMetadata(plan, serverPackageRoot)) {
    console.log(`[ensure-sdk] ${label} target package already installed (${targetId})`);
    return;
  }
  console.log(`[ensure-sdk] Downloading ${plan.packageName}@${plan.version} for ${targetId}...`);
  await downloadTargetPackage(plan);
  if (!readPlanTargetMetadata(plan, serverPackageRoot)) {
    throw new Error(`[ensure-sdk] Installed ${label} package failed validation: ${plan.packageName}`);
  }
  console.log(`[ensure-sdk] Installed ${plan.packageName} at ${plan.destination}`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await prepareSdkPlatformPackages();
}
