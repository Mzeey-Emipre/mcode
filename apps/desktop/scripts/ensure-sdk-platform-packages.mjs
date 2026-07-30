/**
 * Prepare Claude and Copilot SDK platform packages for the electron-builder target.
 *
 * Bun filters optional dependencies by host architecture. Cross-architecture
 * packaging therefore downloads missing target packages directly into Bun's
 * isolated store without changing package manifests or the lockfile.
 */

import { execFileSync } from "node:child_process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
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
const packageNamePattern =
  /^@[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

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

function packageLockPath(serverPackageRoot) {
  return resolve(serverPackageRoot, "..", "..", "bun.lock");
}

function assertPackageSpec(packageName, version) {
  if (
    !packageNamePattern.test(packageName) ||
    packageName
      .split("/")
      .some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(`[ensure-sdk] Unsupported package name: ${packageName}`);
  }
  if (typeof version !== "string" || !semverPattern.test(version)) {
    throw new Error(
      `[ensure-sdk] Unsupported package version for ${packageName}`,
    );
  }
}

/** Read exact package metadata and integrity from Bun's lockfile. */
export function readLockPackageRecord(lockfilePath, packageName, version) {
  assertPackageSpec(packageName, version);
  const expectedIdentity = `${packageName}@${version}`;
  for (const line of readFileSync(lockfilePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(`"${packageName}":`)) continue;
    let record;
    try {
      record = JSON.parse(`{${trimmed.replace(/,$/, "")}}`)[packageName];
    } catch {
      throw new Error(
        `[ensure-sdk] Invalid lockfile record for ${packageName}`,
      );
    }
    if (!Array.isArray(record) || record[0] !== expectedIdentity) {
      throw new Error(
        `[ensure-sdk] Lockfile version mismatch for ${packageName}@${version}`,
      );
    }
    const integrity = record[3];
    if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) {
      throw new Error(
        `[ensure-sdk] Lockfile integrity missing for ${expectedIdentity}`,
      );
    }
    return { integrity, metadata: record[2] ?? {} };
  }
  throw new Error(
    `[ensure-sdk] Lockfile record missing for ${expectedIdentity}`,
  );
}

/** Validate downloaded bytes against a Bun lockfile SHA-512 integrity string. */
export function verifyPackageIntegrity(bytes, integrity) {
  if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) {
    throw new Error("[ensure-sdk] Invalid SHA-512 integrity");
  }
  const expected = Buffer.from(integrity.slice("sha512-".length), "base64");
  const actual = createHash("sha512").update(bytes).digest();
  if (expected.length !== actual.length || !timingSafeEqual(actual, expected)) {
    throw new Error("[ensure-sdk] Package integrity mismatch");
  }
}

/** Build a registry metadata URL from validated, encoded npm path segments. */
export function buildRegistryMetadataUrl(registry, packageName, version) {
  assertPackageSpec(packageName, version);
  const url = new URL(registry);
  if (
    !(url.protocol === "https:" || url.protocol === "http:") ||
    url.username ||
    url.password
  ) {
    throw new Error(
      "[ensure-sdk] Registry must be an HTTP(S) URL without credentials",
    );
  }
  const path = url.pathname.replace(/\/+$/, "");
  const segments = packageName
    .split("/")
    .concat(version)
    .map(encodeURIComponent);
  url.pathname = `${path}/${segments.join("/")}`;
  return url.toString();
}

function pathExists(target) {
  try {
    lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

function assertContained(storeRoot, target) {
  const root = resolve(storeRoot);
  const candidate = resolve(target);
  const separator = root.includes("\\") ? "\\" : "/";
  if (candidate === root || !candidate.startsWith(`${root}${separator}`)) {
    throw new Error(`[ensure-sdk] Destination escapes Bun store: ${target}`);
  }
}

/** Check installed target package metadata and executable contract. */
export function packageMetadataUsable(metadata, plan) {
  const hasTarget = (value, target) =>
    Array.isArray(value) ? value.includes(target) : value === target;
  if (
    metadata?.name !== plan.platformPkg ||
    metadata?.version !== plan.version ||
    !hasTarget(metadata.os, plan.platform) ||
    !hasTarget(metadata.cpu, plan.arch)
  ) {
    return false;
  }
  if (metadata.bin) {
    const bins =
      typeof metadata.bin === "string"
        ? [metadata.bin]
        : Object.values(metadata.bin);
    if (!bins.includes(plan.executable)) return false;
  }
  return true;
}

function planLockData(plan, serverPackageRoot) {
  const lock = readLockPackageRecord(
    packageLockPath(serverPackageRoot),
    plan.platformPkg,
    plan.version,
  );
  return { ...plan, ...lock };
}

function readPlanTargetMetadata(plan, serverPackageRoot) {
  try {
    const source =
      plan.kind === "claude"
        ? resolveClaudeSdkCliSources(
            serverPackageRoot,
            plan.platform,
            plan.arch,
          )
        : resolveCopilotSdkSources(serverPackageRoot, plan.platform, plan.arch);
    const packageDir =
      plan.kind === "claude"
        ? dirname(source.binSrc)
        : source.platformPackageDir;
    const metadata = JSON.parse(
      readFileSync(resolve(packageDir, "package.json"), "utf8"),
    );
    const executablePath = resolve(packageDir, plan.executable);
    return (
      packageMetadataUsable(metadata, plan) &&
      existsSync(executablePath) &&
      statSync(executablePath).isFile()
    );
  } catch {
    return false;
  }
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
  return planLockData(
    {
      kind: "claude",
      platform,
      arch,
      platformPkg,
      version: readPackageVersion(dirname(sdkEntry)),
      destination: resolve(dirname(sdkEntry), "..", basename(platformPkg)),
      bunStoreRoot: resolveBunStoreRoot(sdkEntry),
      executable: platform === "win32" ? "claude.exe" : "claude",
      chmodExecutable: platform !== "win32",
    },
    serverPackageRoot,
  );
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
  return planLockData(
    {
      kind: "copilot",
      platform,
      arch,
      platformPkg,
      version,
      destination: bunStorePackageDestination(copilotPackageDir, platformPkg),
      bunStoreRoot: resolveBunStoreRoot(copilotPackageDir),
      executable: platform === "win32" ? "copilot.exe" : "copilot",
      chmodExecutable: platform !== "win32",
    },
    serverPackageRoot,
  );
}

/** Download and extract one npm package into a bounded Bun-store destination. */
export async function downloadAndExtractPackage({
  packageName,
  version,
  destination,
  bunStoreRoot,
  plan,
  integrity,
  executable,
  chmodExecutable = false,
  registry = process.env.npm_config_registry ?? "https://registry.npmjs.org",
}) {
  assertPackageSpec(packageName, version);
  const resolvedStoreRoot = resolve(
    bunStoreRoot ?? resolveBunStoreRoot(destination),
  );
  assertContained(resolvedStoreRoot, destination);
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
  assertContained(resolvedStoreRoot, destinationParent);
  mkdirSync(destinationParent, { recursive: true });
  const tempDir = mkdtempSync(
    join(destinationParent, `.${basename(destination)}-tmp-`),
  );
  assertContained(resolvedStoreRoot, tempDir);
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
    assertContained(resolvedStoreRoot, backupPath);
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
  if (readPlanTargetMetadata(claudePlan, serverPackageRoot)) {
    console.log(
      `[ensure-sdk] Claude target package already installed (${platform}-${arch})`,
    );
  } else {
    console.log(
      `[ensure-sdk] Downloading ${claudePlan.platformPkg}@${claudePlan.version} for ${platform}-${arch}...`,
    );
    await downloadAndExtractPackage({ ...claudePlan, plan: claudePlan });
    if (!readPlanTargetMetadata(claudePlan, serverPackageRoot)) {
      throw new Error(
        `[ensure-sdk] Installed Claude package failed validation: ${claudePlan.platformPkg}`,
      );
    }
    console.log(
      `[ensure-sdk] Installed ${claudePlan.platformPkg} at ${claudePlan.destination}`,
    );
  }

  const copilotPlan = resolveCopilotTargetPackagePlan(
    serverPackageRoot,
    platform,
    arch,
  );
  if (readPlanTargetMetadata(copilotPlan, serverPackageRoot)) {
    console.log(
      `[ensure-sdk] Copilot target package already installed (${platform}-${arch})`,
    );
  } else {
    console.log(
      `[ensure-sdk] Downloading ${copilotPlan.platformPkg}@${copilotPlan.version} for ${platform}-${arch}...`,
    );
    await downloadAndExtractPackage({ ...copilotPlan, plan: copilotPlan });
    if (!readPlanTargetMetadata(copilotPlan, serverPackageRoot)) {
      throw new Error(
        `[ensure-sdk] Installed Copilot package failed validation: ${copilotPlan.platformPkg}`,
      );
    }
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
