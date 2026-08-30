import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  claudeSdkPlatformPackageCandidates,
  copilotSdkPlatformPackageName,
  electronArchToNpm,
  electronPlatformToNpm,
} from "../../../../../scripts/build-server-dev-bundle.mjs";
import {
  readLockPackageRecord,
  resolveInstallPackageDestination,
  resolveInstallRoot,
} from "../target-package/package-registry.mjs";

/** The exact desktop target matrix used by every packaging channel. */
export const SUPPORTED_DESKTOP_TARGETS = Object.freeze([
  Object.freeze({ id: "windows-x64", platform: "windows", arch: "x64" }),
  Object.freeze({ id: "linux-x64", platform: "linux", arch: "x64" }),
  Object.freeze({ id: "macos-arm64", platform: "macos", arch: "arm64" }),
  Object.freeze({ id: "macos-x64", platform: "macos", arch: "x64" }),
]);

const DESKTOP_WORKFLOW_MATRIX_NAMES = ["nightly", "stable", "pull-request"];

function parseWorkflowTargetMatrix(source, workflowName) {
  const lines = requireWorkflowSource(source, workflowName).split(/\r?\n/);
  const includeIndex = findMatrixIncludeIndex(lines, workflowName);
  return validateWorkflowTargets(
    collectWorkflowMatrixEntries(lines.slice(includeIndex + 1), workflowName),
    workflowName,
  );
}

function requireWorkflowSource(source, workflowName) {
  if (typeof source !== "string") {
    throw new TypeError(`Workflow source is required for ${workflowName}`);
  }
  return source;
}

function findMatrixIncludeIndex(lines, workflowName) {
  const matrixIndex = lines.findIndex((line) => /^ {6}matrix:\s*$/.test(line));
  const includeIndex = lines.findIndex(
    (line, index) =>
      index > matrixIndex && /^ {8}include:\s*$/.test(line),
  );
  if (matrixIndex < 0 || includeIndex < 0) {
    throw new Error(`Desktop target matrix is missing from ${workflowName}`);
  }
  return includeIndex;
}

function collectWorkflowMatrixEntries(lines, workflowName) {
  const entries = [];
  let entry;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const indent = line.match(/^\s*/)[0].length;
    if (indent <= 8) break;
    if (/^ {10}-\s*/.test(line)) {
      if (entry) entries.push(entry);
      entry = {};
      continue;
    }
    const field = line.match(/^ {12}(target-id|platform|arch):\s*([^\s#]+)\s*$/);
    if (field && entry) entry[field[1]] = field[2];
  }
  if (entry) entries.push(entry);
  if (entries.length === 0) {
    throw new Error(`Desktop target matrix is empty in ${workflowName}`);
  }
  return entries;
}

function validateWorkflowTargets(entries, workflowName) {
  const seen = new Set();
  return entries.map((candidate) => {
    const target = createWorkflowTarget(candidate, workflowName);
    assertUniqueWorkflowTarget(target, seen, workflowName);
    return target;
  });
}

function createWorkflowTarget(candidate, workflowName) {
  if (!candidate.platform || !candidate.arch) {
    throw new Error(`Desktop target matrix entry is incomplete in ${workflowName}`);
  }
  const target = {
    id: `${candidate.platform}-${candidate.arch}`,
    platform: candidate.platform,
    arch: candidate.arch,
  };
  if (candidate["target-id"] && candidate["target-id"] !== target.id) {
    throw new Error(
      `Desktop target matrix id does not match platform and arch in ${workflowName}`,
    );
  }
  return target;
}

function assertUniqueWorkflowTarget(target, seen, workflowName) {
  if (seen.has(target.id)) {
    throw new Error(`Duplicate desktop target in ${workflowName}: ${target.id}`);
  }
  seen.add(target.id);
}

/** Parses one packaging workflow matrix into platform and architecture targets. */
export function parseDesktopWorkflowTargetMatrix(
  source,
  workflowName = "workflow",
) {
  return parseWorkflowTargetMatrix(source, workflowName);
}

/** Validates the Nightly, Stable, and pull-request matrices against the canonical target set. */
export function assertDesktopWorkflowMatrices(workflows) {
  const expectedById = new Map(
    SUPPORTED_DESKTOP_TARGETS.map((target) => [target.id, target]),
  );
  const matrices = {};
  for (const workflowName of DESKTOP_WORKFLOW_MATRIX_NAMES) {
    const targets = parseWorkflowTargetMatrix(workflows?.[workflowName], workflowName);
    if (targets.length !== SUPPORTED_DESKTOP_TARGETS.length) {
      throw new Error(
        `Desktop target matrix does not match supported targets in ${workflowName}`,
      );
    }
    for (const target of targets) {
      const expected = expectedById.get(target.id);
      if (
        !expected ||
        expected.platform !== target.platform ||
        expected.arch !== target.arch
      ) {
        throw new Error(
          `Unsupported desktop target in ${workflowName}: ${target.id}`,
        );
      }
    }
    matrices[workflowName] = targets;
  }
  return matrices;
}

/** Resolves a supported desktop target or fails closed for an unknown pair. */
export function resolveDesktopTarget(platform, arch) {
  const target = SUPPORTED_DESKTOP_TARGETS.find(
    (candidate) => candidate.platform === platform && candidate.arch === arch,
  );
  if (!target) {
    throw new Error(`Unsupported desktop package target: ${platform}-${arch}`);
  }
  return target;
}

/** Resolves the target platform and architecture from the local packaging host. */
export function resolveHostDesktopTarget({
  platform = electronPlatformToNpm(process.platform),
  arch = process.env.MCODE_TARGET_ARCH?.trim()
    ? electronArchToNpm(process.env.MCODE_TARGET_ARCH.trim())
    : electronArchToNpm(process.arch),
} = {}) {
  return resolveDesktopTarget(
    { win32: "windows", darwin: "macos", linux: "linux" }[platform] ?? platform,
    arch,
  );
}

function readPackageVersion(packageDir) {
  return JSON.parse(readFileSync(resolve(packageDir, "package.json"), "utf8"))
    .version;
}

function packageLockPath(serverPackageRoot) {
  return resolve(serverPackageRoot, "..", "..", "bun.lock");
}

function planLockData(plan, serverPackageRoot) {
  return {
    ...plan,
    ...readLockPackageRecord(
      packageLockPath(serverPackageRoot),
      plan.packageName,
      plan.version,
    ),
  };
}

/** Resolves the Claude SDK package plan required by a supported target. */
export function resolveClaudeTargetPackagePlan(serverPackageRoot, platform, arch) {
  const targetPlatform = resolveDesktopTarget(
    { win32: "windows", darwin: "macos", linux: "linux" }[platform] ?? platform,
    arch,
  );
  const npmPlatform = { windows: "win32", macos: "darwin", linux: "linux" }[
    targetPlatform.platform
  ];
  const serverRequire = createRequire(resolve(serverPackageRoot, "package.json"));
  const sdkEntry = serverRequire.resolve("@anthropic-ai/claude-agent-sdk");
  const packageName = claudeSdkPlatformPackageCandidates(npmPlatform, arch)[0];
  const packageDir = dirname(sdkEntry);
  return planLockData(
    {
      kind: "claude",
      platform: npmPlatform,
      arch,
      packageName,
      version: readPackageVersion(packageDir),
      destination: resolveInstallPackageDestination(sdkEntry, packageName),
      installRoot: resolveInstallRoot(sdkEntry),
      executable: npmPlatform === "win32" ? "claude.exe" : "claude",
      chmodExecutable: npmPlatform !== "win32",
    },
    serverPackageRoot,
  );
}

/** Resolves the Copilot SDK package plan required by a supported target. */
export function resolveCopilotTargetPackagePlan(serverPackageRoot, platform, arch) {
  const targetPlatform = resolveDesktopTarget(
    { win32: "windows", darwin: "macos", linux: "linux" }[platform] ?? platform,
    arch,
  );
  const npmPlatform = { windows: "win32", macos: "darwin", linux: "linux" }[
    targetPlatform.platform
  ];
  const serverRequire = createRequire(resolve(serverPackageRoot, "package.json"));
  const sdkEntry = serverRequire.resolve("@github/copilot-sdk");
  const copilotPackageDir = resolve(dirname(sdkEntry), "..", "..", "..", "copilot");
  const packageName = copilotSdkPlatformPackageName(npmPlatform, arch);
  return planLockData(
    {
      kind: "copilot",
      platform: npmPlatform,
      arch,
      packageName,
      version: readPackageVersion(copilotPackageDir),
      destination: resolveInstallPackageDestination(sdkEntry, packageName),
      installRoot: resolveInstallRoot(sdkEntry),
      executable: npmPlatform === "win32" ? "copilot.exe" : "copilot",
      chmodExecutable: npmPlatform !== "win32",
    },
    serverPackageRoot,
  );
}

/** Resolves both SDK target package plans for one supported desktop target. */
export function resolveDesktopTargetPackagePlans(serverPackageRoot, platform, arch) {
  const target = resolveDesktopTarget(platform, arch);
  const npmPlatform = { windows: "win32", macos: "darwin", linux: "linux" }[
    target.platform
  ];
  return {
    target,
    claude: resolveClaudeTargetPackagePlan(serverPackageRoot, npmPlatform, target.arch),
    copilot: resolveCopilotTargetPackagePlan(serverPackageRoot, npmPlatform, target.arch),
  };
}

export { copilotSdkPlatformPackageName };
