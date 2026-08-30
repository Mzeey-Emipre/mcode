import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

/** Creates an isolated Playwright installation under the worktree runtime directory. */
export function ensurePlaywright(repoRoot = process.cwd()) {
  const root = resolve(repoRoot);
  const scratchDir = join(root, ".dev", "playwright-scratch");
  const packageFile = join(scratchDir, "package.json");
  const nodeModulesDir = join(scratchDir, "node_modules");
  mkdirSync(scratchDir, { recursive: true });
  ensureScratchPackage(packageFile);
  const scratchRequire = createRequire(packageFile);
  if (isPlaywrightInstalled(scratchRequire, nodeModulesDir)) return nodeModulesDir;
  installPlaywright(scratchDir);
  if (waitForPlaywright(scratchRequire, nodeModulesDir)) return nodeModulesDir;
  throw new Error("Playwright was not installed inside the scratch package");
}

function ensureScratchPackage(packageFile) {
  if (existsSync(packageFile)) {
    const manifest = JSON.parse(readFileSync(packageFile, "utf8"));
    if (manifest.private !== true) {
      throw new Error("Refusing to modify a scratch package that is not private");
    }
    return;
  }
  writeFileSync(
    packageFile,
    `${JSON.stringify({ name: "mcode-electron-live-testing", private: true }, null, 2)}\n`,
    "utf8",
  );
}

function isPlaywrightInstalled(scratchRequire, nodeModulesDir) {
  try {
    return isInside(nodeModulesDir, scratchRequire.resolve("playwright"));
  } catch {
    // A missing local dependency is the expected installation trigger.
    return false;
  }
}

function installPlaywright(scratchDir) {
  const installer = process.versions.bun ? process.execPath : "bun";
  const install = spawnSync(installer, ["add", "playwright"], {
    cwd: scratchDir,
    stdio: "inherit",
  });
  if (install.error) {
    throw new Error(`Playwright installation could not start: ${install.error.message}`);
  }
  if (install.status !== 0) {
    throw new Error(
      `Playwright installation failed with exit code ${install.status ?? "none"} and signal ${install.signal ?? "none"}`,
    );
  }
}

function waitForPlaywright(scratchRequire, nodeModulesDir) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (isPlaywrightInstalled(scratchRequire, nodeModulesDir)) return true;
    // Bun can finish the child process before Windows exposes the installed files.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  return false;
}

function isInside(parent, candidate) {
  const relativePath = relative(parent, candidate);
  return relativePath.length > 0 && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

if (import.meta.main) {
  console.log(ensurePlaywright());
}
