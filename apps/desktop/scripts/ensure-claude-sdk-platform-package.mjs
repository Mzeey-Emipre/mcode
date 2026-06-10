/**
 * Ensure the Claude Agent SDK platform package for the packaging target is installed.
 *
 * bun only installs platform packages whose `os`/`cpu` fields match the build host,
 * and `bun add` silently skips linking a mismatched package even though it updates
 * the lockfile. Cross-arch desktop builds (e.g. macOS x64 on an arm64 runner) need
 * the target package present before afterPack copies the CLI into the installer, so
 * this script downloads the tarball from the npm registry directly and extracts it
 * next to the SDK inside bun's isolated store, where require resolution from the
 * SDK entry point finds it. It never touches package.json or bun.lock.
 *
 * Usage:
 *   node apps/desktop/scripts/ensure-claude-sdk-platform-package.mjs
 *
 * Environment:
 *   MCODE_TARGET_ARCH - electron-builder target arch (e.g. x64, arm64). Defaults to process.arch.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import {
  claudeSdkPlatformPackageCandidates,
  electronArchToNpm,
  electronPlatformToNpm,
  repoRootFromScript,
  resolveClaudeSdkCliSources,
} from "../../../scripts/build-server-dev-bundle.mjs";

const repoRoot = repoRootFromScript();
const serverRoot = resolve(repoRoot, "apps/server");

const rawTargetArch = process.env.MCODE_TARGET_ARCH?.trim();
const targetArch = rawTargetArch
  ? electronArchToNpm(rawTargetArch)
  : process.arch;
const npmPlatform = electronPlatformToNpm(process.platform);

try {
  resolveClaudeSdkCliSources(serverRoot, npmPlatform, targetArch);
  console.log(
    `[ensure-claude-sdk] Target platform package already installed (${npmPlatform}-${targetArch})`,
  );
  process.exit(0);
} catch {
  // fall through to install
}

const serverRequire = createRequire(resolve(serverRoot, "package.json"));
const sdkEntry = serverRequire.resolve("@anthropic-ai/claude-agent-sdk");
const sdkVersion = JSON.parse(
  readFileSync(resolve(dirname(sdkEntry), "package.json"), "utf8"),
).version;
const platformPkg = claudeSdkPlatformPackageCandidates(npmPlatform, targetArch)[0];

console.log(
  `[ensure-claude-sdk] Downloading ${platformPkg}@${sdkVersion} for ${npmPlatform}-${targetArch}...`,
);

const registry = (
  process.env.npm_config_registry ?? "https://registry.npmjs.org"
).replace(/\/+$/, "");
const metaRes = await fetch(`${registry}/${platformPkg}/${sdkVersion}`);
if (!metaRes.ok) {
  throw new Error(
    `[ensure-claude-sdk] Registry lookup failed for ${platformPkg}@${sdkVersion}: HTTP ${metaRes.status}`,
  );
}
const tarballUrl = (await metaRes.json()).dist?.tarball;
if (!tarballUrl) {
  throw new Error(
    `[ensure-claude-sdk] Registry metadata for ${platformPkg}@${sdkVersion} has no dist.tarball`,
  );
}

const tarRes = await fetch(tarballUrl);
if (!tarRes.ok) {
  throw new Error(
    `[ensure-claude-sdk] Tarball download failed (${tarballUrl}): HTTP ${tarRes.status}`,
  );
}
// dirname(sdkEntry) is the real SDK package dir inside bun's store
// (node_modules/.bun/<sdk>@<ver>/node_modules/@anthropic-ai/claude-agent-sdk),
// so "../<pkg basename>" lands in the scope dir of the nearest node_modules
// that require() walks from the SDK entry.
const destDir = resolve(dirname(sdkEntry), "..", platformPkg.split("/").pop());
rmSync(destDir, { recursive: true, force: true });
mkdirSync(destDir, { recursive: true });

// Extract with cwd-relative paths: GNU tar on Windows misreads "C:\..." as a
// remote host spec.
const tarballName = "package.tgz";
writeFileSync(join(destDir, tarballName), Buffer.from(await tarRes.arrayBuffer()));
execFileSync("tar", ["-xzf", tarballName, "--strip-components=1"], {
  cwd: destDir,
  stdio: "inherit",
});
rmSync(join(destDir, tarballName), { force: true });

if (npmPlatform !== "win32") {
  chmodSync(join(destDir, "claude"), 0o755);
}

resolveClaudeSdkCliSources(serverRoot, npmPlatform, targetArch);
console.log(`[ensure-claude-sdk] Installed ${platformPkg} at ${destDir}`);
