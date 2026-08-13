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
  const metadataUrl = buildRegistryMetadataUrl(registry, packageName, version);
  const metadataResponse = await fetch(metadataUrl);
  if (!metadataResponse.ok) {
    throw new Error(
      `[ensure-sdk] Registry lookup failed for ${packageName}@${version}: HTTP ${metadataResponse.status}`,
    );
  }
  const tarballUrl = (await metadataResponse.json()).dist?.tarball;
  if (!tarballUrl) {
    throw new Error(
      `[ensure-sdk] Registry metadata for ${packageName}@${version} has no dist.tarball`,
    );
  }

  const tarballResponse = await fetch(tarballUrl);
  if (!tarballResponse.ok) {
    throw new Error(
      `[ensure-sdk] Tarball download failed (${tarballUrl}): HTTP ${tarballResponse.status}`,
    );
  }

  const tarballBytes = Buffer.from(await tarballResponse.arrayBuffer());
  verifyPackageIntegrity(tarballBytes, integrity ?? plan?.integrity);

  const destinationParent = dirname(destination);
  assertContained(resolvedInstallRoot, destinationParent);
  mkdirSync(destinationParent, { recursive: true });
  const tempDir = mkdtempSync(
    join(destinationParent, `.${basename(destination)}-tmp-`),
  );
  assertContained(resolvedInstallRoot, tempDir);
  const tarballPath = join(tempDir, "package.tgz");
  try {
    writeFileSync(tarballPath, tarballBytes);
    execFileSync("tar", ["-xzf", "package.tgz", "--strip-components=1"], {
      cwd: tempDir,
      stdio: "inherit",
    });
    if (plan) {
      const metadata = JSON.parse(
        readFileSync(resolve(tempDir, "package.json"), "utf8"),
      );
      if (!packageMetadataUsable(metadata, plan)) {
        throw new Error(
          `[ensure-sdk] Downloaded package metadata mismatch for ${packageName}`,
        );
      }
    }
    const executablePath = executable
      ? resolve(tempDir, executable)
      : undefined;
    if (
      executablePath &&
      (!existsSync(executablePath) || !statSync(executablePath).isFile())
    ) {
      throw new Error(
        `[ensure-sdk] Downloaded package executable missing for ${packageName}`,
      );
    }
    if (executable && chmodExecutable) {
      chmodSync(join(tempDir, executable), 0o755);
    }

    const backupPath = join(
      destinationParent,
      `.${basename(destination)}-backup-${randomUUID()}`,
    );
    assertContained(resolvedInstallRoot, backupPath);
    let movedExisting = false;
    try {
      if (pathExists(destination)) {
        renameSync(destination, backupPath);
        movedExisting = true;
      }
      renameSync(tempDir, destination);
      if (movedExisting) rmSync(backupPath, { recursive: true, force: true });
    } catch (error) {
      if (pathExists(destination))
        rmSync(destination, { recursive: true, force: true });
      if (movedExisting && pathExists(backupPath))
        renameSync(backupPath, destination);
      throw error;
    } finally {
      if (pathExists(backupPath))
        rmSync(backupPath, { recursive: true, force: true });
    }
  } finally {
    if (pathExists(tarballPath)) rmSync(tarballPath, { force: true });
    if (pathExists(tempDir)) rmSync(tempDir, { recursive: true, force: true });
  }
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
  if (readPlanTargetMetadata(claudePlan, serverPackageRoot)) {
    console.log(
      `[ensure-sdk] Claude target package already installed (${target.id})`,
    );
  } else {
    console.log(
      `[ensure-sdk] Downloading ${claudePlan.packageName}@${claudePlan.version} for ${target.id}...`,
    );
    await downloadTargetPackage(claudePlan);
    if (!readPlanTargetMetadata(claudePlan, serverPackageRoot)) {
      throw new Error(
        `[ensure-sdk] Installed Claude package failed validation: ${claudePlan.packageName}`,
      );
    }
    console.log(
      `[ensure-sdk] Installed ${claudePlan.packageName} at ${claudePlan.destination}`,
    );
  }

  const copilotPlan = resolveCopilotTargetPackagePlan(
    serverPackageRoot,
    targetPlatform,
    target.arch,
  );
  if (readPlanTargetMetadata(copilotPlan, serverPackageRoot)) {
    console.log(
      `[ensure-sdk] Copilot target package already installed (${target.id})`,
    );
  } else {
    console.log(
      `[ensure-sdk] Downloading ${copilotPlan.packageName}@${copilotPlan.version} for ${target.id}...`,
    );
    await downloadTargetPackage(copilotPlan);
    if (!readPlanTargetMetadata(copilotPlan, serverPackageRoot)) {
      throw new Error(
        `[ensure-sdk] Installed Copilot package failed validation: ${copilotPlan.packageName}`,
      );
    }
    console.log(
      `[ensure-sdk] Installed ${copilotPlan.packageName} at ${copilotPlan.destination}`,
    );
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await prepareSdkPlatformPackages();
}
