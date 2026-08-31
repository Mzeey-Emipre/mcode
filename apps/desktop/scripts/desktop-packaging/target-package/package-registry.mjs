import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { resolveClaudeSdkCliSources, resolveCopilotSdkSources } from "../../../../../scripts/build-server-dev-bundle.mjs";

const packageNamePattern =
  /^@[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Finds the nearest node_modules directory containing a package graph. */
export function resolveInstallRoot(entryPath) {
  let current = NodePath.resolve(entryPath);
  while (current !== NodePath.dirname(current)) {
    if (NodePath.basename(current) === "node_modules") return current;
    current = NodePath.dirname(current);
  }
  throw new Error(`[ensure-sdk] Cannot locate install root for ${entryPath}`);
}

/** Resolves a scoped target package beneath its SDK package graph. */
export function resolveInstallPackageDestination(entryPath, packageName) {
  return NodePath.resolve(resolveInstallRoot(entryPath), NodePath.dirname(packageName), NodePath.basename(packageName));
}

/** Validates an npm package name and semantic version before registry access. */
export function assertPackageSpec(packageName, version) {
  if (
    !packageNamePattern.test(packageName) ||
    packageName.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(`[ensure-sdk] Unsupported package name: ${packageName}`);
  }
  if (typeof version !== "string" || !semverPattern.test(version)) {
    throw new Error(`[ensure-sdk] Unsupported package version for ${packageName}`);
  }
}

/** Reads exact package metadata and integrity from Bun's lockfile. */
export function readLockPackageRecord(lockfilePath, packageName, version) {
  assertPackageSpec(packageName, version);
  const expectedIdentity = `${packageName}@${version}`;
  for (const line of NodeFS.readFileSync(lockfilePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(`"${packageName}":`)) continue;
    let record;
    try {
      record = JSON.parse(`{${trimmed.replace(/,$/, "")}}`)[packageName];
    } catch {
      throw new Error(`[ensure-sdk] Invalid lockfile record for ${packageName}`);
    }
    if (!Array.isArray(record) || record[0] !== expectedIdentity) {
      throw new Error(`[ensure-sdk] Lockfile version mismatch for ${expectedIdentity}`);
    }
    const integrity = record[3];
    if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) {
      throw new Error(`[ensure-sdk] Lockfile integrity missing for ${expectedIdentity}`);
    }
    return { integrity, metadata: record[2] ?? {} };
  }
  throw new Error(`[ensure-sdk] Lockfile record missing for ${expectedIdentity}`);
}

/** Validates downloaded bytes against a Bun lockfile SHA-512 integrity string. */
export function verifyPackageIntegrity(bytes, integrity) {
  if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) {
    throw new Error("[ensure-sdk] Invalid SHA-512 integrity");
  }
  const expected = Buffer.from(integrity.slice("sha512-".length), "base64");
  const actual = NodeCrypto.createHash("sha512").update(bytes).digest();
  if (expected.length !== actual.length || !NodeCrypto.timingSafeEqual(actual, expected)) {
    throw new Error("[ensure-sdk] Package integrity mismatch");
  }
}

/** Builds a registry metadata URL from validated, encoded npm path segments. */
export function buildRegistryMetadataUrl(registry, packageName, version) {
  assertPackageSpec(packageName, version);
  const url = new URL(registry);
  if (!(url.protocol === "https:" || url.protocol === "http:") || url.username || url.password) {
    throw new Error("[ensure-sdk] Registry must be an HTTP(S) URL without credentials");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${packageName
    .split("/")
    .concat(version)
    .map(encodeURIComponent)
    .join("/")}`;
  return url.toString();
}

/** Checks the installed target package metadata and executable contract. */
export function packageMetadataUsable(metadata, plan) {
  const hasTarget = (value, target) =>
    Array.isArray(value) ? value.includes(target) : value === target;
  if (
    metadata?.name !== plan.packageName ||
    metadata?.version !== plan.version ||
    !hasTarget(metadata.os, plan.platform) ||
    !hasTarget(metadata.cpu, plan.arch)
  ) return false;
  if (metadata.bin) {
    const bins = typeof metadata.bin === "string" ? [metadata.bin] : Object.values(metadata.bin);
    if (!bins.includes(plan.executable)) return false;
  }
  return true;
}

/** Checks whether the target package is already present and valid. */
export function readPlanTargetMetadata(plan, serverPackageRoot) {
  try {
    const source = plan.kind === "claude"
      ? resolveClaudeSdkCliSources(serverPackageRoot, plan.platform, plan.arch)
      : resolveCopilotSdkSources(serverPackageRoot, plan.platform, plan.arch);
    const packageDir = plan.kind === "claude" ? NodePath.dirname(source.binSrc) : source.platformPackageDir;
    const metadata = JSON.parse(NodeFS.readFileSync(NodePath.resolve(packageDir, "package.json"), "utf8"));
    return packageMetadataUsable(metadata, plan) && NodeFS.existsSync(NodePath.resolve(packageDir, plan.executable)) && NodeFS.statSync(NodePath.resolve(packageDir, plan.executable)).isFile();
  } catch {
    return false;
  }
}

/** Checks whether a path exists without following a missing path error. */
export function pathExists(target) {
  try {
    NodeFS.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

/** Rejects a destination outside the resolved install root. */
export function assertContained(storeRoot, target) {
  const root = NodePath.resolve(storeRoot);
  const candidate = NodePath.resolve(target);
  const separator = root.includes("\\") ? "\\" : "/";
  if (candidate === root || !candidate.startsWith(`${root}${separator}`)) {
    throw new Error(`[ensure-sdk] Destination escapes install root: ${target}`);
  }
}
