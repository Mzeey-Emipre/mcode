/**
 * Ensure the Claude Agent SDK platform package for the packaging target is installed.
 *
 * bun only installs optional platform packages for the build host. Cross-arch desktop
 * builds (e.g. macOS x64 on an arm64 runner) need the target package present before
 * afterPack copies the CLI into the installer.
 *
 * Usage:
 *   node apps/desktop/scripts/ensure-claude-sdk-platform-package.mjs
 *
 * Environment:
 *   MCODE_TARGET_ARCH - electron-builder target arch (e.g. x64, arm64). Defaults to process.arch.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

console.log(`[ensure-claude-sdk] Installing ${platformPkg}@${sdkVersion} for ${npmPlatform}-${targetArch}...`);
execFileSync("bun", ["add", `${platformPkg}@${sdkVersion}`], {
  cwd: repoRoot,
  stdio: "inherit",
});

resolveClaudeSdkCliSources(serverRoot, npmPlatform, targetArch);
console.log(`[ensure-claude-sdk] Installed ${platformPkg}`);
