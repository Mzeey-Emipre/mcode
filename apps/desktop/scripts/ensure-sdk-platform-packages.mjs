/**
 * Prepare Claude and Copilot SDK platform packages for the electron-builder target.
 *
 * Bun filters optional dependencies by host architecture. Cross-architecture
 * packaging therefore downloads missing target packages directly into Bun's
 * isolated store without changing package manifests or the lockfile.
 */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  claudeSdkPlatformPackageCandidates,
  copilotSdkPlatformPackageName,
  electronArchToNpm,
  electronPlatformToNpm,
  repoRootFromScript,
  resolveClaudeSdkCliSources,
  resolveCopilotSdkSources,
} from "../../../scripts/build-server-dev-bundle.mjs";

export { copilotSdkPlatformPackageName };

const repoRoot = repoRootFromScript();
const serverRoot = resolve(repoRoot, "apps/server");
const supportedArchitectures = new Set(["x64", "arm64", "ia32", "arm"]);

function readPackageVersion(packageDir) {
  return JSON.parse(readFileSync(resolve(packageDir, "package.json"), "utf8"))
    .version;
}

function resolveBunStoreRoot(entryPath) {
  let current = resolve(entryPath);
  while (current !== dirname(current)) {
    if (basename(current) === ".bun") return current;
    current = dirname(current);
  }
  throw new Error(`[ensure-sdk] Cannot locate Bun store for ${entryPath}`);
}

function bunStorePackageDestination(entryPath, packageName) {
  const scope = dirname(packageName);
  const name = basename(packageName);
  return resolve(resolveBunStoreRoot(entryPath), "node_modules", scope, name);
}

/** Resolve the Claude platform package and version to prepare. */
export function resolveClaudeTargetPackagePlan(
  serverPackageRoot,
  platform,
  arch,
) {
  const serverRequire = createRequire(
    resolve(serverPackageRoot, "package.json"),
  );
  const sdkEntry = serverRequire.resolve("@anthropic-ai/claude-agent-sdk");
  const platformPkg = claudeSdkPlatformPackageCandidates(platform, arch)[0];
  return {
    platformPkg,
    version: readPackageVersion(dirname(sdkEntry)),
    destination: resolve(dirname(sdkEntry), "..", basename(platformPkg)),
    executable: platform === "win32" ? undefined : "claude",
    chmodExecutable: platform !== "win32",
  };
}

/** Resolve the Copilot target package and installed CLI version to prepare. */
export function resolveCopilotTargetPackagePlan(
  serverPackageRoot,
  platform,
  arch,
) {
  const serverRequire = createRequire(
    resolve(serverPackageRoot, "package.json"),
  );
  const sdkEntry = serverRequire.resolve("@github/copilot-sdk");
  const copilotPackageDir = resolve(
    dirname(sdkEntry),
    "..",
    "..",
    "..",
    "copilot",
  );
  const platformPkg = copilotSdkPlatformPackageName(platform, arch);
  const version = readPackageVersion(copilotPackageDir);
  return {
    platformPkg,
    version,
    destination: bunStorePackageDestination(copilotPackageDir, platformPkg),
    executable: platform === "win32" ? "copilot.exe" : "copilot",
    chmodExecutable: platform !== "win32",
  };
}

/** Download and extract one npm package into a bounded Bun-store destination. */
export async function downloadAndExtractPackage({
  packageName,
  version,
  destination,
  executable,
  chmodExecutable = false,
  registry = process.env.npm_config_registry ?? "https://registry.npmjs.org",
}) {
  if (!/^@[^/]+\/[A-Za-z0-9._-]+$/.test(packageName)) {
    throw new Error(`[ensure-sdk] Unsupported package name: ${packageName}`);
  }
  if (typeof version !== "string" || !/^[A-Za-z0-9.+-]+$/.test(version)) {
    throw new Error(`[ensure-sdk] Unsupported package version for ${packageName}`);
  }
  const normalizedRegistry = registry.replace(/\/+$/, "");
  const metadataUrl = `${normalizedRegistry}/${packageName}/${version}`;
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

  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  const tarballPath = join(destination, "package.tgz");
  try {
    writeFileSync(
      tarballPath,
      Buffer.from(await tarballResponse.arrayBuffer()),
    );
    execFileSync("tar", ["-xzf", "package.tgz", "--strip-components=1"], {
      cwd: destination,
      stdio: "inherit",
    });
  } finally {
    rmSync(tarballPath, { force: true });
  }
  if (executable && chmodExecutable) {
    chmodSync(join(destination, executable), 0o755);
  }
}

/** Ensure both SDK platform packages exist for a packaging target. */
export async function prepareSdkPlatformPackages({
  serverPackageRoot = serverRoot,
  platform = electronPlatformToNpm(process.platform),
  arch = process.env.MCODE_TARGET_ARCH?.trim()
    ? electronArchToNpm(process.env.MCODE_TARGET_ARCH.trim())
    : process.arch,
} = {}) {
  if (!supportedArchitectures.has(arch)) {
    throw new Error(`[ensure-sdk] Unsupported target architecture: ${arch}`);
  }
  const claudePlan = resolveClaudeTargetPackagePlan(
    serverPackageRoot,
    platform,
    arch,
  );
  try {
    resolveClaudeSdkCliSources(serverPackageRoot, platform, arch);
    console.log(
      `[ensure-sdk] Claude target package already installed (${platform}-${arch})`,
    );
  } catch {
    console.log(
      `[ensure-sdk] Downloading ${claudePlan.platformPkg}@${claudePlan.version} for ${platform}-${arch}...`,
    );
    await downloadAndExtractPackage(claudePlan);
    resolveClaudeSdkCliSources(serverPackageRoot, platform, arch);
    console.log(
      `[ensure-sdk] Installed ${claudePlan.platformPkg} at ${claudePlan.destination}`,
    );
  }

  const copilotPlan = resolveCopilotTargetPackagePlan(
    serverPackageRoot,
    platform,
    arch,
  );
  try {
    resolveCopilotSdkSources(serverPackageRoot, platform, arch);
    console.log(
      `[ensure-sdk] Copilot target package already installed (${platform}-${arch})`,
    );
  } catch {
    console.log(
      `[ensure-sdk] Downloading ${copilotPlan.platformPkg}@${copilotPlan.version} for ${platform}-${arch}...`,
    );
    await downloadAndExtractPackage(copilotPlan);
    resolveCopilotSdkSources(serverPackageRoot, platform, arch);
    console.log(
      `[ensure-sdk] Installed ${copilotPlan.platformPkg} at ${copilotPlan.destination}`,
    );
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await prepareSdkPlatformPackages();
}
